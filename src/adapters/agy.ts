import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { QuotaAdapter, UsageSnapshot } from './index.js';

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

// ── ANSI / terminal helpers ────────────────────────────────────────────────

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]|\x1B[^[]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// ── Scraping ───────────────────────────────────────────────────────────────

/**
 * Spawns `agy` via `expect`, opens the `/usage` panel, waits for the
 * Model Quota list to render, then exits.
 */
function runAgyUsage(): Promise<string> {
  return new Promise((resolve) => {
    const expectScript = [
      'set timeout 20',
      'spawn agy',
      'expect -re "for shortcuts"',
      'send "/usage\\r"',
      'expect -re "Model Quota"',
      'after 800',
      'send "\\x03"',
      'expect eof',
    ].join('\n');

    // Cap output to avoid unbounded memory growth if agy misbehaves
    const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB — far more than the quota panel needs
    let output = '';

    // Spread process.env so `expect` can locate `agy` via PATH and the
    // keyring daemon can be reached via the existing session environment.
    const child = spawn('expect', ['-c', expectScript], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT_BYTES) {
        output += chunk.toString();
      }
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(output); }, 25_000);
    child.on('close', () => { clearTimeout(timer); resolve(output); });
  });
}

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse the Model Quota panel into an array of entries.
 *
 * Panel format (after ANSI strip):
 *
 *   └ Model Quota
 *
 *     Gemini 3.5 Flash (High)
 *     ░░░░░░░░░░░ ... 20%
 *     Refreshes in 3h 28m           ← or "80% remaining · Refreshes in …"
 *
 *     Claude Sonnet 4.6 (Thinking)
 *     ███████████ ... 100%
 *     Quota available
 */
function parseQuotaPanel(raw: string): ModelQuotaEntry[] {
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/);
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

        // Progress bar line: has block chars OR starts with a digit%
        if (barLine === null && (candidate.includes('░') || candidate.includes('█') || /^\d+%/.test(candidate))) {
          barLine = candidate;
          j++;
          continue;
        }

        // Refresh / availability line
        if (barLine !== null && (candidate.includes('Refreshes') || candidate.includes('Quota available'))) {
          // Strip any leading "NN% remaining · " prefix
          const m = candidate.match(/(Refreshes in [^\r\n]+|Quota available)/);
          refreshLine = m ? m[1] : candidate;
          j++;
        }

        break;
      }

      if (barLine !== null) {
        // Percentage is always at the END of the bar line: "░░░ ... 20%" or "20% remaining · …"
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

/**
 * Given all quota entries, build the two UsageSnapshot rows:
 *   - agy-gemini: worst-case (min remaining) across all Gemini models
 *   - agy-other:  worst-case across all non-Gemini models (Claude, etc.)
 */
function buildSnapshots(entries: ModelQuotaEntry[], fromCache: boolean): UsageSnapshot[] {
  const source = fromCache ? 'cache' : 'official-cli';

  const geminiEntries = entries.filter(e => /gemini/i.test(e.model));
  const otherEntries  = entries.filter(e => !/gemini/i.test(e.model));

  function worstCase(bucket: ModelQuotaEntry[], tool: UsageSnapshot['tool']): UsageSnapshot {
    if (bucket.length === 0) {
      return { tool, remainingPercent: null, usedPercent: null, resetAt: null, source: 'unknown' };
    }
    // Show the lowest remaining % (most constrained model in the bucket)
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

    // Slow path: spawn agy, scrape the quota panel
    try {
      const raw = await runAgyUsage();
      const entries = parseQuotaPanel(raw);

      if (entries.length > 0) {
        await writeCache(entries);
        return buildSnapshots(entries, false);
      }

      // Panel not found — return unknown rows (do not cache failures)
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
