import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { QuotaAdapter, UsageSnapshot } from './index.js';
import { TuiScraper, sleep } from '../tmux.js';
import { debug } from '../debug.js';

import { AccountConfig } from '../config.js';

const CACHE_PATH = path.join(os.homedir(), '.gemini/antigravity-cli/.agent-fuel-quota-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_CACHE_MAX_MS = 30 * 60 * 1000;

interface ModelQuotaEntry {
  group?: string;
  model: string;
  percent: number;
  refreshLine: string | null;
}

interface QuotaCache {
  fetchedAt: number;
  entries: ModelQuotaEntry[];
}

export function isArgonEntry(e: ModelQuotaEntry): boolean {
  const g = e.group || '';
  const m = e.model || '';
  return /argon/i.test(g) || /argon/i.test(m);
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

// ── Scraping ───────────────────────────────────────────────────────────────

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
      await tui.waitFor(/for shortcuts/, 15_000);
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
      const hasArgon = /argon/i.test(lastScreen);
      if (complete && hasArgon) {
        const argon = entries.filter(e => isArgonEntry(e));
        if (argon.length > 0) return lastScreen;
      } else if (complete && !hasArgon) {
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
  const lines = raw.split(/\r?\n/);
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

async function readCache(accountKey = 'default'): Promise<QuotaCache | null> {
  const cacheFile = CACHE_PATH.replace('.json', `-${accountKey}.json`);
  try {
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as QuotaCache;
    if (!Number.isFinite(cache.fetchedAt) || !Array.isArray(cache.entries) ||
        !hasGroups(cache.entries) || Date.now() - cache.fetchedAt > STALE_CACHE_MAX_MS) return null;
    return cache;
  } catch { return null; }
}

async function writeCache(entries: ModelQuotaEntry[], accountKey = 'default'): Promise<void> {
  const cacheFile = CACHE_PATH.replace('.json', `-${accountKey}.json`);
  try {
    await fs.writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), entries }), 'utf-8');
  } catch { /* non-fatal */ }
}

// ── Bucket aggregation ────────────────────────────────────────────────────

export function buildSnapshots(
  entries: ModelQuotaEntry[],
  fromCache: boolean,
  account?: AccountConfig,
): UsageSnapshot[] {
  const source = fromCache ? 'cache' : 'official-cli';
  const baseId = account?.id || 'agy';
  const baseName = account?.displayName || 'AGY';
  const prefix = baseName.replace(/\s+(Gemini|Argon|Other)$/i, '');
  const indent = ' '.repeat(prefix.length);

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

  // Dynamic future blocks: check for any groups that don't match core Gemini, Other, or Argon
  const customGroups = new Map<string, ModelQuotaEntry[]>();
  for (const entry of entries) {
    if (!isCoreGeminiEntry(entry) && !isOtherEntry(entry) && !isArgonEntry(entry)) {
      const gName = entry.group || 'Extra';
      const list = customGroups.get(gName) || [];
      list.push(entry);
      customGroups.set(gName, list);
    }
  }

  const hasExtra = customGroups.size > 0;
  const geminiName = `${prefix} ╭ Flash & Pro`;
  const argonName  = `${indent} │ Argon`;
  const otherName  = hasExtra ? `${indent} │ Other` : `${indent} ╰ Other`;

  const snapshots: UsageSnapshot[] = [
    worstCase(geminiEntries, geminiToolId, geminiName, 'GEMINI MODELS'),
    worstCase(argonEntries,  argonToolId, argonName,  'GEMINI 4 ARGON'),
    worstCase(otherEntries,  otherToolId, otherName,  'CLAUDE AND GPT MODELS'),
  ];

  let extraIdx = 0;
  const totalExtra = customGroups.size;
  for (const [groupName, groupEntries] of customGroups) {
    extraIdx++;
    const isLast = extraIdx === totalExtra;
    const connector = isLast ? '╰' : '│';
    const slug = groupName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const toolId = `${baseId}-${slug}`;
    const cleanTitle = groupName.replace(/\b\w/g, c => c.toUpperCase());
    const displayName = `${indent} ${connector} ${cleanTitle}`;
    snapshots.push(worstCase(groupEntries, toolId, displayName, groupName));
  }

  return snapshots;
}

// ── Adapter ───────────────────────────────────────────────────────────────

export class AgyQuotaAdapter implements QuotaAdapter {
  constructor(private readonly account?: AccountConfig) {}

  public async fetchSnapshots(): Promise<UsageSnapshot[]> {
    const accountKey = this.account?.id || 'default';
    const cmd = this.account?.command || 'agy';
    const env = this.account?.env;

    // Fast path: serve from cache if fresh enough
    const cached = await readCache(accountKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return buildSnapshots(cached.entries, true, this.account);
    }

    // Slow path: spawn agy via tmux, scrape the quota panel
    try {
      const raw = await runAgyUsage(cmd, env);
      const entries = parseQuotaPanel(raw);

      if (hasGroups(entries)) {
        await writeCache(entries, accountKey);
        return buildSnapshots(entries, false, this.account);
      }

      if (cached) return buildSnapshots(cached.entries, true, this.account);

      const baseId = this.account?.id || 'agy';
      const baseName = this.account?.displayName || 'AGY';
      const prefix = baseName.replace(/\s+(Gemini|Flash & Pro|Argon|Other)$/i, '');
      const indent = ' '.repeat(prefix.length);
      return [
        { tool: `${baseId}-gemini`, displayName: `${prefix} ╭ Flash & Pro`, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' },
        { tool: `${baseId}-argon`,  displayName: `${indent} │ Argon`,  remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' },
        { tool: `${baseId}-other`,  displayName: `${indent} ╰ Other`,  remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' },
      ];

    } catch (error) {
      if (cached) return buildSnapshots(cached.entries, true, this.account);
      debug('agy:fetch', 'quota scrape failed', String(error));
      const msg = error instanceof Error ? error.message : String(error);
      const baseId = this.account?.id || 'agy';
      const baseName = this.account?.displayName || 'AGY';
      const prefix = baseName.replace(/\s+(Gemini|Flash & Pro|Argon|Other)$/i, '');
      const indent = ' '.repeat(prefix.length);
      return [
        { tool: `${baseId}-gemini`, displayName: `${prefix} ╭ Flash & Pro`, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown', raw: msg },
        { tool: `${baseId}-argon`,  displayName: `${indent} │ Argon`,  remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown', raw: msg },
        { tool: `${baseId}-other`,  displayName: `${indent} ╰ Other`,  remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown', raw: msg },
      ];
    }
  }
}
