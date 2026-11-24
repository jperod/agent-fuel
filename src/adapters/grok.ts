import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { QuotaAdapter, UsageSnapshot } from './index.js';
import { TuiScraper, assertSafeCommand, resolveEnv, shellQuote, sleep, stripAnsi } from '../tmux.js';
import { debug } from '../debug.js';
import { AccountConfig, CONFIG_DIR, ensurePrivateDir, getSafeWorkingDir } from '../config.js';

const STALE_CACHE_MAX_MS = 10 * 60 * 1000;
const GROK_STARTUP_MS = 25_000;
const GROK_DIALOG_SETTLE_MS = 1_000;
const GROK_STATUS_TIMEOUT_MS = 15_000;

// Ready patterns for Grok Build TUI:
// Grok Build features a prompt indicator (❯), header, or interactive composer.
const GROK_READY = /❯|Grok Build|What would you like to build\?|\? for shortcuts|grok-4\./i;
// Dialogs: Trust folder prompts, update notices, sign-in/auth requests
const GROK_DIALOG = /Trust this folder|Do you trust|Update available|Sign in|Login to xAI|Authorize|Terms of Service/i;
const GROK_EITHER = new RegExp(`(?:${GROK_READY.source})|(?:${GROK_DIALOG.source})`, 'i');

function cachePath(account?: AccountConfig): string {
  const identity = JSON.stringify([account?.id ?? 'grok', account?.command ?? 'grok', account?.env ?? {}]);
  const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return path.join(CONFIG_DIR, `grok-quota-${key}.json`);
}

async function readLastOfficial(account?: AccountConfig): Promise<UsageSnapshot | null> {
  try {
    const saved = JSON.parse(await fs.readFile(cachePath(account), 'utf8')) as { fetchedAt: number; snapshot: UsageSnapshot };
    if (!Number.isFinite(saved.fetchedAt) || Date.now() - saved.fetchedAt > STALE_CACHE_MAX_MS ||
        !saved.snapshot || saved.snapshot.remainingPercent === null) return null;
    return { ...saved.snapshot, source: 'cache' };
  } catch { return null; }
}

async function saveOfficial(snapshot: UsageSnapshot, account?: AccountConfig): Promise<void> {
  try {
    if (!ensurePrivateDir(CONFIG_DIR)) return;
    const target = cachePath(account);
    await fs.writeFile(target, JSON.stringify({ fetchedAt: Date.now(), snapshot }), { mode: 0o600 });
    await fs.chmod(target, 0o600);
  } catch (err) { debug('grok:cache', 'could not save quota', String(err)); }
}

