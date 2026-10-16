import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { QuotaAdapter, UsageSnapshot } from './index.js';
import { TuiScraper, sleep } from '../tmux.js';
import { debug } from '../debug.js';
import { AccountConfig, CONFIG_DIR } from '../config.js';

const STALE_CACHE_MAX_MS = 5 * 60 * 1000; // 5 minutes
const CURSOR_STARTUP_MS = 25_000;
const CURSOR_STATUS_TIMEOUT_MS = 15_000;

// Ready patterns for Cursor Agent TUI
const CURSOR_READY = /→\s*Plan,\s*search,\s*build\s*anything|Cursor\s*Agent|\? for shortcuts|Tip:/i;
const CURSOR_DIALOG = /Trust this folder|Do you trust|Update available|Sign in|Login to Cursor|Terms of Service/i;
const CURSOR_EITHER = new RegExp(`(?:${CURSOR_READY.source})|(?:${CURSOR_DIALOG.source})`, 'i');

function cachePath(account?: AccountConfig): string {
  const identity = JSON.stringify([account?.id ?? 'cursor', account?.command ?? 'cursor-agent', account?.env ?? {}]);
  const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return path.join(CONFIG_DIR, `cursor-quota-${key}.json`);
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
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(cachePath(account), JSON.stringify({ fetchedAt: Date.now(), snapshot }), { mode: 0o600 });
  } catch (err) { debug('cursor:cache', 'could not save quota', String(err)); }
}

