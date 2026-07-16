import { QuotaAdapter, UsageSnapshot } from './index.js';
import { TuiScraper, sleep } from '../tmux.js';
import { debug } from '../debug.js';

// ── TUI scraper ────────────────────────────────────────────────────────────

/**
 * Launches `claude` in a tmux session, opens /status, navigates to the
 * Status tab (which shows real quota usage bars), and returns the captured
 * screen text.
 *
 * The Status tab renders persistently (not transient), so regular
 * capture-pane is sufficient — no pipe-pane needed.
 */
async function runClaudeScrape(): Promise<string> {
  const tui = new TuiScraper('env DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 claude');
  try {
    tui.start();

    const CLAUDE_READY  = /Welcome back|Try "|❯/i;
    const CLAUDE_DIALOG = /trust this folder|Update available|terms of service|telemetry|analytics/i;
    const CLAUDE_EITHER = new RegExp(`(?:${CLAUDE_READY.source})|(?:${CLAUDE_DIALOG.source})`, 'i');
    const CLAUDE_STARTUP_MS = 25_000;
    const CLAUDE_DIALOG_SETTLE_MS = 1_000;

    const dialogDeadline = Date.now() + CLAUDE_STARTUP_MS;
    let screen = await tui.waitFor(CLAUDE_EITHER, CLAUDE_STARTUP_MS, 0);

    while (!CLAUDE_READY.test(screen)) {
      if (/Update available/i.test(screen)) {
        debug('claude:scrape', 'Update available prompt detected, sending Down + Enter to skip...');
        tui.sendKey('Down');
        await sleep(200);
        tui.sendKey('Enter');
      } else if (/trust this folder/i.test(screen)) {
        debug('claude:scrape', 'trust folder prompt detected, confirming trust...');
        tui.sendKey('Enter');
      } else if (/terms of service|telemetry|analytics/i.test(screen)) {
        debug('claude:scrape', 'onboarding prompt detected, sending Enter...');
        tui.sendKey('Enter');
      }
      await sleep(CLAUDE_DIALOG_SETTLE_MS);
      const remaining = dialogDeadline - Date.now();
      if (remaining < 500) {
        throw new Error('Claude TUI never reached ready state after dismissing dialogs');
      }
      screen = await tui.waitFor(CLAUDE_EITHER, remaining, 0);
    }

    // Open the /status panel
    tui.send('/status');
    // Wait for the status panel tabs to appear
    const settingsScreen = await tui.waitFor(/Settings\s+Status/i, 10_000, 0);

    // If we are not logged in, we can stop here and return the settings screen
    if (/Auth token:\s*none/i.test(settingsScreen) || /Not logged in/i.test(settingsScreen)) {
      return settingsScreen;
    }

    // Navigate to the Status tab (second tab after Settings)
    tui.sendKey('Tab');
    await sleep(300);
    tui.sendKey('Tab');

    // Wait for the status tab content to render (shows usage bars OR stats like cost/duration)
    screen = await tui.waitFor(/\d+%\s+used|Total cost|Total duration/i, 8_000, 0);

    // If it is still loading usage data, wait for it to finish
    const deadline = Date.now() + 6_000;
    while (
      (screen.includes('Loading usage data') ||
       screen.includes('Scanning local sessions') ||
       screen.includes('Refreshing')) &&
      Date.now() < deadline
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

interface ClaudeScrapeResult {
  sessionUsedPct: number | null;
  sessionResetAt: string | null;
  weeklyUsedPct: number | null;
  weeklyResetAt?: string | null;
  isApiBilling?: boolean;
  isNotLoggedIn?: boolean;
}

function parseScrapeOutput(screen: string): ClaudeScrapeResult {
  debug('claude:parse', `screen length: ${screen.length}`);
  debug('claude:parse', 'screen', screen);

  const isNotLoggedIn = /Auth token:\s*none/i.test(screen) || /Not logged in/i.test(screen);
  const isApiBilling = /API Usage Billing/i.test(screen);

  const lines = screen.split(/\r?\n/).map(l => l.trim());

  let sessionUsedPct: number | null = null;
  let sessionResetAt: string | null = null;
  let weeklyUsedPct: number | null = null;
  let weeklyResetAt: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const usedMatch = line.match(/(\d+)%\s+used/i);
    if (usedMatch) {
      const pct = parseInt(usedMatch[1], 10);
      
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
  public async fetchSnapshots(): Promise<UsageSnapshot[]> {
    return [await this._fetch()];
  }

  private async _fetch(): Promise<UsageSnapshot> {
    const unknown = (): UsageSnapshot => ({
      tool: 'claude-code',
      remainingPercent: null,
      usedPercent: null,
      resetAt: null,
      source: 'unknown',
    });

    debug('claude:fetch', 'starting TUI scrape via tmux');
    try {
      const screen = await runClaudeScrape();
      const result = parseScrapeOutput(screen);

      if (result.isNotLoggedIn) {
        debug('claude:fetch', 'detected not logged in');
        return {
          tool: 'claude-code',
          remainingPercent: null,
          usedPercent: null,
          resetAt: 'not logged in',
          source: 'unknown',
        };
      }

      if (result.isApiBilling) {
        debug('claude:fetch', 'detected API Usage Billing');
        return {
          tool: 'claude-code',
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

        return {
          tool: 'claude-code',
          remainingPercent,
          usedPercent,
          resetAt,
          limitType: limiting.type,
          breakdown: (sessionRemaining !== null && weeklyRemaining !== null) ? {
            fiveHour: sessionRemaining,
            weekly: weeklyRemaining,
          } : undefined,
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
