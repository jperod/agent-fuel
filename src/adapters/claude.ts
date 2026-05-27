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
  const tui = new TuiScraper('claude');
  try {
    tui.start();

    // Wait for TUI ready — welcome banner or prompt hint visible
    await tui.waitFor(/Welcome back|Try "/i, 15_000, 0);

    // Open the /status panel
    tui.send('/status');
    // Wait for the status panel tabs to appear
    await tui.waitFor(/Settings\s+Status/i, 10_000, 0);

    // Navigate to the Status tab (second tab after Settings)
    tui.sendKey('Tab');
    await sleep(300);
    tui.sendKey('Tab');

    // Wait for the usage bars — shows "XX% used"
    return await tui.waitFor(/\d+%\s+used/i, 8_000, 0);

  } finally {
    tui.kill();
  }
}

// ── Parser ─────────────────────────────────────────────────────────────────

interface ClaudeScrapeResult {
  sessionUsedPct: number | null;
  sessionResetAt: string | null;
  weeklyUsedPct: number | null;
}

function parseScrapeOutput(screen: string): ClaudeScrapeResult {
  debug('claude:parse', `screen length: ${screen.length}`);
  debug('claude:parse', 'screen', screen);

  // Match "XX% used" occurrences in order:
  // First = current session (5h block), second = current week
  const usedMatches = [...screen.matchAll(/(\d+)%\s+used/gi)];
  debug('claude:parse', `found ${usedMatches.length} "% used" matches`);

  const sessionUsedPct = usedMatches[0] ? parseInt(usedMatches[0][1], 10) : null;
  const weeklyUsedPct  = usedMatches[1] ? parseInt(usedMatches[1][1], 10) : null;

  // Reset time: "Resets H:MMam" or "Resets May 30 at 6am" — grab the first occurrence
  const resetMatch = screen.match(/Resets\s+([^\n\r]+)/i);
  const sessionResetAt = resetMatch ? resetMatch[1].trim() : null;

  debug('claude:parse', 'result', { sessionUsedPct, sessionResetAt, weeklyUsedPct });
  return { sessionUsedPct, sessionResetAt, weeklyUsedPct };
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

      if (result.sessionUsedPct !== null) {
        const remainingPercent = Math.max(0, 100 - result.sessionUsedPct);
        debug('claude:fetch', `parsed Usage tab → ${result.sessionUsedPct}% used (${remainingPercent}% remaining)`);
        return {
          tool: 'claude-code',
          remainingPercent,
          usedPercent: result.sessionUsedPct,
          resetAt: result.sessionResetAt,
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
