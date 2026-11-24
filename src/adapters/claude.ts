import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { AccountConfig, getSafeWorkingDir } from '../config.js';

const execFileAsync = promisify(execFile);

interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  planTier?: string;
}

async function checkClaudeAuthStatus(cmd = 'claude', env?: Record<string, string>): Promise<ClaudeAuthStatus | null> {
  const safeCmd = assertSafeCommand(cmd);
  const mergedEnv = resolveEnv(env);
  const cwd = getSafeWorkingDir();
  try {
    let stdout = '';
    try {
      const parts = safeCmd.split(/\s+/);
      const bin = expandTilde(parts[0]);
      const extraArgs = parts.slice(1);
      ({ stdout } = await execFileAsync(bin, [...extraArgs, 'auth', 'status'], {
        cwd,
        env: mergedEnv,
        timeout: 4_000,
        maxBuffer: 256 * 1024,
      }));
    } catch (err) {
      const errObj = err as { code?: string; stdout?: string };
      if (errObj.code === 'ENOENT') {
        const userShell = process.env.SHELL || '/bin/sh';
        const shellCmd = buildInteractiveShellCommand(safeCmd, env, ['auth', 'status']);
        try {
          ({ stdout } = await execFileAsync(userShell, ['-i', '-c', shellCmd], {
            cwd,
            env: mergedEnv,
            timeout: 5_000,
            maxBuffer: 256 * 1024,
          }));
        } catch (shellErr) {
          const shellOut = (shellErr as { stdout?: string }).stdout;
          if (typeof shellOut === 'string' && shellOut.includes('{')) {
            stdout = shellOut;
          } else {
            return null;
          }
        }
      } else if (typeof errObj.stdout === 'string' && errObj.stdout.includes('{')) {
        stdout = errObj.stdout;
      } else {
        return null;
      }
    }

    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return JSON.parse(stdout.slice(start, end + 1)) as ClaudeAuthStatus;
  } catch {
    return null;
  }
}

// ── TUI scraper ────────────────────────────────────────────────────────────

/**
 * Launches `claude` in a tmux session, dismisses any startup prompts
 * (including the trust prompt where "No, exit" may be focused by default),
 * opens /usage, and returns the captured Usage tab text.
 */