function isCommandAvailable(cmd: string, env?: Record<string, string>): boolean {
  const safeCmd = assertSafeCommand(cmd);
  const bin = safeCmd.split(/\s+/)[0];
  if (!bin) return false;
  const cwd = getSafeWorkingDir();
  try {
    execFileSync('which', [bin], { cwd, stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    // Also check shell aliases/functions via interactive login shell
    try {
      const userShell = process.env.SHELL || '/bin/sh';
      execFileSync(userShell, ['-i', '-c', `command -v ${shellQuote(bin)}`], {
        cwd,
        stdio: 'ignore',
        timeout: 4000,
        env: resolveEnv(env),
      });
      return true;
    } catch {
      return false;
    }
  }
}

export interface GrokScrapeResult {
  isNotLoggedIn?: boolean;
  quotaReached: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetAt: string | null;
  limitType?: 'session' | 'weekly' | 'monthly' | 'daily';
  sessionRemainingPct?: number | null;
  sessionResetAt?: string | null;
  weeklyRemainingPct?: number | null;
  weeklyResetAt?: string | null;
}

export function parseGrokOutput(raw: string): GrokScrapeResult {
  const clean = stripAnsi(raw);

  debug('grok:parse', 'parsing scrape text', { length: clean.length });

  if (clean === 'NOT_LOGGED_IN' || /Login to xAI|Not logged in|Authentication required/i.test(clean)) {
    return {
      isNotLoggedIn: true,
      quotaReached: false,
      remainingPercent: null,
      usedPercent: null,
      resetAt: 'not logged in',
    };
  }

  // Check for rate limit, quota reached, or spending cap
  if (/quota reached|rate limit reached|usage limit reached|credits depleted|balance exhausted|You(?:'ve)? hit your (?:weekly |daily |monthly )?limit|hit your spending cap/i.test(clean)) {
    const resetMatch = clean.match(/resets?\s+(?:in\s+|at\s+)?([^\n\r)]+)/i);
    const resetAt = resetMatch ? resetMatch[1].trim() : null;
    const limitType: 'weekly' | 'monthly' | 'daily' | 'session' =
      /weekly/i.test(clean) ? 'weekly' :
      /monthly/i.test(clean) ? 'monthly' :
      /daily/i.test(clean) ? 'daily' : 'session';
    debug('grok:parse', 'quota reached detected', { resetAt, limitType });
    return {
      quotaReached: true,
      remainingPercent: 0,
      usedPercent: 100,
      resetAt,
      limitType,
    };
  }

  // 1. Session / rolling limit (e.g., 5h limit or session limit)
  const sessionMatches = [...clean.matchAll(/(?:5h|session|hourly|daily)\s*(?:limit|allowance|pool)?:\s*(?:\[.*?\]\s*)?([\d.]+)%\s*(?:left|remaining)(?:\s*\(resets\s+([^)]+)\))?/gi)];
  const sessionMatch = sessionMatches.at(-1);

  // 2. Weekly / monthly limit
  const weeklyMatches = [...clean.matchAll(/(?:weekly|monthly)\s*(?:limit|allowance|pool)?:\s*(?:\[.*?\]\s*)?([\d.]+)%\s*(?:left|remaining)(?:\s*\(resets\s+([^)]+)\))?/gi)];
  const weeklyMatch = weeklyMatches.at(-1);

  let sessionRemainingPct: number | null = null;
  let sessionResetAt: string | null = null;
  let weeklyRemainingPct: number | null = null;
  let weeklyResetAt: string | null = null;

  if (sessionMatch) {
    sessionRemainingPct = Math.min(100, Math.max(0, Math.round(parseFloat(sessionMatch[1]))));
    sessionResetAt = sessionMatch[2]?.trim() || null;
  }

  if (weeklyMatch) {
    weeklyRemainingPct = Math.min(100, Math.max(0, Math.round(parseFloat(weeklyMatch[1]))));
    weeklyResetAt = weeklyMatch[2]?.trim() || null;
  }

  if (sessionRemainingPct !== null || weeklyRemainingPct !== null) {
    const remainingPercent = sessionRemainingPct !== null && weeklyRemainingPct !== null
      ? Math.min(sessionRemainingPct, weeklyRemainingPct)
      : (sessionRemainingPct ?? weeklyRemainingPct);

    const sessionLimiting = sessionRemainingPct !== null && (weeklyRemainingPct === null || sessionRemainingPct <= weeklyRemainingPct);
    const resetAt = sessionLimiting ? sessionResetAt : weeklyResetAt;
    const limitType: 'session' | 'weekly' = sessionLimiting ? 'session' : 'weekly';

    return {
      quotaReached: remainingPercent === 0,
      remainingPercent,
      usedPercent: remainingPercent !== null ? 100 - remainingPercent : null,
      resetAt,
      limitType,
      sessionRemainingPct,
      sessionResetAt,
      weeklyRemainingPct,
      weeklyResetAt,
    };
  }

  // 3. Generic percent remaining: "75% remaining" or "75% left"
  const genericRemaining = clean.match(/([\d.]+)%\s*(?:remaining|left|allowance)\b/i);
  if (genericRemaining) {
    const pct = Math.min(100, Math.max(0, Math.round(parseFloat(genericRemaining[1]))));
    const resetMatch = clean.match(/(?:resets?|refreshes?)(?:\s+(?:at|in))?\s+([^)\n,]+)/i);
    const resetAt = resetMatch ? resetMatch[1].trim() : null;
    const limitType = /weekly/i.test(clean) ? 'weekly' : /monthly/i.test(clean) ? 'monthly' : 'session';
    return {
      quotaReached: pct === 0,
      remainingPercent: pct,
      usedPercent: 100 - pct,
      resetAt,
      limitType,
    };
  }

  // 4. Generic percent used: "25% used"
  const genericUsed = clean.match(/([\d.]+)%\s*used\b/i);
  if (genericUsed) {
    const used = Math.min(100, Math.max(0, Math.round(parseFloat(genericUsed[1]))));
    const remainingPercent = 100 - used;
    const resetMatch = clean.match(/(?:resets?|refreshes?)(?:\s+(?:at|in))?\s+([^)\n,]+)/i);
    const resetAt = resetMatch ? resetMatch[1].trim() : null;
    const limitType = /weekly/i.test(clean) ? 'weekly' : /monthly/i.test(clean) ? 'monthly' : 'session';
    return {
      quotaReached: remainingPercent === 0,
      remainingPercent,
      usedPercent: used,
      resetAt,
      limitType,
    };
  }

  // 5. Credits remaining format: "Credits: $14.20 / $20.00"
  const creditsRatio = clean.match(/Credits?:\s*\$?([\d.]+)\s*(?:\/|\bout of\b)\s*\$?([\d.]+)/i);
  if (creditsRatio) {
    const current = parseFloat(creditsRatio[1]);
    const total = parseFloat(creditsRatio[2]);
    if (total > 0) {
      const remainingPercent = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
      return {
        quotaReached: remainingPercent === 0,
        remainingPercent,
        usedPercent: 100 - remainingPercent,
        resetAt: null,
        limitType: 'monthly',
      };
    }
  }

  return {
    quotaReached: false,
    remainingPercent: null,
    usedPercent: null,
    resetAt: null,
  };
}

