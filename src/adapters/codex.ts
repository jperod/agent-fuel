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
const STALE_CACHE_MAX_MS = 60 * 60 * 1000;

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
const CODEX_READY    = /Tip:|Ask Codex to do anything|\? for shortcuts|OpenAI Codex\s*\(v[\d.]+\)/i;
const CODEX_DIALOG   = /Update available|Introducing GPT|Try new model|Use existing model|incompatible feature settings|Run without daemon/i;
const CODEX_UPDATING = /Updating Codex via|Downloading Codex CLI|Installing standalone package|Update ran successfully|Please restart Codex/i;
const CODEX_EITHER   = new RegExp(`(?:${CODEX_READY.source})|(?:${CODEX_DIALOG.source})|(?:${CODEX_UPDATING.source})`, 'i');
const CODEX_STARTUP_MS          = 25_000;
const CODEX_DIALOG_SETTLE_MS    =  1_000; // wait for UI to re-render after dismissing a dialog
const CODEX_STATUS_TIMEOUT_MS   =  15_000;

/**
 * Launches `codex` in a tmux session and waits for a rendered /status panel.
 * Capture the terminal screen instead of its raw escape stream: Codex redraws
 * the panel in place, so raw bytes need not contain contiguous quota lines.
 */
async function runCodexScrape(cmd = 'codex', env?: Record<string, string>, retryCount = 0): Promise<string> {
  const fullCmd = `CODEX_NON_INTERACTIVE=1 ${cmd}`;
  const tui = new TuiScraper(fullCmd, env);
  try {
    tui.start();

    // Wait for TUI ready, dismissing any blocking dialogs along the way.
    const dialogDeadline = Date.now() + CODEX_STARTUP_MS;
    let screen = await tui.waitFor(CODEX_EITHER, CODEX_STARTUP_MS, 0);

    // If an auto-update is running, wait for it to complete, then restart scrape
    if (CODEX_UPDATING.test(screen)) {
      debug('codex:scrape', 'Codex auto-update detected in progress — waiting for installer to complete');
      const updateDeadline = Date.now() + 45_000;
      while (Date.now() < updateDeadline && tui.isAlive()) {
        const text = tui.capture(100);
        if (/Update ran successfully|Please restart Codex/i.test(text)) {
          break;
        }
        await sleep(500);
      }
      tui.kill();
      if (retryCount < 1) {
        debug('codex:scrape', 'Codex auto-update finished — restarting scrape with updated binary');
        await sleep(1_000);
        return runCodexScrape(cmd, env, retryCount + 1);
      }
      throw new Error('Codex auto-update in progress');
    }

    // Codex may render the initial greeting screen briefly (~1s) before the background
    // daemon connects and triggers blocking dialogs (e.g. incompatible feature settings).
    // Allow a settle window to catch any asynchronously appearing dialogs.
    const settleDeadline = Date.now() + 2_000;
    while (Date.now() < settleDeadline && !CODEX_DIALOG.test(screen) && !CODEX_UPDATING.test(screen)) {
      await sleep(200);
      screen = tui.capture(0);
    }

    if (CODEX_UPDATING.test(screen)) {
      debug('codex:scrape', 'Codex auto-update detected during settle window');
      tui.kill();
      if (retryCount < 1) {
        await sleep(1_000);
        return runCodexScrape(cmd, env, retryCount + 1);
      }
      throw new Error('Codex auto-update in progress');
    }

    while (CODEX_DIALOG.test(screen) || !CODEX_READY.test(screen)) {
      if (CODEX_UPDATING.test(screen)) {
        debug('codex:scrape', 'Codex auto-update detected in dialog loop');
        tui.kill();
        if (retryCount < 1) {
          await sleep(1_000);
          return runCodexScrape(cmd, env, retryCount + 1);
        }
        throw new Error('Codex auto-update in progress');
      }
      if (/incompatible feature settings|Run without daemon/i.test(screen)) {
        debug('codex:scrape', 'Incompatible feature settings dialog detected — sending "1" to run without daemon');
        tui.send('1');
      } else if (/Update available/i.test(screen)) {
        debug('codex:scrape', 'Update available dialog detected — sending "2" to skip update');
        tui.send('2');
        await sleep(200);
        tui.sendKey('Escape');
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
    // In Codex TUI, typing /status opens the slash autocomplete dropdown;
    // a second Enter confirms and submits the command.
    const sendStatus = async (): Promise<void> => {
      debug('codex:scrape', 'sending /status command');
      tui.send('/status');
      await sleep(300);
      tui.sendKey('Enter');
    };

    await sendStatus();
    const deadline = Date.now() + CODEX_STATUS_TIMEOUT_MS;
    let retried = false;
    const retryAt = Date.now() + 2_500;
    while (Date.now() < deadline) {
      const rendered = tui.capture(100);
      debug('codex:scrape', 'current rendered screen', rendered);
      if (/incompatible feature settings|Run without daemon/i.test(rendered)) {
        debug('codex:scrape', 'Incompatible feature settings dialog appeared during status loop — sending "1"');
        tui.send('1');
        await sleep(CODEX_DIALOG_SETTLE_MS);
        await sendStatus();
        continue;
      }
      const parsed = parseScrapeOutput(rendered);
      if (parsed.quotaReached || (parsed.limits && parsed.limits.length > 0) || parsed.fiveHourRemainingPct !== null || parsed.weeklyRemainingPct != null || parsed.monthlyRemainingPct != null) {
        return rendered;
      }
      // If /status is still unsubmitted on the input prompt, hit Enter again
      if (/[›>]\s*\/status/i.test(rendered)) {
        debug('codex:scrape', '/status still on input prompt — sending Enter again');
        tui.sendKey('Enter');
      }
      if (!retried && Date.now() >= retryAt) {
        await sendStatus();
        retried = true;
      }
      await sleep(300);
    }
    const finalScreen = tui.capture(100);
    debug('codex:scrape', 'final screen before timeout', finalScreen);
    throw new Error('Codex /status did not show quota data within 15 seconds');

  } finally {
    try { tui.kill(); } catch { /* already dead */ }
  }
}

// ── Output parser ──────────────────────────────────────────────────────────

export interface CodexLimit {
  name: string;
  type: 'session' | 'weekly' | 'monthly' | 'daily';
  pct: number;
  resetAt: string | null;
}

interface CodexScrapeResult {
  quotaReached: boolean;
  resetIn: string | null;
  limits: CodexLimit[];
  isFreeTier: boolean;
  fiveHourRemainingPct: number | null;
  fiveHourResetAt: string | null;
  weeklyRemainingPct?: number | null;
  weeklyResetAt?: string | null;
  monthlyRemainingPct?: number | null;
  monthlyResetAt?: string | null;
  dailyRemainingPct?: number | null;
  dailyResetAt?: string | null;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1B\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    .replace(/\x1B[^[]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function parseScrapeOutput(raw: string): CodexScrapeResult {
  // Keep this compatible with both rendered tmux text and older ANSI output.
  const clean = stripAnsi(raw);

  const isFreeTier =
    /\((?:Free|Free Tier)\)/i.test(clean) ||
    /Account:\s*.*?\bFree\b/i.test(clean) ||
    /Plan:\s*.*?\bFree\b/i.test(clean) ||
    /for a limited time.*?for free/i.test(clean);

  // "Individual quota reached. Contact your administrator to enable overages. Resets in 4h33m29s."
  if (/(?:Individual\s+|Monthly\s+|Weekly\s+)?quota reached|You(?:'ve| have) reached your (?:monthly\s+|weekly\s+|free\s+)?(?:usage\s+)?limit|Rate limit reached/i.test(clean)) {
    const resetMatch = clean.match(/Resets (?:in\s*)?((?:\d+h)?\s*(?:\d+m)?(?:\d+s)?|[^\n\r)]+)/i);
    let resetIn: string | null = null;
    if (resetMatch) {
      const val = resetMatch[1].trim();
      const hm = val.match(/^(\d+h)?\s*(\d+m)?/);
      if (hm && (hm[1] || hm[2])) {
        const parts: string[] = [];
        if (hm[1]) parts.push(hm[1]);
        if (hm[2]) parts.push(hm[2]);
        resetIn = parts.join(' ');
      } else {
        resetIn = val;
      }
    }
    debug('codex:parse', 'result', { quotaReached: true, resetIn, isFreeTier });
    return {
      quotaReached: true,
      resetIn,
      limits: [{ name: 'quota', type: 'session', pct: 0, resetAt: resetIn }],
      isFreeTier,
      fiveHourRemainingPct: null,
      fiveHourResetAt: null,
      weeklyRemainingPct: null,
      weeklyResetAt: null,
      monthlyRemainingPct: null,
      monthlyResetAt: null,
      dailyRemainingPct: null,
      dailyResetAt: null,
    };
  }

  // Parse "/status" panel lines like:
  //   "5h limit:       [██████████░░░░░░░░░░] 52% left (resets 23:37)"
  //   "Weekly limit:   [████░░░░░░░░░░░░░░░░] 21% left (resets 10:53 on 31 May)"
  //   "Monthly limit:  [░░░░░░░░░░░░░░░░░░░░]  0% left (resets 17:14 on 14 Nov)"
  //   "Daily limit:    [...] 80% left"
  // Keep the LAST occurrence of each limit type since /status may be sent twice.
  const allLimitMatches = [
    ...clean.matchAll(/(?:^|[\r\n])[^\S\r\n]*([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)\s*limit:\s*(?:\[.*?\]\s*)?(\d+)\s*%\s*(?:left|remaining)(?:\s*\(resets\s+([^)]+)\))?/gi),
  ];

  if (allLimitMatches.length > 0) {
    const limitsByType = new Map<string, CodexLimit>();

    for (const match of allLimitMatches) {
      const rawName = match[1].trim().toLowerCase();
      const pct = Math.min(100, Math.max(0, parseInt(match[2], 10)));
      const resetAt = match[3] ? match[3].trim() : null;

      let type: 'session' | 'weekly' | 'monthly' | 'daily' = 'session';
      if (/5h|session|hour/i.test(rawName)) {
        type = 'session';
      } else if (/week/i.test(rawName)) {
        type = 'weekly';
      } else if (/month/i.test(rawName)) {
        type = 'monthly';
      } else if (/day|daily/i.test(rawName)) {
        type = 'daily';
      }

      limitsByType.set(type, {
        name: rawName,
        type,
        pct,
        resetAt,
      });
    }

    const limits = Array.from(limitsByType.values());
    const fiveHourLimit = limitsByType.get('session');
    const weeklyLimit = limitsByType.get('weekly');
    const monthlyLimit = limitsByType.get('monthly');
    const dailyLimit = limitsByType.get('daily');

    debug('codex:parse', 'result', {
      quotaReached: false,
      limits,
      fiveHourRemainingPct: fiveHourLimit?.pct ?? null,
      fiveHourResetAt: fiveHourLimit?.resetAt ?? null,
      weeklyRemainingPct: weeklyLimit?.pct ?? null,
      weeklyResetAt: weeklyLimit?.resetAt ?? null,
      monthlyRemainingPct: monthlyLimit?.pct ?? null,
      monthlyResetAt: monthlyLimit?.resetAt ?? null,
      dailyRemainingPct: dailyLimit?.pct ?? null,
      dailyResetAt: dailyLimit?.resetAt ?? null,
    });

    return {
      quotaReached: false,
      resetIn: null,
      limits,
      isFreeTier,
      fiveHourRemainingPct: fiveHourLimit?.pct ?? null,
      fiveHourResetAt: fiveHourLimit?.resetAt ?? null,
      weeklyRemainingPct: weeklyLimit?.pct ?? null,
      weeklyResetAt: weeklyLimit?.resetAt ?? null,
      monthlyRemainingPct: monthlyLimit?.pct ?? null,
      monthlyResetAt: monthlyLimit?.resetAt ?? null,
      dailyRemainingPct: dailyLimit?.pct ?? null,
      dailyResetAt: dailyLimit?.resetAt ?? null,
    };
  }

  // "⚠ Heads up, you have less than X% of your 5h/weekly/monthly limit left."
  const headsUpMatch = clean.match(/less than (\d+)%\s+of your (?:([a-z0-9_-]+)\s+)?limit left/i);
  if (headsUpMatch) {
    const ceiling = parseInt(headsUpMatch[1], 10);
    const remainingPct = Math.max(0, ceiling - 1);
    const limitName = headsUpMatch[2] ? headsUpMatch[2].toLowerCase() : '5h';
    let type: 'session' | 'weekly' | 'monthly' | 'daily' = 'session';
    if (/week/i.test(limitName)) type = 'weekly';
    else if (/month/i.test(limitName)) type = 'monthly';
    else if (/day|daily/i.test(limitName)) type = 'daily';

    const limit: CodexLimit = { name: limitName, type, pct: remainingPct, resetAt: null };
    debug('codex:parse', 'result', { source: 'headsUp', ceiling, remainingPct, type });
    return {
      quotaReached: false,
      resetIn: null,
      limits: [limit],
      isFreeTier,
      fiveHourRemainingPct: type === 'session' ? remainingPct : null,
      fiveHourResetAt: null,
      weeklyRemainingPct: type === 'weekly' ? remainingPct : null,
      weeklyResetAt: null,
      monthlyRemainingPct: type === 'monthly' ? remainingPct : null,
      monthlyResetAt: null,
      dailyRemainingPct: type === 'daily' ? remainingPct : null,
      dailyResetAt: null,
    };
  }

  return {
    quotaReached: false,
    resetIn: null,
    limits: [],
    isFreeTier,
    fiveHourRemainingPct: null,
    fiveHourResetAt: null,
    weeklyRemainingPct: null,
    weeklyResetAt: null,
    monthlyRemainingPct: null,
    monthlyResetAt: null,
    dailyRemainingPct: null,
    dailyResetAt: null,
  };
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
          isFreeTier: result.isFreeTier,
          monthlyLimitReached: result.isFreeTier,
          source: 'official-cli',
        };
        await saveOfficial(snapshot, this.account);
        return snapshot;
      }

      if (result.limits.length > 0) {
        // Sort limits ascending by remaining percentage so that the most constraining limit is primary
        const sortedLimits = [...result.limits].sort((a, b) => a.pct - b.pct);
        const limiting = sortedLimits[0];

        const remainingPercent = limiting.pct;
        const resetAt = limiting.resetAt;
        const weeklyLimitReached = result.limits.some(l => l.type === 'weekly' && l.pct === 0);
        const monthlyLimitReached = result.limits.some(l => l.type === 'monthly' && l.pct === 0);

        const fiveHour = result.limits.find(l => l.type === 'session')?.pct ?? null;
        const weekly = result.limits.find(l => l.type === 'weekly')?.pct ?? null;
        const monthly = result.limits.find(l => l.type === 'monthly')?.pct ?? null;

        let breakdown: UsageSnapshot['breakdown'] = undefined;
        if (fiveHour !== null && weekly !== null) {
          breakdown = { fiveHour, weekly };
        } else if (fiveHour !== null && monthly !== null) {
          breakdown = { fiveHour, monthly };
        } else if (weekly !== null && monthly !== null) {
          breakdown = { weekly, monthly };
        }

        debug('codex:fetch', `parsed /status → ${remainingPercent}% remaining (limiting factor: ${limiting.type})`);
        const snapshot: UsageSnapshot = {
          tool: toolId,
          displayName,
          remainingPercent,
          usedPercent: 100 - remainingPercent,
          resetAt,
          limitType: limiting.type,
          breakdown,
          isFreeTier: result.isFreeTier,
          weeklyLimitReached,
          monthlyLimitReached,
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
