import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { QuotaAdapter, UsageSnapshot } from './index.js';
import {
  TuiScraper,
  assertSafeCommand,
  buildInteractiveShellCommand,
  expandTilde,
  resolveEnv,
  sanitizeTerminalText,
  sleep,
  stripAnsi,
} from '../tmux.js';
import { debug } from '../debug.js';
import { AccountConfig, CONFIG_DIR, ensurePrivateDir, getSafeWorkingDir } from '../config.js';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_CACHE_MAX_MS = 30 * 60 * 1000;
const AGY_JSON_TIMEOUT_MS = 12_000;

export function agyCachePath(account?: AccountConfig): string {
  const identity = JSON.stringify([account?.id ?? 'default', account?.command ?? 'agy', account?.env ?? {}]);
  const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return path.join(CONFIG_DIR, `agy-quota-${key}.json`);
}

export interface ModelQuotaEntry {
  group?: string;
  model: string;
  percent: number;
  refreshLine: string | null;
}

interface QuotaCache {
  fetchedAt: number;
  entries: ModelQuotaEntry[];
}

interface AgyJsonBucket {
  id?: string;
  name?: string;
  description?: string;
  window?: string;
  remaining_fraction?: number;
  reset_time?: string;
  disabled?: boolean;
}

interface AgyJsonGroup {
  name?: string;
  description?: string;
  buckets?: AgyJsonBucket[];
}

interface AgyUsageJsonPayload {
  status?: string;
  command?: {
    name?: string;
    data?: {
      groups?: AgyJsonGroup[];
    };
  };
}

export function isArgonEntry(e: ModelQuotaEntry): boolean {
  const g = e.group || '';
  if (g) return /argon/i.test(g);
  return /argon/i.test(e.model || '');
}

export function isOtherEntry(e: ModelQuotaEntry): boolean {
  if (isArgonEntry(e)) return false;
  const g = e.group || '';
  const m = e.model || '';
  if (g) {
    return /claude|gpt|other/i.test(g);
  }
  return /claude|opus|sonnet|gpt/i.test(m) || !/gemini/i.test(m);
}

export function isCoreGeminiEntry(e: ModelQuotaEntry): boolean {
  if (isArgonEntry(e)) return false;
  if (isOtherEntry(e)) return false;
  const g = e.group || '';
  if (g && !/^gemini(\s+models)?$/i.test(g)) return false;
  return true;
}

function hasGroups(entries: ModelQuotaEntry[]): boolean {
  return entries.some(e => isCoreGeminiEntry(e)) &&
    entries.some(e => isOtherEntry(e));
}

function isGroupHeader(line: string, nextLine: string): boolean {
  if (
    line.startsWith('Account:') ||
    line.startsWith('│') ||
    line.startsWith('─') ||
    line.startsWith('┌') ||
    line.startsWith('└') ||
    line.startsWith('┘') ||
    line.startsWith('?') ||
    line.startsWith('esc') ||
    line.startsWith('[')
  ) {
    return false;
  }
  if (nextLine.startsWith('Models within this group:')) {
    return true;
  }
  if (/^[A-Z0-9\s/&+-]{3,}$/.test(line) && /[A-Z]/.test(line)) {
    if (/^(DISABLED|WARNING|ERROR|NOTE|REMAINING)$/i.test(line)) return false;
    if (/REFRESH|LIMIT REMAINING|QUOTA AVAILABLE/i.test(line)) return false;
    return true;
  }
  return false;
}

// ── JSON CLI extraction (primary engine for AGY 1.1.11+) ───────────────────