/**
 * Launches `grok` in a tmux session, navigates to `/usage`, and captures the rendered limits.
 */
async function runGrokScrape(cmd = 'grok', env?: Record<string, string>): Promise<string> {
  const tui = new TuiScraper(cmd, env);

  try {
    tui.start();

    const dialogDeadline = Date.now() + GROK_STARTUP_MS;
    let screen = await tui.waitFor(GROK_EITHER, GROK_STARTUP_MS, 0);

    // Allow settle window for background authentication/connection
    const settleDeadline = Date.now() + 2_000;
    while (Date.now() < settleDeadline && !GROK_DIALOG.test(screen)) {
      await sleep(200);
      screen = tui.capture(0);
    }

    // Dismiss blocking dialogs (trust folder, update available)
    while (GROK_DIALOG.test(screen) || !GROK_READY.test(screen)) {
      if (/Sign in|Login to xAI|Authorize/i.test(screen)) {
        return 'NOT_LOGGED_IN';
      } else if (/Trust this folder|Do you trust/i.test(screen)) {
        debug('grok:scrape', 'Trust folder prompt detected — confirming with Enter');
        tui.sendKey('Enter');
      } else if (/Update available/i.test(screen)) {
        debug('grok:scrape', 'Update available dialog detected — skipping');
        tui.sendKey('Down');
        await sleep(200);
        tui.sendKey('Enter');
      } else {
        debug('grok:scrape', 'Dialog detected — pressing Enter to dismiss');
        tui.sendKey('Enter');
      }

      await sleep(GROK_DIALOG_SETTLE_MS);
      const remaining = dialogDeadline - Date.now();
      if (remaining < 500) {
        throw new Error('Grok TUI never reached ready state after dismissing dialogs');
      }
      screen = await tui.waitFor(GROK_EITHER, remaining, 0);
    }

    // Send /usage to query limits
    const sendUsage = async (): Promise<void> => {
      debug('grok:scrape', 'sending /usage command');
      tui.send('/usage');
      await sleep(300);
      tui.sendKey('Enter');
    };

    await sendUsage();
    const deadline = Date.now() + GROK_STATUS_TIMEOUT_MS;
    let retried = false;
    const retryAt = Date.now() + 2_500;

    while (Date.now() < deadline) {
      const rendered = tui.capture(100);
      const parsed = parseGrokOutput(rendered);

      if (parsed.isNotLoggedIn || parsed.quotaReached || parsed.remainingPercent !== null) {
        return rendered;
      }

      // If /usage is still unsubmitted on the input line, hit Enter again
      if (/[❯>]\s*\/usage/i.test(rendered)) {
        debug('grok:scrape', '/usage still on input prompt — sending Enter again');
        tui.sendKey('Enter');
      }

      if (!retried && Date.now() >= retryAt) {
        // Try fallback command /cost if /usage didn't produce quota data
        debug('grok:scrape', 'retrying with /cost command');
        tui.send('/cost');
        await sleep(300);
        tui.sendKey('Enter');
        retried = true;
      }

      await sleep(300);
    }

    throw new Error('Grok /usage did not show quota data within timeout');
  } finally {
    try { tui.kill(); } catch { /* ignore */ }
  }
}

