import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { QuotaAdapter, UsageSnapshot } from './index.js';
import {
  TuiScraper,
  assertSafeCommand,
  buildInteractiveShellCommand,
  expandTilde,
  resolveEnv,
  sleep,
  stripAnsi,
} from '../tmux.js';
import { debug } from '../debug.js';
import { AccountConfig, CONFIG_DIR, ensurePrivateDir, getSafeWorkingDir } from '../config.js';

const execFileAsync = promisify(execFile);

// Used ONLY as a rough fallback estimate when live engines and cache cannot determine
// a percentage. This is a GUESS based on local session cost data — not an
// official Codex quota signal. Override with AGENT_FUEL_CODEX_BUDGET env var.
const DEFAULT_BUDGET_USD = 20.0;
const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000;
const STALE_CACHE_MAX_MS = 60 * 60 * 1000;
const APP_SERVER_TIMEOUT_MS = 7_000;

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
    if (!ensurePrivateDir(CONFIG_DIR)) return;
    const target = cachePath(account);
    await fs.writeFile(target, JSON.stringify({ fetchedAt: Date.now(), snapshot }), { mode: 0o600 });
    await fs.chmod(target, 0o600);
  } catch (err) { debug('codex:cache', 'could not save quota', String(err)); }
}

// ── App-server JSON-RPC engine (primary for Codex 0.x+) ────────────────────

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

export interface CodexRateLimitsResponse {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: CodexRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot | undefined> | null;
}

export interface CodexAccountResponse {
  account?: {
    type?: string;
    email?: string;
    planType?: string;
  } | null;
  requiresOpenaiAuth?: boolean;
}

function classifyWindowDuration(mins: number | null | undefined): 'session' | 'daily' | 'weekly' | 'monthly' {
  if (typeof mins !== 'number' || !Number.isFinite(mins)) return 'session';
  if (mins <= 360) return 'session';
  if (mins <= 1500) return 'daily';
  if (mins <= 10_500) return 'weekly';
  return 'monthly';
}

