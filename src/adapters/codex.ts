import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { QuotaAdapter, UsageSnapshot } from './index.js';
import { TuiScraper, sleep } from '../tmux.js';
import { debug } from '../debug.js';

const execAsync = promisify(exec);

import { AccountConfig, CONFIG_DIR } from '../config.js';

// Used ONLY as a rough fallback estimate when the TUI scrape cannot determine
// a percentage. This is a GUESS based on local session cost data — not an
// official Codex quota signal. Override with AGENT_FUEL_CODEX_BUDGET env var.
const DEFAULT_BUDGET_USD = 20.0;
const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000;
const STALE_CACHE_MAX_MS = 10 * 60 * 1000;

function cachePath(account?: AccountConfig): string {
  const identity = JSON.stringify([account?.id ?? 'codex', account?.command ?? 'codex', account?.env ?? {}]);
  const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return path.join(CONFIG_DIR, `codex-quota-${key}.json`);
}

async function readLastOfficial(account?: AccountConfig): Promise<UsageSnapshot | null> {
  try {
    const saved = JSON.parse(await fs.readFile(cachePath(account), 'utf8')) as { fetchedAt: number; snapshot: UsageSnapshot };
    if (!Number.isFinite(saved.fetchedAt) || Date.now() - saved.fetchedAt > STALE_CACHE_MAX_MS ||
        !saved.snapshot || saved.snapshot.source !== 'official-cli' || saved.snapshot.remainingPercent === null) return null;
    return { ...saved.snapshot, source: 'cache' };
  } catch { return null; }
}

async function saveOfficial(snapshot: UsageSnapshot, account?: AccountConfig): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(cachePath(account), JSON.stringify({ fetchedAt: Date.now(), snapshot }), { mode: 0o600 });
  } catch (err) { debug('codex:cache', 'could not save quota', String(err)); }
}

// ── TUI scraper (tmux) ─────────────────────────────────────────────────────

// Codex may show one or more blocking dialogs before its main screen ("Tip:").
// Known dialogs and their dismissal key ("2" = skip/use existing):
//   • Update nag:      "Update available! x.x → y.y"
//   • New-model intro: "Introducing GPT-5.5"
const CODEX_READY  = /Tip:|OpenAI Codex\s*\(v[\d.]+\)/i;
const CODEX_DIALOG = /Update available|Introducing GPT|Try new model|Use existing model/i;
const CODEX_EITHER = new RegExp(`(?:${CODEX_READY.source})|(?:${CODEX_DIALOG.source})`, 'i');
const CODEX_STARTUP_MS          = 25_000;
const CODEX_DIALOG_SETTLE_MS    =  1_000; // wait for UI to re-render after dismissing a dialog
const CODEX_STATUS_TIMEOUT_MS   =  15_000;

/**
 * Launches `codex` in a tmux session and waits for a rendered /status panel.
 * Capture the terminal screen instead of its raw escape stream: Codex redraws
 * the panel in place, so raw bytes need not contain contiguous quota lines.
 */