function getStoredAccessToken(env?: Record<string, string>): string | null {
  if (env?.CURSOR_API_KEY) return env.CURSOR_API_KEY;
  if (env?.CURSOR_ACCESS_TOKEN) return env.CURSOR_ACCESS_TOKEN;
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  if (process.env.CURSOR_ACCESS_TOKEN) return process.env.CURSOR_ACCESS_TOKEN;

  if (process.platform === 'darwin') {
    try {
      const token = execFileSync('security', [
        'find-generic-password',
        '-s', 'cursor-access-token',
        '-a', 'cursor-user',
        '-w'
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
      if (token && token.length > 10) return token;
    } catch (err) {
      debug('cursor:keychain', 'could not read cursor-access-token from macOS keychain', String(err));
    }
  }
  return null;
}

interface CursorUsageApiResponse {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  planUsage?: {
    remainingBonus?: boolean;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  };
  spendLimitUsage?: {
    limitType?: string;
  };
  enabled?: boolean;
}

function fetchCurrentPeriodUsageApi(token: string): Promise<CursorUsageApiResponse> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({});
    const req = https.request('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'connect-protocol-version': '1',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 6000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body) as CursorUsageApiResponse);
          } catch (e) {
            reject(new Error(`Failed to parse Cursor API JSON: ${e}`));
          }
        } else {
          reject(new Error(`Cursor API HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Cursor API request timed out'));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function formatBillingDate(millisStr?: string): string {
  if (!millisStr) return 'weekly';
  const millis = Number(millisStr);
  if (!Number.isFinite(millis) || millis <= 0) return 'weekly';
  const date = new Date(millis);
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  } catch {
    return date.toISOString().slice(5, 10);
  }
}

async function runCursorScrape(cmd = 'cursor-agent', env?: Record<string, string>): Promise<string> {
  const tui = new TuiScraper(cmd, env, 200, 50);
  try {
    tui.start();

    const dialogDeadline = Date.now() + CURSOR_STARTUP_MS;
    let screen = await tui.waitFor(CURSOR_EITHER, CURSOR_STARTUP_MS, 0);

    while (Date.now() < dialogDeadline) {
      if (/Trust this folder|Do you trust/i.test(screen)) {
        debug('cursor:scrape', 'Trust folder prompt detected — sending Enter');
        tui.sendKey('Enter');
        await sleep(500);
      } else if (/Update available/i.test(screen)) {
        debug('cursor:scrape', 'Update prompt detected — sending Enter');
        tui.sendKey('Enter');
        await sleep(500);
      } else if (CURSOR_READY.test(screen)) {
        debug('cursor:scrape', 'Cursor prompt is ready');
        break;
      }
      await sleep(500);
      const remaining = dialogDeadline - Date.now();
      if (remaining < 500) break;
      screen = await tui.waitFor(CURSOR_EITHER, remaining, 0);
    }

    // Send /usage and Enter
    debug('cursor:scrape', 'Sending /usage to open usage view');
    tui.send('/usage');
    await sleep(400);
    tui.sendKey('Enter');

    // Wait for the usage modal
    const usagePattern = /Usage\s*•|Monthly plan and on-demand|Category\s+Current\s+Usage/i;
    screen = await tui.waitFor(usagePattern, CURSOR_STATUS_TIMEOUT_MS, 500);
    return screen;
  } finally {
    tui.kill();
  }
}

function parseScrapedScreen(screen: string, account?: AccountConfig): UsageSnapshot {
  // Pattern 1: "Included X% used"
  const includedMatch = screen.match(/Included\s+([0-9.]+)%\s+used/i);
  let remaining: number | null = null;
  let used: number | null = null;
  if (includedMatch) {
    used = parseFloat(includedMatch[1]);
    remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
  }

  // Pattern 2: "Resets <Date>"
  const resetMatch = screen.match(/Resets\s+([A-Za-z]+\s+\d+)/i);
  const resetAt = resetMatch ? resetMatch[1] : null;

  return {
    tool: account?.id ?? 'cursor',
    displayName: account?.displayName ?? 'Cursor Agent',
    remainingPercent: remaining,
    usedPercent: used,
    resetAt,
    limitType: 'weekly',
    source: 'official-cli',
  };
}

export class CursorQuotaAdapter implements QuotaAdapter {
  constructor(private readonly account?: AccountConfig) {}

  async fetchSnapshots(): Promise<UsageSnapshot[]> {
    // 1. Try memory/disk cache
    const cached = await readLastOfficial(this.account);
    if (cached) return [cached];

    const cmd = this.account?.command ?? 'cursor-agent';
    const env = this.account?.env;

    // 2. Try fast direct Connect API if token is present
    const token = getStoredAccessToken(env);
    if (token) {
      try {
        debug('cursor:api', 'attempting fast Connect API query');
        const apiRes = await fetchCurrentPeriodUsageApi(token);
        const used = apiRes.planUsage?.totalPercentUsed ?? 0;
        const remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
        const resetAt = formatBillingDate(apiRes.billingCycleEnd);

        const snapshot: UsageSnapshot = {
          tool: this.account?.id ?? 'cursor',
          displayName: this.account?.displayName ?? 'Cursor Agent',
          remainingPercent: remaining,
          usedPercent: used,
          resetAt,
          limitType: 'weekly',
          source: 'provider-api',
          raw: apiRes
        };

        await saveOfficial(snapshot, this.account);
        return [snapshot];
      } catch (err) {
        debug('cursor:api', 'API query failed, falling back to TUI scraper', String(err));
      }
    }

    // 3. Fallback to TUI Scraper in tmux
    try {
      debug('cursor:tui', 'starting TUI scraper for cursor-agent');
      const screen = await runCursorScrape(cmd, env);
      const snapshot = parseScrapedScreen(screen, this.account);

      if (snapshot.remainingPercent !== null) {
        await saveOfficial(snapshot, this.account);
      }

      return [snapshot];
    } catch (err) {
      debug('cursor:scrape', 'TUI scrape failed', String(err));
      return [{
        tool: this.account?.id ?? 'cursor',
        displayName: this.account?.displayName ?? 'Cursor Agent',
        remainingPercent: null,
        usedPercent: null,
        resetAt: null,
        limitType: 'weekly',
        source: 'unknown',
        raw: { error: String(err) }
      }];
    }
  }
}