async function runClaudeScrape(cmd = 'claude', env?: Record<string, string>): Promise<string> {
  const scrapeEnv: Record<string, string> = {
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    ...env,
  };
  const tui = new TuiScraper(cmd, scrapeEnv);
  try {
    tui.start();

    const CLAUDE_READY  = /Claude Code v[\d.]+|shift\+tab to cycle|Welcome back|Try "/i;
    const CLAUDE_DIALOG = /trust this folder|Quick safety check|Update available|terms of service|telemetry|analytics|Chrome extension|use my browser|browser tools/i;
    const CLAUDE_UNAUTH = /Let's get started|Choose the text style|Select login method|Paste code here/i;
    const CLAUDE_EITHER = new RegExp(`(?:${CLAUDE_READY.source})|(?:${CLAUDE_DIALOG.source})|(?:${CLAUDE_UNAUTH.source})|❯`, 'i');
    const CLAUDE_STARTUP_MS = 25_000;
    const CLAUDE_DIALOG_SETTLE_MS = 800;

    const dialogDeadline = Date.now() + CLAUDE_STARTUP_MS;
    let screen = await tui.waitFor(CLAUDE_EITHER, CLAUDE_STARTUP_MS, 0);

    while (Date.now() < dialogDeadline) {
      if (CLAUDE_UNAUTH.test(screen)) {
        debug('claude:scrape', 'unauthenticated onboarding screen detected');
        return 'NOT_LOGGED_IN';
      } else if (/Update available/i.test(screen)) {
        debug('claude:scrape', 'Update available prompt detected, sending Down + Enter to skip...');
        tui.sendKey('Down');
        await sleep(200);
        tui.sendKey('Enter');
      } else if (/trust this folder|Quick safety check/i.test(screen)) {
        debug('claude:scrape', 'trust folder prompt detected, ensuring Yes is selected...');
        // Allow Ink's input listener time to attach after initial frame render, then verify cursor moved before Enter
        await sleep(300);
        let current = tui.capture(0);
        for (let attempt = 0; attempt < 5; attempt++) {
          if (!/No,\s*exit/i.test(current) || /❯[^\n]*Yes,\s*I trust/i.test(current)) {
            break;
          }
          tui.sendKey('Down');
          await sleep(250);
          current = tui.capture(0);
        }
        if (/❯[^\n]*Yes,\s*I trust/i.test(current) || !/❯[^\n]*No,\s*exit/i.test(current)) {
          tui.sendKey('Enter');
        }
      } else if (/Chrome extension|use my browser|browser tools/i.test(screen)) {
        debug('claude:scrape', 'Chrome extension prompt detected, sending Enter...');
        tui.sendKey('Enter');
      } else if (/terms of service|telemetry|analytics/i.test(screen)) {
        debug('claude:scrape', 'onboarding prompt detected, sending Enter...');
        tui.sendKey('Enter');
      } else if (/shift\+tab to cycle/i.test(screen) && !/trust this folder|Quick safety check|No,\s*exit|Update available/i.test(screen)) {
        debug('claude:scrape', 'Claude prompt is ready');
        break;
      } else if ((CLAUDE_READY.test(screen) || screen.includes('❯')) && !CLAUDE_DIALOG.test(screen) && !/No,\s*exit|Yes,\s*I trust/i.test(screen)) {
        debug('claude:scrape', 'Claude prompt is ready');
        break;
      }
      await sleep(CLAUDE_DIALOG_SETTLE_MS);
      const remaining = dialogDeadline - Date.now();
      if (remaining < 500) {
        throw new Error('Claude TUI never reached ready state after dismissing dialogs');
      }
      screen = await tui.waitFor(CLAUDE_EITHER, remaining, 0);
    }

    // Open the /usage tab directly (avoids relying on /status tab order)
    debug('claude:scrape', 'sending /usage command');
    tui.send('/usage');

    // Wait for either the Usage view or a clear usage/auth marker; submit again if stuck in autocomplete
    const usageReadyPattern = /\d+%\s+used|API Usage Billing|Auth token:\s*none|Not logged in|Failed to load usage/i;
    const usageDeadline = Date.now() + 10_000;
    let retriedEnter = false;
    while (Date.now() < usageDeadline) {
      screen = tui.capture(0);
      if (usageReadyPattern.test(screen)) {
        break;
      }
      if (!retriedEnter && /[❯>]\s*\/usage/i.test(screen)) {
        await sleep(300);
        if (!usageReadyPattern.test(tui.capture(0))) {
          debug('claude:scrape', '/usage still on input prompt — sending Enter again');
          tui.sendKey('Enter');
          retriedEnter = true;
        }
      }
      if (!tui.isAlive()) {
        throw new Error('Claude TUI exited before /usage rendered');
      }
      await sleep(250);
    }

    // If usage data is still refreshing/scanning, allow a short settle window for updated figures
    const settleDeadline = Date.now() + 6_000;
    while (
      (screen.includes('Loading usage data') ||
       screen.includes('Scanning local sessions') ||
       screen.includes('Refreshing')) &&
      Date.now() < settleDeadline
    ) {
      await sleep(200);
      screen = tui.capture(0);
    }

    return screen;

  } finally {
    tui.kill();
  }
}

// ── Parser ─────────────────────────────────────────────────────────────────

/** Convert any 12h am/pm time within a string to 24h (HH:MM). */
function to24h(s: string): string {
  return s.replace(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi,
    (_, h, m, meridiem) => {
      let hour = parseInt(h, 10);
      const min = m ?? '00';
      if (meridiem.toLowerCase() === 'am') {
        if (hour === 12) hour = 0;          // 12am → 00:xx
      } else {
        if (hour !== 12) hour += 12;        // 1–11pm → 13–23
      }
      return `${String(hour).padStart(2, '0')}:${min}`;
    },
  );
}

export interface ClaudeScrapeResult {
  sessionUsedPct: number | null;
  sessionResetAt: string | null;
  weeklyUsedPct: number | null;
  weeklyResetAt?: string | null;
  isApiBilling?: boolean;
  isNotLoggedIn?: boolean;
}