async function runCodexScrape(cmd = 'codex', env?: Record<string, string>): Promise<string> {
  const fullCmd = `CODEX_NON_INTERACTIVE=1 ${cmd}`;
  const tui = new TuiScraper(fullCmd, env);
  try {
    tui.start();

    // Wait for TUI ready, dismissing any blocking dialogs along the way.
    const dialogDeadline = Date.now() + CODEX_STARTUP_MS;
    let screen = await tui.waitFor(CODEX_EITHER, CODEX_STARTUP_MS, 0);

    while (CODEX_DIALOG.test(screen) || !CODEX_READY.test(screen)) {
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

    // An initial /status can request a quota refresh. Retry the command if
    // the rendered panel has not acquired any usable limit yet.
    tui.send('/status');
    const deadline = Date.now() + CODEX_STATUS_TIMEOUT_MS;
    let retried = false;
    const retryAt = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const rendered = tui.capture(100);
      const parsed = parseScrapeOutput(rendered);
      if (parsed.quotaReached || parsed.fiveHourRemainingPct !== null || parsed.weeklyRemainingPct != null) {
        return rendered;
      }
      if (!retried && Date.now() >= retryAt) {
        tui.send('/status');
        retried = true;
      }
      await sleep(300);
    }
    throw new Error('Codex /status did not show quota data within 15 seconds');

  } finally {
    try { tui.kill(); } catch { /* already dead */ }
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
  // Keep this compatible with both rendered tmux text and older ANSI output.
  const clean = stripAnsi(raw);

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

  return { quotaReached: false, resetIn: null, fiveHourRemainingPct: null, fiveHourResetAt: null };
}

// ── ccusage fallback estimate ──────────────────────────────────────────────

async function fetchCcusageEstimate(budgetLimit: number, toolId = 'codex', displayName = 'Codex'): Promise<UsageSnapshot> {
  const unknown = (): UsageSnapshot => ({
    tool: toolId,
    displayName,
    remainingPercent: null,
    usedPercent: null,
    resetAt: null,
    source: 'unknown',
  });

  try {
    let stdout: string;
    try {
      ({ stdout } = await execAsync('npx --no-install ccusage codex session --json', { timeout: 5_000 }));
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
      return { tool: toolId, displayName, remainingPercent: 100, usedPercent: 0, resetAt: null, source: 'ccusage' };
    }

    const todayStr = localDateString(new Date());
    const todaySessions = (sessions as Record<string, unknown>[]).filter((s) => {
      if (typeof s.lastActivity !== 'string') return false;
      try { return localDateString(new Date(s.lastActivity)) === todayStr; }
      catch { return false; }
    });

    if (todaySessions.length === 0) {
      return { tool: toolId, displayName, remainingPercent: 100, usedPercent: 0, resetAt: null, source: 'ccusage' };
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
      tool: toolId,
      displayName,
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

  constructor(private readonly account?: AccountConfig) {
    const override = Number(process.env.AGENT_FUEL_CODEX_BUDGET);
    this.budgetLimit = Number.isFinite(override) && override > 0 ? override : DEFAULT_BUDGET_USD;
  }

  public async fetchSnapshots(): Promise<UsageSnapshot[]> {
    return [await this._fetch()];
  }

  private async _fetch(): Promise<UsageSnapshot> {
    const toolId = this.account?.id || 'codex';
    const displayName = this.account?.displayName || 'Codex';
    const cmd = this.account?.command || 'codex';
    const env = this.account?.env;
    const fallback = async (): Promise<UsageSnapshot> =>
      await readLastOfficial(this.account) ?? await fetchCcusageEstimate(this.budgetLimit, toolId, displayName);

    debug('codex:fetch', `starting TUI scrape for account ${toolId} (${cmd})`);
    try {
      const raw = await runCodexScrape(cmd, env);
      const result = parseScrapeOutput(raw);

      if (result.quotaReached) {
        const resetAt = result.resetIn ? `Resets in ${result.resetIn}` : null;
        debug('codex:fetch', 'quota reached → returning 0%');
        const snapshot: UsageSnapshot = {
          tool: toolId,
          displayName,
          remainingPercent: 0,
          usedPercent: 100,
          resetAt,
          source: 'official-cli',
        };
        await saveOfficial(snapshot, this.account);
        return snapshot;
      }

      const limits: { pct: number; reset: string | null; type: 'session' | 'weekly' }[] = [];
      if (result.fiveHourRemainingPct !== null) {
        limits.push({ pct: result.fiveHourRemainingPct, reset: result.fiveHourResetAt, type: 'session' });
      }
      if (result.weeklyRemainingPct !== undefined && result.weeklyRemainingPct !== null) {
        limits.push({ pct: result.weeklyRemainingPct, reset: result.weeklyResetAt ?? null, type: 'weekly' });
      }

      if (limits.length > 0) {
        limits.sort((a, b) => a.pct - b.pct);
        const limiting = limits[0];

        const remainingPercent = limiting.pct;
        const resetAt = limiting.reset;
        const weeklyLimitReached = result.weeklyRemainingPct === 0;

        debug('codex:fetch', `parsed /status → ${remainingPercent}% remaining (limiting factor: ${limiting.type})`);
        const snapshot: UsageSnapshot = {
          tool: toolId,
          displayName,
          remainingPercent,
          usedPercent: 100 - remainingPercent,
          resetAt,
          limitType: limiting.type,
          breakdown: (result.fiveHourRemainingPct !== null && result.weeklyRemainingPct !== undefined && result.weeklyRemainingPct !== null) ? {
            fiveHour: result.fiveHourRemainingPct,
            weekly: result.weeklyRemainingPct,
          } : undefined,
          weeklyLimitReached,
          source: 'official-cli',
        };
        await saveOfficial(snapshot, this.account);
        return snapshot;
      }

      debug('codex:fetch', '/status parse failed → checking last official result');
      return fallback();

    } catch (err) {
      debug('codex:fetch', 'scrape failed → checking last official result', String(err));
      return fallback();
    }
  }
}

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