export class GrokQuotaAdapter implements QuotaAdapter {
  constructor(private readonly account?: AccountConfig) {}

  public async fetchSnapshots(): Promise<UsageSnapshot[]> {
    return [await this._fetch()];
  }

  private async _fetch(): Promise<UsageSnapshot> {
    const toolId = this.account?.id || 'grok';
    const displayName = this.account?.displayName || 'Grok Build';
    const cmd = this.account?.command || process.env.GROK_CMD || 'grok';
    const env = this.account?.env;

    const fallback = async (): Promise<UsageSnapshot> => {
      const cached = await readLastOfficial(this.account);
      if (cached) return cached;
      return {
        tool: toolId,
        displayName,
        remainingPercent: null,
        usedPercent: null,
        resetAt: null,
        source: 'unknown',
      };
    };

    if (!isCommandAvailable(cmd, env)) {
      debug('grok:fetch', `CLI command "${cmd}" not found on PATH`);
      return fallback();
    }

    debug('grok:fetch', `starting TUI scrape for account ${toolId} (${cmd})`);
    try {
      const raw = await runGrokScrape(cmd, env);
      const result = parseGrokOutput(raw);

      if (result.isNotLoggedIn) {
        return {
          tool: toolId,
          displayName,
          remainingPercent: null,
          usedPercent: null,
          resetAt: 'not logged in',
          source: 'unknown',
        };
      }

      if (result.remainingPercent !== null) {
        const isFreeTier = /Free plan|\(Free\)|\bFree\b tier/i.test(raw);
        const snapshot: UsageSnapshot = {
          tool: toolId,
          displayName,
          remainingPercent: result.remainingPercent,
          usedPercent: result.usedPercent,
          resetAt: result.resetAt,
          limitType: result.limitType,
          isFreeTier,
          weeklyLimitReached: result.limitType === 'weekly' && result.remainingPercent === 0,
          monthlyLimitReached: result.limitType === 'monthly' && result.remainingPercent === 0,
          source: 'official-cli',
          breakdown: (result.sessionRemainingPct != null || result.weeklyRemainingPct != null) ? {
            fiveHour: result.sessionRemainingPct ?? null,
            weekly: result.weeklyRemainingPct ?? null,
          } : undefined,
        };
        await saveOfficial(snapshot, this.account);
        return snapshot;
      }

      debug('grok:fetch', 'could not parse quota from scrape output, falling back');
      return fallback();
    } catch (err) {
      debug('grok:fetch', 'scrape failed, checking fallback', String(err));
      return fallback();
    }
  }
}