export function parseScrapeOutput(rawScreen: string): ClaudeScrapeResult {
  const screen = stripAnsi(rawScreen);
  debug('claude:parse', `screen length: ${screen.length}`);
  debug('claude:parse', 'screen', screen);

  const isNotLoggedIn = screen === 'NOT_LOGGED_IN' || /Auth token:\s*none|Not logged in/i.test(screen);
  const isApiBilling = /API Usage Billing/i.test(screen);

  const lines = screen.split(/\r?\n/).map(l => l.trim());

  let sessionUsedPct: number | null = null;
  let sessionResetAt: string | null = null;
  let weeklyUsedPct: number | null = null;
  let weeklyResetAt: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const usedMatch = line.match(/([\d.]+)%\s+used/i);
    if (usedMatch) {
      const pct = Math.round(parseFloat(usedMatch[1]));

      let type: 'session' | 'weekly' | null = null;
      for (let j = Math.max(0, i - 3); j < i; j++) {
        if (/Current session/i.test(lines[j])) {
          type = 'session';
          break;
        } else if (/Current week/i.test(lines[j])) {
          type = 'weekly';
          break;
        }
      }

      let resetVal: string | null = null;
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
        const resetMatch = lines[j].match(/Resets\s+([^\n\r]+)/i);
        if (resetMatch) {
          resetVal = to24h(resetMatch[1].trim());
          break;
        }
      }

      if (type === 'session') {
        sessionUsedPct = pct;
        if (resetVal) sessionResetAt = resetVal;
      } else if (type === 'weekly') {
        if (weeklyUsedPct === null || pct > weeklyUsedPct) {
          weeklyUsedPct = pct;
          if (resetVal) weeklyResetAt = resetVal;
        }
      }
    }
  }

  debug('claude:parse', 'result', { sessionUsedPct, sessionResetAt, weeklyUsedPct, weeklyResetAt, isApiBilling, isNotLoggedIn });
  return { sessionUsedPct, sessionResetAt, weeklyUsedPct, weeklyResetAt, isApiBilling, isNotLoggedIn };
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class ClaudeQuotaAdapter implements QuotaAdapter {
  constructor(private readonly account?: AccountConfig) {}

  public async fetchSnapshots(): Promise<UsageSnapshot[]> {
    return [await this._fetch()];
  }

  private async _fetch(): Promise<UsageSnapshot> {
    const toolId = this.account?.id || 'claude-code';
    const displayName = this.account?.displayName || 'Claude Code';
    const cmd = this.account?.command || 'claude';
    const env = this.account?.env;

    const unknown = (): UsageSnapshot => ({
      tool: toolId,
      displayName,
      remainingPercent: null,
      usedPercent: null,
      resetAt: null,
      source: 'unknown',
    });

    debug('claude:fetch', `checking auth and starting TUI scrape for account ${toolId} (${cmd})`);
    try {
      const authStatus = await checkClaudeAuthStatus(cmd, env);
      if (authStatus && authStatus.loggedIn === false) {
        debug('claude:fetch', 'claude auth status reports not logged in');
        return {
          tool: toolId,
          displayName,
          remainingPercent: null,
          usedPercent: null,
          resetAt: 'not logged in',
          source: 'unknown',
        };
      }

      const screen = await runClaudeScrape(cmd, env);
      const result = parseScrapeOutput(screen);

      if (result.isNotLoggedIn) {
        debug('claude:fetch', 'detected not logged in');
        return {
          tool: toolId,
          displayName,
          remainingPercent: null,
          usedPercent: null,
          resetAt: 'not logged in',
          source: 'unknown',
        };
      }

      if (result.isApiBilling || (authStatus?.authMethod === 'apiKey' && result.sessionUsedPct === null && result.weeklyUsedPct === null)) {
        debug('claude:fetch', 'detected API Usage Billing');
        return {
          tool: toolId,
          displayName,
          remainingPercent: 100,
          usedPercent: 0,
          resetAt: 'billing active',
          source: 'official-cli',
        };
      }

      const sessionRemaining = result.sessionUsedPct !== null ? Math.max(0, 100 - result.sessionUsedPct) : null;
      const weeklyRemaining = result.weeklyUsedPct !== null ? Math.max(0, 100 - result.weeklyUsedPct) : null;

      const limits: { pct: number; reset: string | null; type: 'session' | 'weekly' }[] = [];
      if (sessionRemaining !== null) {
        limits.push({ pct: sessionRemaining, reset: result.sessionResetAt, type: 'session' });
      }
      if (weeklyRemaining !== null) {
        limits.push({ pct: weeklyRemaining, reset: result.weeklyResetAt ?? null, type: 'weekly' });
      }

      if (limits.length > 0) {
        limits.sort((a, b) => a.pct - b.pct);
        const limiting = limits[0];

        const remainingPercent = limiting.pct;
        const usedPercent = 100 - remainingPercent;
        const resetAt = limiting.reset;
        const weeklyLimitReached = weeklyRemaining === 0;

        const isFreeTier =
          /Free plan|\(Free\)|Claude Free/i.test(screen) ||
          authStatus?.subscriptionType?.toLowerCase() === 'free' ||
          authStatus?.planTier?.toLowerCase() === 'free';

        return {
          tool: toolId,
          displayName,
          remainingPercent,
          usedPercent,
          resetAt,
          limitType: limiting.type,
          breakdown: (sessionRemaining !== null && weeklyRemaining !== null) ? {
            fiveHour: sessionRemaining,
            weekly: weeklyRemaining,
          } : undefined,
          isFreeTier,
          weeklyLimitReached,
          source: 'official-cli',
        };
      }

      debug('claude:fetch', 'parse failed → unknown');
      return unknown();

    } catch (err) {
      debug('claude:fetch', 'caught error', String(err));
      return unknown();
    }
  }
}