export function formatAgyResetTime(resetTime: string | undefined, percent: number, nowMs = Date.now()): string | null {
  if (!resetTime) {
    return percent >= 100 ? 'Quota available' : null;
  }
  const resetMs = Date.parse(resetTime);
  if (!Number.isFinite(resetMs) || new Date(resetMs).getUTCFullYear() <= 1971) {
    return percent >= 100 ? 'Quota available' : null;
  }
  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) {
    return percent >= 100 ? 'Quota available' : 'Refreshes soon';
  }
  const totalMinutes = Math.max(1, Math.round(diffMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `Refreshes in ${hours}h ${minutes}m` : `Refreshes in ${minutes}m`;
}

/** Parses `agy -p "/usage" --output-format json` stdout into normalized ModelQuotaEntry items. */
export function parseAgyJsonOutput(rawStdout: string, nowMs = Date.now()): ModelQuotaEntry[] {
  const start = rawStdout.indexOf('{');
  const end = rawStdout.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  const payload = JSON.parse(rawStdout.slice(start, end + 1)) as AgyUsageJsonPayload;
  const groups = payload?.command?.data?.groups;
  if (!Array.isArray(groups)) return [];

  const entries: ModelQuotaEntry[] = [];
  for (const group of groups) {
    const groupName = group.name ? sanitizeTerminalText(group.name).trim() : '';
    if (!groupName || !Array.isArray(group.buckets)) continue;

    for (const bucket of group.buckets) {
      const cleanBucketName = bucket.name ? sanitizeTerminalText(bucket.name).trim() : '';
      const bucketLabel =
        cleanBucketName ||
        (bucket.window === 'weekly' ? 'Weekly Limit Remaining' :
         bucket.window === '5h' ? 'Five Hour Limit Remaining' : 'Limit Remaining');

      const percent = bucket.disabled
        ? 0
        : typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction)
          ? Math.round(Math.max(0, Math.min(1, bucket.remaining_fraction)) * 100)
          : 0;

      const cleanDesc = bucket.description ? sanitizeTerminalText(bucket.description).trim() : '';
      const refreshLine = bucket.disabled
        ? (cleanDesc || 'Disabled')
        : formatAgyResetTime(bucket.reset_time, percent, nowMs);

      entries.push({
        group: groupName.toUpperCase(),
        model: `${groupName.toUpperCase()} - ${bucketLabel}`,
        percent,
        refreshLine,
      });
    }
  }
  return entries;
}

type AgyJsonFetchResult =
  | { kind: 'ok'; entries: ModelQuotaEntry[] }
  | { kind: 'no-quota'; reason: string }
  | { kind: 'unavailable'; reason: string };

