import { exec, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { QuotaAdapter, UsageSnapshot } from './index.js';
import { TuiScraper, sleep, registerTempFile, unregisterTempFile } from '../tmux.js';
import { debug } from '../debug.js';

const execAsync = promisify(exec);

// Used ONLY as a rough fallback estimate when the TUI scrape cannot determine
// a percentage. This is a GUESS based on local session cost data — not an
// official Codex quota signal. Override with AGENT_FUEL_CODEX_BUDGET env var.
const DEFAULT_BUDGET_USD = 20.0;
const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000;

// ── TUI scraper (tmux) ─────────────────────────────────────────────────────

// Codex may show one or more blocking dialogs before its main screen ("Tip:").
// Known dialogs and their dismissal key ("2" = skip/use existing):
//   • Update nag:      "Update available! x.x → y.y"
//   • New-model intro: "Introducing GPT-5.5"
const CODEX_READY  = /Tip:/i;
const CODEX_DIALOG = /Update available|Introducing GPT|Try new model|Use existing model/i;
const CODEX_EITHER = new RegExp(`(?:${CODEX_READY.source})|(?:${CODEX_DIALOG.source})`, 'i');
const CODEX_STARTUP_MS          = 25_000;
const CODEX_DIALOG_SETTLE_MS    =  1_000; // wait for UI to re-render after dismissing a dialog
const CODEX_STATUS_REFRESH_MS   =  2_000; // first /status just triggers a quota refresh
const CODEX_STATUS_READY_MS     =  4_000; // second /status carries the live quota data

/**
 * Launches `codex` in a tmux session, pipes all terminal bytes to a temp
 * file, sends /status twice, then reads the file and returns the raw bytes.
 *
 * Why pipe-pane instead of capture-pane:
 * The /status overlay is full-screen and transient — it renders in-place for
 * one frame and re-renders away without entering the tmux scrollback buffer.
 * capture-pane (even with -S history) can never catch it. pipe-pane streams
 * every raw byte to a file so even a 10ms overlay is permanently recorded.
 */
async function runCodexScrape(): Promise<string> {
  const tui = new TuiScraper('env CODEX_NON_INTERACTIVE=1 codex');
  
  const tmpDir = os.tmpdir();
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const pipePath = path.join(tmpDir, `af-codex-${Date.now()}-${randomSuffix}.log`);
  
  registerTempFile(pipePath);
  // Create the file with restricted permissions before tmux starts writing to it
  writeFileSync(pipePath, '', { mode: 0o600 });
  try {
    tui.start();

    // Stream all pane output to a file from the start.
    // Single-quote escaping: safe against all shell metacharacters ($, `, \, space, etc.)
    // Note: pipe-pane executes this command via tmux's `default-shell` (defaults to /bin/sh).
    // If the user has set default-shell to a non-POSIX shell (e.g. fish), the `'\\''` idiom
    // will fail — but pipePath is constructed from os.tmpdir() + hex, so single quotes
    // cannot appear in practice, making the replace a no-op and the quoting sh-compatible.
    const shellSafePath = "'" + pipePath.replace(/'/g, "'\\''") + "'";
    execFileSync('tmux', ['pipe-pane', '-t', tui.sessionId, `cat >> ${shellSafePath}`]);
    debug('codex:scrape', `pipe-pane logging to ${pipePath}`);

    // Wait for TUI ready, dismissing any blocking dialogs along the way.
    const dialogDeadline = Date.now() + CODEX_STARTUP_MS;
    let screen = await tui.waitFor(CODEX_EITHER, CODEX_STARTUP_MS, 0);

    while (!CODEX_READY.test(screen)) {
      if (/Update available/i.test(screen)) {
        debug('codex:scrape', 'Update available dialog detected — sending Down + Enter to skip');
        tui.sendKey('Down');
        await sleep(200);
        tui.sendKey('Enter');
      } else {
        debug('codex:scrape', 'blocking dialog detected — sending "2" to dismiss');
        tui.send('2');
      }
      await sleep(CODEX_DIALOG_SETTLE_MS);
      const remaining = dialogDeadline - Date.now(); // compute AFTER sleep
      if (remaining < 500) {
        throw new Error('Codex TUI never reached ready state after dismissing dialogs');
      }
      screen = await tui.waitFor(CODEX_EITHER, remaining, 0);
    }

    // First /status: panel says "Limits: refresh requested; run /status again shortly"
    tui.send('/status');
    await sleep(CODEX_STATUS_REFRESH_MS);

    // Second /status: has actual 5h/weekly quota data
    tui.send('/status');
    await sleep(CODEX_STATUS_READY_MS);

    const raw = readFileSync(pipePath, 'utf-8');
    debug('codex:scrape', `pipe log size: ${raw.length} bytes`);
    return raw;

  } finally {
    try { tui.kill(); } catch { /* already dead */ }
    unregisterTempFile(pipePath); // always remove from registry, regardless of unlink success
    try { unlinkSync(pipePath); } catch { /* ok if already gone */ }
  }
}

// ── Output parser ──────────────────────────────────────────────────────────

interface CodexScrapeResult {
  quotaReached: boolean;
  resetIn: string | null;
  fiveHourRemainingPct: number | null;
  fiveHourResetAt: string | null;
  weeklyRemainingPct?: number | null;
  weeklyResetAt?: string | null;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1B\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    .replace(/\x1B[^[]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function parseScrapeOutput(raw: string): CodexScrapeResult {
  // pipe-pane output contains raw ANSI bytes — strip before pattern matching
  const clean = stripAnsi(raw);
  debug('codex:parse', `raw length: ${raw.length}, cleaned length: ${clean.length}`);
  debug('codex:parse', 'cleaned output', clean);
  debug('codex:parse', 'checking patterns', {
    hasIndividualQuota: /Individual quota reached/i.test(clean),
    hasHeadsUp: /less than \d+%\s+of your 5h limit left/i.test(clean),
    has5hLimit: /5h limit:/i.test(clean),
    hasWeeklyLimit: /Weekly limit:/i.test(clean),
    hasLimits: /Limits:/i.test(clean),
  });

  // "Individual quota reached. Contact your administrator to enable overages. Resets in 4h33m29s."
  if (/Individual quota reached/i.test(clean)) {
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
    debug('codex:parse', 'result', { quotaReached: true, resetIn });
    return { quotaReached: true, resetIn, fiveHourRemainingPct: null, fiveHourResetAt: null };
  }

  // Parse "/status" panel: "5h limit: [...] X% left (resets HH:MM)"
  // Use the LAST match — /status is sent twice and the second response is fresh.
  const allFiveHMatches = [...clean.matchAll(/5h limit:\s*\[.*?\]\s*(\d+)%\s*left\s*\(resets\s+([^)]+)\)/gi)];
  const fiveHMatch = allFiveHMatches.at(-1) ?? null;
  
  const allWeeklyMatches = [...clean.matchAll(/weekly limit:\s*\[.*?\]\s*(\d+)%\s*left\s*\(resets\s+([^)]+)\)/gi)];
  const weeklyMatch = allWeeklyMatches.at(-1) ?? null;

  if (fiveHMatch || weeklyMatch) {
    const fiveHourRemainingPct = fiveHMatch ? Math.min(100, Math.max(0, parseInt(fiveHMatch[1], 10))) : null;
    const fiveHourResetAt = fiveHMatch ? fiveHMatch[2].trim() : null;
    const weeklyRemainingPct = weeklyMatch ? Math.min(100, Math.max(0, parseInt(weeklyMatch[1], 10))) : null;
    const weeklyResetAt = weeklyMatch ? weeklyMatch[2].trim() : null;
    
    debug('codex:parse', 'result', {
      quotaReached: false,
      fiveHourRemainingPct,
      fiveHourResetAt,
      weeklyRemainingPct,
      weeklyResetAt,
    });
    return {
      quotaReached: false,
      resetIn: null,
      fiveHourRemainingPct,
      fiveHourResetAt,
      weeklyRemainingPct,
      weeklyResetAt,
    };
  }

  // "⚠ Heads up, you have less than X% of your 5h limit left."
  const headsUpMatch = clean.match(/less than (\d+)%\s+of your 5h limit left/i);
  if (headsUpMatch) {
    const ceiling = parseInt(headsUpMatch[1], 10);
    const fiveHourRemainingPct = Math.max(0, ceiling - 1);
    debug('codex:parse', 'result', { source: 'headsUp', ceiling, fiveHourRemainingPct });
    return { quotaReached: false, resetIn: null, fiveHourRemainingPct, fiveHourResetAt: null };
  }

  debug('codex:parse', 'result', { quotaReached: false, fiveHourRemainingPct: null, fiveHourResetAt: null, fiveHMatchRaw: null });
  return { quotaReached: false, resetIn: null, fiveHourRemainingPct: null, fiveHourResetAt: null };
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
    } catch (err) {
      debug('codex:ccusage', 'ccusage exec failed', String(err));
      return unknown();
    }

    debug('codex:ccusage', 'raw stdout', stdout);
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
          hour: '2-digit', minute: '2-digit', hour12: false,
        });
      } catch { /* leave null */ }
    }

    debug('codex:ccusage', 'computed', {
      totalCost,
      todaySessionsCount: todaySessions.length,
      budgetLimit,
      usedPct,
      remainingPercent,
      resetAt,
    });
    return {
      tool: 'codex',
      remainingPercent,
      usedPercent: Math.round(usedPct),
      resetAt,
      source: 'ccusage',
      raw: { totalCost, todaySessionsCount: todaySessions.length, isEstimate: true },
    };
  } catch (err) {
    debug('codex:ccusage', 'unexpected error in ccusage fallback', String(err));
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
    debug('codex:fetch', 'starting TUI scrape via tmux');
    try {
      const raw = await runCodexScrape();
      const result = parseScrapeOutput(raw);

      if (result.quotaReached) {
        const resetAt = result.resetIn ? `Resets in ${result.resetIn}` : null;
        debug('codex:fetch', 'quota reached → returning 0%');
        return {
          tool: 'codex',
          remainingPercent: 0,
          usedPercent: 100,
          resetAt,
          source: 'official-cli',
        };
      }

      if (result.fiveHourRemainingPct !== null || (result.weeklyRemainingPct !== undefined && result.weeklyRemainingPct !== null)) {
        let remainingPercent = result.fiveHourRemainingPct !== null ? result.fiveHourRemainingPct : 100;
        let resetAt = result.fiveHourResetAt;
        let weeklyLimitReached = false;

        if (result.weeklyRemainingPct === 0) {
          remainingPercent = 0;
          weeklyLimitReached = true;
          if (result.weeklyResetAt) {
            resetAt = result.weeklyResetAt;
          }
        }

        debug('codex:fetch', `parsed /status → ${remainingPercent}% remaining`);
        return {
          tool: 'codex',
          remainingPercent,
          usedPercent: 100 - remainingPercent,
          resetAt: resetAt,
          weeklyLimitReached,
          source: 'official-cli',
        };
      }

      debug('codex:fetch', '/status parse failed → falling back to ccusage estimate');
      return fetchCcusageEstimate(this.budgetLimit);

    } catch (err) {
      debug('codex:fetch', 'caught error, falling back to ccusage', String(err));
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
