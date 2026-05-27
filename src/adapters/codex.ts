import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { QuotaAdapter, UsageSnapshot } from './index.js';

const execAsync = promisify(exec);

// Used ONLY as a rough fallback estimate when the TUI scrape cannot determine
// a percentage (i.e. quota has not yet been reached). This is a GUESS based on
// local session cost data — not an official Codex quota signal.
// Override with AGENT_FUEL_CODEX_BUDGET env var (dollars).
const DEFAULT_BUDGET_USD = 20.0;
const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000;

// ── TUI scraper (expect) ───────────────────────────────────────────────────

/**
 * Spawns `codex` via `expect`, handles the trust prompt, waits for the TUI to
 * settle, then captures stdout/stderr to check for the quota-reached warning.
 */
function runCodexScrape(): Promise<string> {
  return new Promise((resolve) => {
    const expectScript = [
      'set timeout 15',
      'spawn codex',
      'expect {',
      '  -re "Press enter to continue" { send "\\r"; exp_continue }',
      '  -re "Individual quota reached" { after 300; send "\\x03" }',
      '  -re "for shortcuts" { after 300; send "\\x03" }',
      '  timeout { }',
      '  eof { }',
      '}',
      'expect eof',
    ].join('\n');

    const MAX_OUTPUT_BYTES = 64 * 1024;
    let output = '';

    const child = spawn('expect', ['-c', expectScript], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(output); }, 20_000);
    child.on('close', () => { clearTimeout(timer); resolve(output); });
  });
}

// ── Output parser ──────────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]|\x1B[^[]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

interface CodexScrapeResult {
  quotaReached: boolean;
  resetIn: string | null; // e.g. "4h 33m"
}

function parseScrapeOutput(raw: string): CodexScrapeResult {
  const clean = stripAnsi(raw);

  // "Individual quota reached. Contact your administrator to enable overages. Resets in 4h33m29s."
  const quotaMatch = clean.match(/Individual quota reached/i);
  if (!quotaMatch) return { quotaReached: false, resetIn: null };

  // Parse "Resets in 4h33m29s" → "4h 33m"
  const resetMatch = clean.match(/Resets in\s*((?:\d+h)?(?:\d+m)?(?:\d+s)?)/i);
  let resetIn: string | null = null;
  if (resetMatch) {
    const parts: string[] = [];
    const hm = resetMatch[1].match(/^(\d+h)?(\d+m)?/);
    if (hm) {
      if (hm[1]) parts.push(hm[1]);
      if (hm[2]) parts.push(hm[2]);
    }
    resetIn = parts.length > 0 ? parts.join(' ') : null;
  }

  return { quotaReached: true, resetIn };
}

// ── ccusage fallback estimate ──────────────────────────────────────────────

async function fetchCcusageEstimate(budgetLimit: number): Promise<UsageSnapshot> {
  const unknown = (): UsageSnapshot => ({
    tool: 'codex',
    remainingPercent: null,
    usedPercent: null,
    resetAt: null,
    source: 'unknown',
  });

  try {
    let stdout: string;
    try {
      ({ stdout } = await execAsync('npx --no-install ccusage codex session --json'));
    } catch {
      return unknown();
    }

    const data = JSON.parse(stdout);
    const sessions: unknown[] =
      Array.isArray(data?.sessions) ? data.sessions :
      Array.isArray(data?.session)  ? data.session  :
      Array.isArray(data)           ? data           : [];

    if (sessions.length === 0) {
      return { tool: 'codex', remainingPercent: 100, usedPercent: 0, resetAt: null, source: 'ccusage' };
    }

    const todayStr = localDateString(new Date());
    const todaySessions = (sessions as Record<string, unknown>[]).filter((s) => {
      if (typeof s.lastActivity !== 'string') return false;
      try { return localDateString(new Date(s.lastActivity)) === todayStr; }
      catch { return false; }
    });

    if (todaySessions.length === 0) {
      return { tool: 'codex', remainingPercent: 100, usedPercent: 0, resetAt: null, source: 'ccusage' };
    }

    const totalCost = todaySessions.reduce(
      (acc, s) => acc + (typeof s.costUSD === 'number' ? s.costUSD : 0), 0,
    );

    const usedPct = (totalCost / budgetLimit) * 100;
    const rawRemaining = 100 - usedPct;
    const remainingPercent =
      usedPct > 0 && rawRemaining > 99 ? 99
        : Math.max(0, Math.min(100, Math.round(rawRemaining)));

    const latestActivity = todaySessions
      .map((s) => new Date(s.lastActivity as string).getTime())
      .reduce((a, b) => (b > a ? b : a), 0);

    let resetAt: string | null = null;
    if (latestActivity > 0) {
      try {
        resetAt = new Date(latestActivity + ROLLING_WINDOW_MS).toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit',
        });
      } catch { /* leave null */ }
    }

    return {
      tool: 'codex',
      remainingPercent,
      usedPercent: Math.round(usedPct),
      resetAt,
      source: 'ccusage',
      raw: { totalCost, todaySessionsCount: todaySessions.length, isEstimate: true },
    };
  } catch {
    return unknown();
  }
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class CodexQuotaAdapter implements QuotaAdapter {
  private readonly budgetLimit: number;

  constructor() {
    const override = Number(process.env.AGENT_FUEL_CODEX_BUDGET);
    this.budgetLimit = Number.isFinite(override) && override > 0 ? override : DEFAULT_BUDGET_USD;
  }

  public async fetchSnapshots(): Promise<UsageSnapshot[]> {
    return [await this._fetch()];
  }

  private async _fetch(): Promise<UsageSnapshot> {
    // Primary: scrape the Codex TUI via expect
    try {
      const raw = await runCodexScrape();
      const result = parseScrapeOutput(raw);

      if (result.quotaReached) {
        // Ground truth: quota is exhausted
        const resetAt = result.resetIn ? `Resets in ${result.resetIn}` : null;
        return {
          tool: 'codex',
          remainingPercent: 0,
          usedPercent: 100,
          resetAt,
          source: 'official-cli',
        };
      }

      // TUI loaded cleanly with no quota warning → estimate remaining via ccusage
      const estimate = await fetchCcusageEstimate(this.budgetLimit);
      return estimate;

    } catch {
      // expect not available or codex spawn failed → fall back to ccusage estimate
      return fetchCcusageEstimate(this.budgetLimit);
    }
  }
}

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