export function formatCodexResetEpoch(resetsAtSec: number | null | undefined, nowMs = Date.now()): string | null {
  if (typeof resetsAtSec !== 'number' || !Number.isFinite(resetsAtSec) || resetsAtSec <= 0) return null;
  const resetMs = resetsAtSec * 1000;
  const d = new Date(resetMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const diffMs = resetMs - nowMs;
  if (diffMs <= 24 * 60 * 60 * 1000) {
    return `${hh}:${mm}`;
  }
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${hh}:${mm} on ${d.getDate()} ${monthNames[d.getMonth()]}`;
}

export function buildSnapshotFromCodexAppServer(
  rateRes: CodexRateLimitsResponse,
  accountRes: CodexAccountResponse | null,
  account?: AccountConfig,
  nowMs = Date.now(),
): UsageSnapshot | null {
  const toolId = account?.id || 'codex';
  const displayName = account?.displayName || 'Codex';

  const primaryBucket = rateRes.rateLimitsByLimitId?.codex ?? rateRes.rateLimits;
  if (!primaryBucket) return null;

  const limits: CodexLimit[] = [];
  for (const win of [primaryBucket.primary, primaryBucket.secondary]) {
    if (!win || typeof win.usedPercent !== 'number') continue;
    const type = classifyWindowDuration(win.windowDurationMins);
    const pct = Math.max(0, Math.min(100, Math.round(100 - win.usedPercent)));
    const resetAt = formatCodexResetEpoch(win.resetsAt, nowMs);
    limits.push({ name: type, type, pct, resetAt });
  }

  if (limits.length === 0) return null;

  const sortedLimits = [...limits].sort((a, b) => a.pct - b.pct);
  const limiting = sortedLimits[0];

  const remainingPercent = limiting.pct;
  const resetAt = limiting.resetAt;
  const weeklyLimitReached = limits.some(l => l.type === 'weekly' && l.pct === 0);
  const monthlyLimitReached = limits.some(l => l.type === 'monthly' && l.pct === 0);

  const fiveHour = limits.find(l => l.type === 'session')?.pct ?? null;
  const weekly = limits.find(l => l.type === 'weekly')?.pct ?? null;
  const monthly = limits.find(l => l.type === 'monthly')?.pct ?? null;

  let breakdown: UsageSnapshot['breakdown'] = undefined;
  if (fiveHour !== null && weekly !== null) {
    breakdown = { fiveHour, weekly };
  } else if (fiveHour !== null && monthly !== null) {
    breakdown = { fiveHour, monthly };
  } else if (weekly !== null && monthly !== null) {
    breakdown = { weekly, monthly };
  }

  const plan = (primaryBucket.planType ?? accountRes?.account?.planType ?? '').toLowerCase();
  const isFreeTier = plan === 'free';

  return {
    tool: toolId,
    displayName,
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    resetAt,
    limitType: limiting.type,
    breakdown,
    isFreeTier,
    weeklyLimitReached,
    monthlyLimitReached,
    source: 'official-cli',
  };
}

type CodexAppServerResult =
  | { kind: 'ok'; snapshot: UsageSnapshot }
  | { kind: 'not-logged-in' }
  | { kind: 'unavailable'; reason: string };

async function fetchViaCodexAppServer(cmd = 'codex', env?: Record<string, string>): Promise<CodexAppServerResult> {
  const safeCmd = assertSafeCommand(cmd);
  const mergedEnv = resolveEnv(env);
  const cwd = getSafeWorkingDir();

  const runRpc = (useShell: boolean): Promise<CodexAppServerResult> => new Promise((resolve) => {
    let settled = false;
    const child: ChildProcessWithoutNullStreams = (() => {
      if (!useShell) {
        const parts = safeCmd.split(/\s+/);
        const bin = expandTilde(parts[0]);
        return spawn(bin, [...parts.slice(1), 'app-server'], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: mergedEnv,
        });
      }
      const userShell = process.env.SHELL || '/bin/sh';
      const shellCmd = buildInteractiveShellCommand(safeCmd, env, ['app-server']);
      return spawn(userShell, ['-i', '-c', shellCmd], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: mergedEnv,
      });
    })();

    const finish = (res: CodexAppServerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(res);
    };

    const timer = setTimeout(() => {
      finish({ kind: 'unavailable', reason: 'codex app-server timeout' });
    }, APP_SERVER_TIMEOUT_MS);

    let buf = '';
    let accountRes: CodexAccountResponse | null = null;
    let rateRes: CodexRateLimitsResponse | null = null;
    let sawAuthError = false;

    const tryComplete = () => {
      if (accountRes && accountRes.account === null && accountRes.requiresOpenaiAuth) {
        finish({ kind: 'not-logged-in' });
        return;
      }
      if (sawAuthError) {
        finish({ kind: 'not-logged-in' });
        return;
      }
      if (rateRes && accountRes) {
        const snap = buildSnapshotFromCodexAppServer(rateRes, accountRes);
        if (snap) {
          finish({ kind: 'ok', snapshot: snap });
        } else {
          finish({ kind: 'unavailable', reason: 'Empty rateLimits in codex app-server response' });
        }
      }
    };

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish({ kind: 'unavailable', reason: code === 'ENOENT' ? 'ENOENT' : String(err) });
    });

    child.on('exit', (code) => {
      if (!settled) {
        finish({ kind: 'unavailable', reason: `codex app-server exited (${code})` });
      }
    });

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          try {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'account/rateLimits/read', params: {} }) + '\n');
          } catch (writeErr) {
            finish({ kind: 'unavailable', reason: String(writeErr) });
          }
        } else if (msg.id === 2) {
          if (msg.result) {
            accountRes = msg.result as CodexAccountResponse;
            tryComplete();
          } else if (msg.error) {
            finish({ kind: 'unavailable', reason: msg.error.message || 'account/read failed' });
          }
        } else if (msg.id === 3) {
          if (msg.result) {
            rateRes = msg.result as CodexRateLimitsResponse;
            tryComplete();
          } else if (msg.error) {
            if (/authentication required|not logged in/i.test(msg.error.message || '')) {
              sawAuthError = true;
              tryComplete();
            } else {
              finish({ kind: 'unavailable', reason: msg.error.message || 'rateLimits/read failed' });
            }
          }
        }
      }
    });

    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'agent-fuel', version: '0.9.3' } },
      }) + '\n');
    } catch (writeErr) {
      finish({ kind: 'unavailable', reason: String(writeErr) });
    }
  });

  const first = await runRpc(false);
  if (first.kind === 'unavailable' && first.reason === 'ENOENT') {
    return runRpc(true);
  }
  return first;
}

// ── TUI scraper (tmux fallback) ────────────────────────────────────────────

// Codex may show one or more blocking dialogs before its main screen ("Tip:").
// Known dialogs and their dismissal key ("2" = skip/use existing):
//   • Update nag:      "Update available! x.x → y.y"
//   • New-model intro: "Introducing GPT-5.5"
const CODEX_READY    = /Tip:|Ask Codex to do anything|\? for shortcuts|OpenAI Codex\s*\(v[\d.]+\)/i;
const CODEX_DIALOG   = /Update available|Introducing GPT|Try new model|Use existing model|incompatible feature settings|Run without daemon|Sign in with ChatGPT|Choose how you'd like to sign in/i;
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
  const scrapeEnv: Record<string, string> = {
    CODEX_NON_INTERACTIVE: '1',
    ...env,
  };
  const tui = new TuiScraper(cmd, scrapeEnv);
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
      if (/Sign in with ChatGPT|Choose how you'd like to sign in/i.test(screen)) {
        return 'NOT_LOGGED_IN';
      }
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
      if (parsed.isNotLoggedIn || parsed.quotaReached || (parsed.limits && parsed.limits.length > 0) || parsed.fiveHourRemainingPct !== null || parsed.weeklyRemainingPct != null || parsed.monthlyRemainingPct != null) {
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

export interface CodexScrapeResult {
  isNotLoggedIn?: boolean;
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

export function parseScrapeOutput(raw: string): CodexScrapeResult {
  // Keep this compatible with both rendered tmux text and older ANSI output.
  const clean = stripAnsi(raw);

  if (clean === 'NOT_LOGGED_IN' || /Sign in with ChatGPT|Choose how you'd like to sign in|Not logged in/i.test(clean)) {
    return {
      isNotLoggedIn: true,
      quotaReached: false,
      resetIn: null,
      limits: [],
      isFreeTier: false,
      fiveHourRemainingPct: null,
      fiveHourResetAt: null,
    };
  }

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

  // Parse "/status" panel lines (using the latest /status block if /status was sent twice)
  const lastStatusIdx = clean.lastIndexOf('/status');
  const relevantSection = lastStatusIdx !== -1 ? clean.slice(lastStatusIdx) : clean;

  const allLimitMatches = [
    ...relevantSection.matchAll(/(?:^|[\r\n])[^\S\r\n]*([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*?)\s*limit:\s*(?:\[.*?\]\s*)?(\d+)\s*%\s*(?:left|remaining)(?:\s*\(resets\s+([^)]+)\))?/gi),
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

      const existing = limitsByType.get(type);
      const isPrimaryLabel = /^(5h|5-hour|session|weekly|monthly|daily)$/.test(rawName);
      // Prefer the primary limit or lowest remaining percentage rather than overwriting with a higher model-specific sub-limit
      if (!existing || isPrimaryLabel || pct < existing.pct) {
        limitsByType.set(type, {
          name: rawName,
          type,
          pct,
          resetAt,
        });
      }
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
    const cwd = getSafeWorkingDir();
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('npx', ['--no-install', 'ccusage', 'codex', 'session', '--json'], { cwd, timeout: 5_000 }));
    } catch {
      try {
        ({ stdout } = await execFileAsync('npx', ['--no-install', '@ccusage/codex', 'session', '--json'], { cwd, timeout: 5_000 }));
      } catch (err) {
        debug('codex:ccusage', 'ccusage exec failed', String(err));
        return unknown();
      }
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

    debug('codex:fetch', `querying codex app-server for account ${toolId} (${cmd})`);
    const rpcRes = await fetchViaCodexAppServer(cmd, env);
    if (rpcRes.kind === 'not-logged-in') {
      debug('codex:fetch', 'app-server reports not logged in');
      return {
        tool: toolId,
        displayName,
        remainingPercent: null,
        usedPercent: null,
        resetAt: 'not logged in',
        source: 'unknown',
      };
    }
    if (rpcRes.kind === 'ok') {
      const snapshot: UsageSnapshot = {
        ...rpcRes.snapshot,
        tool: toolId,
        displayName,
      };
      await saveOfficial(snapshot, this.account);
      return snapshot;
    }

    debug('codex:fetch', `app-server unavailable (${rpcRes.reason}) → falling back to tmux TUI scrape`);
    try {
      const raw = await runCodexScrape(cmd, env);
      const result = parseScrapeOutput(raw);

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