async function fetchAgyUsageJson(cmd = 'agy', env?: Record<string, string>): Promise<AgyJsonFetchResult> {
  const safeCmd = assertSafeCommand(cmd);
  const mergedEnv = resolveEnv(env);
  const cwd = getSafeWorkingDir();
  const args = ['-p', '/usage', '--output-format', 'json'];

  const runDirect = async () => {
    const parts = safeCmd.split(/\s+/);
    const bin = expandTilde(parts[0]);
    const extraArgs = parts.slice(1);
    return execFileAsync(bin, [...extraArgs, ...args], {
      cwd,
      env: mergedEnv,
      timeout: AGY_JSON_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  };

  const runViaShell = async () => {
    const userShell = process.env.SHELL || '/bin/sh';
    const shellCmd = buildInteractiveShellCommand(safeCmd, env, args);
    return execFileAsync(userShell, ['-i', '-c', shellCmd], {
      cwd,
      env: mergedEnv,
      timeout: AGY_JSON_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  };

  try {
    let stdout = '';
    try {
      ({ stdout } = await runDirect());
    } catch (directErr) {
      const errObj = directErr as { code?: string; message?: string; stdout?: string; stderr?: string };
      // Retry via interactive shell only if the command wasn't directly found on PATH (e.g. shell alias)
      if (errObj.code === 'ENOENT') {
        ({ stdout } = await runViaShell());
      } else {
        throw directErr;
      }
    }

    const entries = parseAgyJsonOutput(stdout);
    if (entries.length > 0) {
      debug('agy:json', `parsed ${entries.length} quota buckets via -p /usage --output-format json`);
      return { kind: 'ok', entries };
    }
    return { kind: 'unavailable', reason: 'Empty quota groups in AGY JSON output' };
  } catch (err) {
    const errObj = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const combined = `${errObj.stdout ?? ''}\n${errObj.stderr ?? ''}\n${errObj.message ?? ''}`;
    if (/GEMINI_API_KEY|AI Studio|no account quota|not logged in|authenticate|sign in/i.test(combined)) {
      return { kind: 'no-quota', reason: /GEMINI_API_KEY|AI Studio|no account quota/i.test(combined) ? 'billing active' : 'not logged in' };
    }
    debug('agy:json', 'JSON CLI query failed, falling back to tmux TUI scrape', combined.trim().slice(0, 300));
    return { kind: 'unavailable', reason: errObj.message || String(err) };
  }
}

// ── TUI Scraping (fallback for older AGY versions) ─────────────────────────

/**
 * Launches `agy` in a tmux session, opens the `/usage` panel, waits for
 * the Model Quota list to render, then returns clean rendered screen text.
 */
async function runAgyUsage(cmd = 'agy', env?: Record<string, string>): Promise<string> {
  const tui = new TuiScraper(cmd, env);
  try {
    tui.start();

    // Wait for AGY main menu ready.
    const firstScreen = await tui.waitFor(/for shortcuts|Do you trust/i, 20_000);
    if (!/for shortcuts/i.test(firstScreen)) {
      debug('agy:scrape', 'trust prompt detected — confirming with Enter');
      await sleep(300); // ensure app is fully interactive before sending input
      tui.sendKey('Enter');
      await tui.waitFor(/for shortcuts/i, 15_000);
    }

    // Navigate to /usage panel
    tui.send('/usage');
    await tui.waitFor(/Models?\s*(?:&\s*)?Quota/i, 10_000);

    // The heading appears before the quota rows. Wait until the groups have rendered.
    const deadline = Date.now() + 10_000;
    let lastScreen = '';
    while (Date.now() < deadline) {
      lastScreen = tui.capture();
      const entries = parseQuotaPanel(lastScreen);
      const gemini = entries.filter(e => isCoreGeminiEntry(e));
      const other = entries.filter(e => isOtherEntry(e));

      // The footer note 'Within each group' is the very last element drawn in the panel
      if (lastScreen.includes('Within each group') && gemini.length > 0 && other.length > 0) {
        return lastScreen;
      }

      const complete = gemini.length > 0 && other.length > 0 &&
        gemini.some(e => /weekly/i.test(e.model)) &&
        other.some(e => /weekly/i.test(e.model));
      if (complete) {
        return lastScreen;
      }
      await sleep(200);
    }
    debug('agy:scrape', 'quota panel scrape completed or deadline reached', parseQuotaPanel(lastScreen));
    return lastScreen;

  } finally {
    tui.kill();
  }
}

// ── Parsing ────────────────────────────────────────────────────────────────

export function parseQuotaPanel(raw: string): ModelQuotaEntry[] {
  const lines = stripAnsi(raw).split(/\r?\n/);
  const results: ModelQuotaEntry[] = [];

  const headerIdx = lines.findIndex(l => /Models?\s*(?:&\s*)?Quota/i.test(l));
  if (headerIdx === -1) return results;

  let currentGroup: string | null = null;
  const panelLines = lines.slice(headerIdx + 1);
  let i = 0;

  while (i < panelLines.length) {
    const line = panelLines[i].trim();

    if (line.length === 0) {
      i++;
      continue;
    }

    const nextLine = panelLines[i + 1]?.trim() || '';

    // Check if we hit a group header
    if (isGroupHeader(line, nextLine)) {
      currentGroup = line;
      if (nextLine.startsWith('Models within this group:')) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    // Skip description and footer lines
    if (
      line.startsWith('Models within this group:') ||
      line.startsWith('For paid') ||
      line.startsWith('Within each group') ||
      line.startsWith('│')
    ) {
      i++;
      continue;
    }

    const isModelName =
      line.length > 0 &&
      !line.startsWith('Account:') &&
      !line.startsWith('░') && !line.startsWith('█') &&
      !line.startsWith('[') &&
      !line.startsWith('│') &&
      !line.startsWith('↑') && !line.startsWith('(') &&
      !line.startsWith('┘') && !line.startsWith('└') &&
      !line.startsWith('?') && !line.startsWith('esc') &&
      !/^\d+%/.test(line) &&
      !line.includes('Refreshes') && !line.includes('Quota available') &&
      !line.includes('──');

    if (isModelName) {
      let barLine: string | null = null;
      let refreshLine: string | null = null;
      let j = i + 1;

      while (j < panelLines.length) {
        const candidate = panelLines[j].trim();
        if (candidate.length === 0) { j++; continue; }

        if (barLine === null && candidate.startsWith('Disabled:')) {
          barLine = '0%';
          refreshLine = candidate;
          j++;
          break;
        }

        if (barLine === null && (candidate.includes('░') || candidate.includes('█') || /^\d+%/.test(candidate) || /\[.*\]/.test(candidate) || /[\d.]+%/.test(candidate))) {
          barLine = candidate;
          j++;
          continue;
        }

        if (barLine !== null && (candidate.includes('Refreshes') || candidate.includes('Quota available') || candidate.includes('remaining'))) {
          const m = candidate.match(/(Refreshes in [^\r\n]+|Quota available)/);
          refreshLine = m ? m[1] : candidate;
          j++;
        }

        break;
      }

      if (barLine !== null) {
        const percentMatch = barLine.match(/([\d.]+)%/);
        if (percentMatch) {
          const percent = Math.round(parseFloat(percentMatch[1]));
          const name = currentGroup ? `${currentGroup} - ${line}` : line;
          results.push({ group: currentGroup || undefined, model: name, percent, refreshLine });
        }
      }

      i = j;
    } else {
      i++;
    }
  }

  return results;
}

// ── Cache helpers ──────────────────────────────────────────────────────────

async function readCache(account?: AccountConfig): Promise<QuotaCache | null> {
  const cacheFile = agyCachePath(account);
  try {
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as QuotaCache;
    if (!Number.isFinite(cache.fetchedAt) || !Array.isArray(cache.entries) ||
        !hasGroups(cache.entries) || Date.now() - cache.fetchedAt > STALE_CACHE_MAX_MS) return null;
    return cache;
  } catch { return null; }
}

async function writeCache(entries: ModelQuotaEntry[], account?: AccountConfig): Promise<void> {
  const cacheFile = agyCachePath(account);
  try {
    if (!ensurePrivateDir(CONFIG_DIR)) return;
    await fs.writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), entries }), { encoding: 'utf-8', mode: 0o600 });
    await fs.chmod(cacheFile, 0o600);
  } catch { /* non-fatal */ }
}

// ── Bucket aggregation ────────────────────────────────────────────────────

export function agyBaseLabels(account?: AccountConfig): { baseId: string; prefix: string; indent: string } {
  const baseId = account?.id || 'agy';
  const baseName = account?.displayName || 'AGY';
  const prefix = baseName.replace(/\s+(Gemini|Flash & Pro|Argon|Other|Claude & GPT)$/i, '');
  const indent = ' '.repeat(prefix.length);
  return { baseId, prefix, indent };
}

export function buildSnapshots(
  entries: ModelQuotaEntry[],
  fromCache: boolean,
  account?: AccountConfig,
): UsageSnapshot[] {
  const source = fromCache ? 'cache' : 'official-cli';
  const { baseId, prefix, indent } = agyBaseLabels(account);

  const geminiToolId = `${baseId}-gemini`;
  const argonToolId = `${baseId}-argon`;
  const otherToolId = `${baseId}-other`;

  const geminiEntries = entries.filter(e => isCoreGeminiEntry(e));
  const argonEntries  = entries.filter(e => isArgonEntry(e));
  const otherEntries  = entries.filter(e => isOtherEntry(e));

  function worstCase(
    bucket: ModelQuotaEntry[],
    tool: string,
    displayName: string,
    fallbackGroupLabel?: string
  ): UsageSnapshot {
    if (bucket.length === 0) {
      return { tool, displayName, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' };
    }

    const weeklyLimit = bucket.find(e => /weekly/i.test(e.model));
    const fiveHour = bucket.find(e => /five\s*hour|5\s*h/i.test(e.model));

    const limits: { pct: number; reset: string | null; type: 'session' | 'weekly'; model: string; group?: string }[] = [];
    if (fiveHour) {
      limits.push({ pct: fiveHour.percent, reset: fiveHour.refreshLine ?? null, type: 'session', model: fiveHour.model, group: fiveHour.group });
    }
    if (weeklyLimit) {
      limits.push({ pct: weeklyLimit.percent, reset: weeklyLimit.refreshLine ?? null, type: 'weekly', model: weeklyLimit.model, group: weeklyLimit.group });
    }

    if (limits.length === 0) {
      const target = bucket.reduce((a, b) => a.percent <= b.percent ? a : b);
      limits.push({ pct: target.percent, reset: target.refreshLine ?? null, type: 'session', model: target.model, group: target.group });
    }

    limits.sort((a, b) => a.pct - b.pct);
    const limiting = limits[0];

    const remainingPercent = limiting.pct;
    let resetAt = limiting.reset;
    const weeklyLimitReached = weeklyLimit ? weeklyLimit.percent === 0 : false;
    if (weeklyLimitReached && weeklyLimit?.refreshLine && (!resetAt || resetAt.includes('Disabled'))) {
      resetAt = weeklyLimit.refreshLine;
    }
    const groupLabel = limiting.group || fallbackGroupLabel || limiting.model;

    return {
      tool,
      displayName,
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetAt,
      limitType: limiting.type,
      breakdown: (fiveHour || weeklyLimit) ? {
        fiveHour: fiveHour ? fiveHour.percent : null,
        weekly: weeklyLimit ? weeklyLimit.percent : null,
      } : undefined,
      weeklyLimitReached,
      source,
      raw: { matchedModel: groupLabel, allModels: bucket.map(e => `${e.model}: ${e.percent}%`) },
    };
  }

  // Dynamic extra groups: only emitted if AGY reports additional groups beyond Gemini and Other
  const customGroups = new Map<string, ModelQuotaEntry[]>();
  for (const entry of entries) {
    if (!isCoreGeminiEntry(entry) && !isOtherEntry(entry) && !isArgonEntry(entry)) {
      const gName = entry.group || 'Extra';
      const list = customGroups.get(gName) || [];
      list.push(entry);
      customGroups.set(gName, list);
    }
  }

  const hasArgon = argonEntries.length > 0;
  const hasExtra = customGroups.size > 0;
  const geminiName = `${prefix} ╭ Gemini`;
  const argonName  = `${indent} │ Argon`;
  const otherName  = hasExtra ? `${indent} │ Other` : `${indent} ╰ Other`;

  const snapshots: UsageSnapshot[] = [
    worstCase(geminiEntries, geminiToolId, geminiName, 'GEMINI MODELS'),
  ];
  if (hasArgon) {
    snapshots.push(worstCase(argonEntries, argonToolId, argonName, 'GEMINI 4 ARGON'));
  }
  snapshots.push(worstCase(otherEntries, otherToolId, otherName, 'CLAUDE AND GPT MODELS'));

  let extraIdx = 0;
  const totalExtra = customGroups.size;
  for (const [groupName, groupEntries] of customGroups) {
    extraIdx++;
    const isLast = extraIdx === totalExtra;
    const connector = isLast ? '╰' : '│';
    const slug = groupName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const toolId = `${baseId}-${slug}`;
    const cleanTitle = groupName.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    const displayName = `${indent} ${connector} ${cleanTitle}`;
    snapshots.push(worstCase(groupEntries, toolId, displayName, groupName));
  }

  return snapshots;
}

// ── Adapter ───────────────────────────────────────────────────────────────

export class AgyQuotaAdapter implements QuotaAdapter {
  constructor(private readonly account?: AccountConfig) {}

  public async fetchSnapshots(): Promise<UsageSnapshot[]> {
    const cmd = this.account?.command || 'agy';
    const env = this.account?.env;
    const { baseId, prefix, indent } = agyBaseLabels(this.account);

    const makeDefaultRows = (source: UsageSnapshot['source'], resetAt: string | null, remainingPercent: number | null, raw?: unknown): UsageSnapshot[] => [
      {
        tool: `${baseId}-gemini`,
        displayName: `${prefix} ╭ Gemini`,
        remainingPercent,
        usedPercent: remainingPercent !== null ? 100 - remainingPercent : null,
        resetAt,
        source,
        raw,
      },
      {
        tool: `${baseId}-other`,
        displayName: `${indent} ╰ Other`,
        remainingPercent,
        usedPercent: remainingPercent !== null ? 100 - remainingPercent : null,
        resetAt,
        source,
        raw,
      },
    ];

    // Fast path: serve from cache if fresh enough
    const cached = await readCache(this.account);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return buildSnapshots(cached.entries, true, this.account);
    }

    // Primary engine: non-interactive structured JSON output (AGY 1.1.11+)
    const jsonResult = await fetchAgyUsageJson(cmd, env);
    if (jsonResult.kind === 'ok' && hasGroups(jsonResult.entries)) {
      await writeCache(jsonResult.entries, this.account);
      return buildSnapshots(jsonResult.entries, false, this.account);
    }
    if (jsonResult.kind === 'no-quota') {
      if (jsonResult.reason === 'billing active') {
        return makeDefaultRows('official-cli', 'billing active', 100);
      }
      return makeDefaultRows('unknown', 'not logged in', null);
    }

    // Fallback engine: spawn agy via tmux, scrape the /usage quota panel
    try {
      const raw = await runAgyUsage(cmd, env);
      const entries = parseQuotaPanel(raw);

      if (hasGroups(entries)) {
        await writeCache(entries, this.account);
        return buildSnapshots(entries, false, this.account);
      }

      if (cached) return buildSnapshots(cached.entries, true, this.account);

      return makeDefaultRows('unknown', null, null);

    } catch (error) {
      if (cached) return buildSnapshots(cached.entries, true, this.account);
      debug('agy:fetch', 'quota scrape failed', String(error));
      const msg = error instanceof Error ? error.message : String(error);
      return makeDefaultRows('unknown', null, null, msg);
    }
  }
}
