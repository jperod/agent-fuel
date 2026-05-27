import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { QuotaAdapter, UsageSnapshot } from './index.js';
import { TuiScraper } from '../tmux.js';

const CACHE_PATH = path.join(os.homedir(), '.gemini/antigravity-cli/.agent-fuel-quota-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface ModelQuotaEntry {
  model: string;
  percent: number;
  refreshLine: string | null;
}

interface QuotaCache {
  fetchedAt: number;
  entries: ModelQuotaEntry[];
}

// ── Scraping ───────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

/**
 * Launches `agy` in a tmux session, opens the `/usage` panel, waits for
 * the Model Quota list to render, then returns clean rendered screen text.
 */
async function runAgyUsage(): Promise<string> {
  const tui = new TuiScraper('agy');
  try {
    tui.start();

    // Wait for AGY main menu ready
    await tui.waitFor(/for shortcuts/, 20_000);

    // Navigate to /usage panel
    tui.send('/usage');
    await tui.waitFor(/Model Quota/, 10_000);

    // Brief pause for all model rows to finish rendering
    await sleep(500);
    return tui.capture();

  } finally {
    tui.kill();
  }
}

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse the Model Quota panel into an array of entries.
 *
 * Panel format (tmux rendered — no ANSI codes):
 *
 *   └ Model Quota
 *
 *     Gemini 3.5 Flash (High)
 *     ░░░░░░░░░░░ ... 20%
 *     Refreshes in 3h 28m
 *
 *     Claude Sonnet 4.6 (Thinking)
 *     ███████████ ... 100%
 *     Quota available
 */
function parseQuotaPanel(raw: string): ModelQuotaEntry[] {
  // tmux capture-pane returns clean rendered text — no ANSI stripping needed
  const lines = raw.split(/\r?\n/);
  const results: ModelQuotaEntry[] = [];

  const headerIdx = lines.findIndex(l => l.includes('Model Quota'));
  if (headerIdx === -1) return results;

  const panelLines = lines.slice(headerIdx + 1);
  let i = 0;

  while (i < panelLines.length) {
    const line = panelLines[i].trim();

    const isModelName =
      line.length > 0 &&
      !line.startsWith('░') && !line.startsWith('█') &&
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

        if (barLine === null && (candidate.includes('░') || candidate.includes('█') || /^\d+%/.test(candidate))) {
          barLine = candidate;
          j++;
          continue;
        }

        if (barLine !== null && (candidate.includes('Refreshes') || candidate.includes('Quota available'))) {
          const m = candidate.match(/(Refreshes in [^\r\n]+|Quota available)/);
          refreshLine = m ? m[1] : candidate;
          j++;
        }

        break;
      }

      if (barLine !== null) {
        const percentMatch = barLine.match(/(\d+)%/);
        if (percentMatch) {
          results.push({ model: line, percent: parseInt(percentMatch[1], 10), refreshLine });
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

async function readCache(): Promise<QuotaCache | null> {
  try {
    return JSON.parse(await fs.readFile(CACHE_PATH, 'utf-8')) as QuotaCache;
  } catch { return null; }
}

async function writeCache(entries: ModelQuotaEntry[]): Promise<void> {
  try {
    await fs.writeFile(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), entries }), 'utf-8');
  } catch { /* non-fatal */ }
}

// ── Bucket aggregation ────────────────────────────────────────────────────

function buildSnapshots(entries: ModelQuotaEntry[], fromCache: boolean): UsageSnapshot[] {
  const source = fromCache ? 'cache' : 'official-cli';

  const geminiEntries = entries.filter(e => /gemini/i.test(e.model));
  const otherEntries  = entries.filter(e => !/gemini/i.test(e.model));

  function worstCase(bucket: ModelQuotaEntry[], tool: UsageSnapshot['tool']): UsageSnapshot {
    if (bucket.length === 0) {
      return { tool, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' };
    }
    const worst = bucket.reduce((a, b) => a.percent <= b.percent ? a : b);
    return {
      tool,
      remainingPercent: worst.percent,
      usedPercent: 100 - worst.percent,
      resetAt: worst.refreshLine ?? null,
      source,
      raw: { matchedModel: worst.model, allModels: bucket.map(e => `${e.model}: ${e.percent}%`) },
    };
  }

  return [
    worstCase(geminiEntries, 'agy-gemini'),
    worstCase(otherEntries,  'agy-other'),
  ];
}

// ── Adapter ───────────────────────────────────────────────────────────────

export class AgyQuotaAdapter implements QuotaAdapter {
  public async fetchSnapshots(): Promise<UsageSnapshot[]> {
    // Fast path: serve from cache if fresh enough
    const cached = await readCache();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return buildSnapshots(cached.entries, true);
    }

    // Slow path: spawn agy via tmux, scrape the quota panel
    try {
      const raw = await runAgyUsage();
      const entries = parseQuotaPanel(raw);

      if (entries.length > 0) {
        await writeCache(entries);
        return buildSnapshots(entries, false);
      }

      return [
        { tool: 'agy-gemini', remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' },
        { tool: 'agy-other',  remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' },
      ];

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return [
        { tool: 'agy-gemini', remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown', raw: msg },
        { tool: 'agy-other',  remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown', raw: msg },
      ];
    }
  }
}
