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
  model: string;
  percent: number;
  refreshLine: string | null;
}

interface QuotaCache {
  fetchedAt: number;
  entries: ModelQuotaEntry[];
}

function hasBothGroups(entries: ModelQuotaEntry[]): boolean {
  return entries.some(e => /gemini/i.test(e.model)) &&
    entries.some(e => !/gemini/i.test(e.model));
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

    // The heading appears before the quota rows. Wait until both groups and
    // their five-hour and weekly limits have actually rendered.
    const deadline = Date.now() + 10_000;
    let lastScreen = '';
    while (Date.now() < deadline) {
      lastScreen = tui.capture();
      const entries = parseQuotaPanel(lastScreen);
      const gemini = entries.filter(e => /gemini/i.test(e.model));
      const other = entries.filter(e => !/gemini/i.test(e.model));
      const complete = [gemini, other].every(group =>
        group.some(e => /weekly/i.test(e.model)) &&
        group.some(e => /five\s*hour|5\s*h/i.test(e.model)));
      if (complete) return lastScreen;
      await sleep(300);
    }
    debug('agy:scrape', 'quota panel incomplete after 10 seconds', parseQuotaPanel(lastScreen));
    return lastScreen;

  } finally {
    tui.kill();
  }
}

// ── Parsing ────────────────────────────────────────────────────────────────

function parseQuotaPanel(raw: string): ModelQuotaEntry[] {
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

    // Check if we hit a group header in the new layout
    const nextLine = panelLines[i + 1]?.trim() || '';
    if (nextLine.startsWith('Models within this group:')) {
      currentGroup = line;
      i += 2; // Skip the group header and the "Models within this group" lines
      continue;
    }

    const isModelName =
      line.length > 0 &&
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
          results.push({ model: name, percent, refreshLine });
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
        !hasBothGroups(cache.entries) || Date.now() - cache.fetchedAt > STALE_CACHE_MAX_MS) return null;
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

function buildSnapshots(
  entries: ModelQuotaEntry[],
  fromCache: boolean,
  account?: AccountConfig,
): UsageSnapshot[] {
  const source = fromCache ? 'cache' : 'official-cli';
  const baseId = account?.id || 'agy';
  const baseName = account?.displayName || 'AGY';

  const geminiToolId = `${baseId}-gemini`;
  const otherToolId = `${baseId}-other`;

  const geminiName = baseName.includes('Gemini') ? baseName : `${baseName} Gemini`;
  const otherName = baseName.includes('Other') ? baseName : `${baseName} Other`;

  const geminiEntries = entries.filter(e => /gemini/i.test(e.model));
  const otherEntries  = entries.filter(e => !/gemini/i.test(e.model));

  function worstCase(bucket: ModelQuotaEntry[], tool: string, displayName: string): UsageSnapshot {
    if (bucket.length === 0) {
      return { tool, displayName, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' };
    }

    const weeklyLimit = bucket.find(e => /weekly/i.test(e.model));
    const fiveHour = bucket.find(e => /five\s*hour|5\s*h/i.test(e.model));

    const limits: { pct: number; reset: string | null; type: 'session' | 'weekly'; model: string }[] = [];
    if (fiveHour) {
      limits.push({ pct: fiveHour.percent, reset: fiveHour.refreshLine ?? null, type: 'session', model: fiveHour.model });
    }
    if (weeklyLimit) {
      limits.push({ pct: weeklyLimit.percent, reset: weeklyLimit.refreshLine ?? null, type: 'weekly', model: weeklyLimit.model });
    }

    if (limits.length === 0) {
      const target = bucket.reduce((a, b) => a.percent <= b.percent ? a : b);
      limits.push({ pct: target.percent, reset: target.refreshLine ?? null, type: 'session', model: target.model });
    }

    limits.sort((a, b) => a.pct - b.pct);
    const limiting = limits[0];

    const remainingPercent = limiting.pct;
    const resetAt = limiting.reset;
    const weeklyLimitReached = weeklyLimit ? weeklyLimit.percent === 0 : false;

    return {
      tool,
      displayName,
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetAt,
      limitType: limiting.type,
      breakdown: (fiveHour && weeklyLimit) ? {
        fiveHour: fiveHour.percent,
        weekly: weeklyLimit.percent,
      } : undefined,
      weeklyLimitReached,
      source,
      raw: { matchedModel: limiting.model, allModels: bucket.map(e => `${e.model}: ${e.percent}%`) },
    };
  }

  return [
    worstCase(geminiEntries, geminiToolId, geminiName),
    worstCase(otherEntries,  otherToolId, otherName),
  ];
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

      if (hasBothGroups(entries)) {
        await writeCache(entries, accountKey);
        return buildSnapshots(entries, false, this.account);
      }

      if (cached) return buildSnapshots(cached.entries, true, this.account);

      const baseId = this.account?.id || 'agy';
      const baseName = this.account?.displayName || 'AGY';
      return [
        { tool: `${baseId}-gemini`, displayName: `${baseName} Gemini`, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' },
        { tool: `${baseId}-other`,  displayName: `${baseName} Other`, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' },
      ];

    } catch (error) {
      if (cached) return buildSnapshots(cached.entries, true, this.account);
      debug('agy:fetch', 'quota scrape failed', String(error));
      const msg = error instanceof Error ? error.message : String(error);
      const baseId = this.account?.id || 'agy';
      const baseName = this.account?.displayName || 'AGY';
      return [
        { tool: `${baseId}-gemini`, displayName: `${baseName} Gemini`, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown', raw: msg },
        { tool: `${baseId}-other`,  displayName: `${baseName} Other`, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown', raw: msg },
      ];
    }
  }
}
