import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { QuotaAdapter, UsageSnapshot } from './index.js';
import { TuiScraper, sleep, stripAnsi } from '../tmux.js';
import { debug } from '../debug.js';
import { AccountConfig, CONFIG_DIR, ensurePrivateDir } from '../config.js';

const STALE_CACHE_MAX_MS = 5 * 60 * 1000; // 5 minutes
const CURSOR_STARTUP_MS = 25_000;
const CURSOR_STATUS_TIMEOUT_MS = 15_000;

// Ready patterns for Cursor Agent TUI
const CURSOR_READY = /→\s*Plan,\s*search,\s*build\s*anything|Cursor\s*Agent|\? for shortcuts|Tip:/i;
const CURSOR_DIALOG = /Trust this folder|Trust this workspace|Do you trust|Update available|Sign in|Login to Cursor|Terms of Service/i;
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
    // Refresh legacy provider-api cache entries that predate GetPlanInfo Free-tier detection
    if (saved.snapshot.source === 'provider-api' && typeof saved.snapshot.isFreeTier !== 'boolean') {
      return null;
    }
    return { ...saved.snapshot, source: 'cache' };
  } catch { return null; }
}

async function saveOfficial(snapshot: UsageSnapshot, account?: AccountConfig): Promise<void> {
  try {
    if (!ensurePrivateDir(CONFIG_DIR)) return;
    const target = cachePath(account);
    await fs.writeFile(target, JSON.stringify({ fetchedAt: Date.now(), snapshot }), { mode: 0o600 });
    await fs.chmod(target, 0o600);
  } catch (err) { debug('cursor:cache', 'could not save quota', String(err)); }
}

interface StoredToken {
  token: string;
  fromKeychain: boolean;
}

function getStoredAccessToken(env?: Record<string, string>): StoredToken | null {
  if (env?.CURSOR_API_KEY) return { token: env.CURSOR_API_KEY, fromKeychain: false };
  if (env?.CURSOR_ACCESS_TOKEN) return { token: env.CURSOR_ACCESS_TOKEN, fromKeychain: false };
  if (process.env.CURSOR_API_KEY) return { token: process.env.CURSOR_API_KEY, fromKeychain: false };
  if (process.env.CURSOR_ACCESS_TOKEN) return { token: process.env.CURSOR_ACCESS_TOKEN, fromKeychain: false };

  if (process.platform === 'darwin') {
    try {
      const token = execFileSync('security', [
        'find-generic-password',
        '-s', 'cursor-access-token',
        '-a', 'cursor-user',
        '-w'
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
      if (token && token.length > 10) return { token, fromKeychain: true };
    } catch (err) {
      debug('cursor:keychain', 'could not read cursor-access-token from macOS keychain', String(err));
    }
  }
  return null;
}

/**
 * Validates `CURSOR_API_ENDPOINT` before transmitting Bearer tokens.
 * Rejects non-HTTPS URLs unconditionally, and prevents macOS Keychain tokens or
 * ambient process env overrides from sending credentials to non-Cursor domains.
 */
export function resolveCursorEndpoint(
  rawEndpoint?: string,
  options: { fromKeychain?: boolean; fromAccountConfig?: boolean } = {},
): string {
  const value = rawEndpoint?.trim() || 'https://api2.cursor.sh';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid CURSOR_API_ENDPOINT URL: ${value}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`CURSOR_API_ENDPOINT must use https:// (got ${url.protocol})`);
  }
  const host = url.hostname.toLowerCase();
  const isOfficialCursorHost =
    host === 'api2.cursor.sh' ||
    host.endsWith('.cursor.sh') ||
    host.endsWith('.cursor.com');

  if (!isOfficialCursorHost) {
    if (options.fromKeychain) {
      throw new Error(`Refusing to send Keychain token to non-Cursor host: ${host}`);
    }
    if (!options.fromAccountConfig) {
      throw new Error(`Refusing ambient CURSOR_API_ENDPOINT to non-Cursor host: ${host}`);
    }
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export interface CursorUsageApiResponse {
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

export interface CursorPlanInfoApiResponse {
  planInfo?: {
    planName?: string;
    price?: string;
    billingCycleEnd?: string;
    includedUsagePeriod?: string;
    includedUsageResetsAt?: string;
  };
}

function callDashboardService<T>(endpoint: string, method: string, token: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const base = endpoint.replace(/\/+$/, '');
    const data = JSON.stringify({});
    const req = https.request(`${base}/aiserver.v1.DashboardService/${method}`, {
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
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(new Error(`Failed to parse Cursor ${method} JSON: ${e}`));
          }
        } else {
          reject(new Error(`Cursor ${method} HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Cursor ${method} request timed out`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function formatBillingDate(millisStr?: string): string | null {
  if (!millisStr) return null;
  const millis = Number(millisStr);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const date = new Date(millis);
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  } catch {
    return date.toISOString().slice(5, 10);
  }
}

export function buildCursorApiSnapshot(
  usageRes: CursorUsageApiResponse,
  planRes?: CursorPlanInfoApiResponse | null,
  account?: AccountConfig,
): UsageSnapshot {
  const used = usageRes.planUsage?.totalPercentUsed ?? 0;
  const remaining = Math.max(0, Math.min(100, Math.round(100 - used)));

  const planName = planRes?.planInfo?.planName?.trim() || '';
  const price = planRes?.planInfo?.price?.trim() || '';
  const isFreeTier = /^free$/i.test(planName) || /^free$/i.test(price);

  const includedPeriod = planRes?.planInfo?.includedUsagePeriod;
  let limitType: 'weekly' | 'monthly' = 'weekly';
  if (includedPeriod === 'INCLUDED_USAGE_PERIOD_MONTHLY') {
    limitType = 'monthly';
  } else if (includedPeriod === 'INCLUDED_USAGE_PERIOD_WEEKLY') {
    limitType = 'weekly';
  } else if (usageRes.billingCycleStart && usageRes.billingCycleEnd) {
    const startMs = Number(usageRes.billingCycleStart);
    const endMs = Number(usageRes.billingCycleEnd);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      limitType = (endMs - startMs) <= 8 * 86_400_000 ? 'weekly' : 'monthly';
    }
  }

  const resetAt = formatBillingDate(planRes?.planInfo?.includedUsageResetsAt || usageRes.billingCycleEnd) ?? limitType;

  return {
    tool: account?.id ?? 'cursor',
    displayName: account?.displayName ?? 'Cursor Agent',
    remainingPercent: remaining,
    usedPercent: used,
    resetAt,
    limitType,
    isFreeTier,
    weeklyLimitReached: limitType === 'weekly' && remaining === 0,
    monthlyLimitReached: limitType === 'monthly' && remaining === 0,
    source: 'provider-api',
    raw: planRes ? { ...usageRes, planInfo: planRes.planInfo } : usageRes,
  };
}

async function runCursorScrape(cmd = 'cursor-agent', env?: Record<string, string>): Promise<string> {
  // Pass --trust when invoking cursor-agent directly so workspace trust dialog is bypassed cleanly
  const extraArgs = /\b(?:cursor-agent|agent)\b/.test(cmd) && !/--trust\b/.test(cmd)
    ? ['--trust']
    : [];
  const tui = new TuiScraper(cmd, env, 200, 50, extraArgs);
  try {
    tui.start();

    const dialogDeadline = Date.now() + CURSOR_STARTUP_MS;
    let screen = await tui.waitFor(CURSOR_EITHER, CURSOR_STARTUP_MS, 0);

    while (Date.now() < dialogDeadline) {
      if (/Sign in|Login to Cursor/i.test(screen)) {
        return 'NOT_LOGGED_IN';
      } else if (/Trust this folder|Trust this workspace|Do you trust/i.test(screen)) {
        debug('cursor:scrape', 'Trust workspace prompt detected — sending "a"');
        tui.sendKey('a');
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

export function parseScrapedScreen(rawScreen: string, account?: AccountConfig): UsageSnapshot {
  const screen = stripAnsi(rawScreen);
  if (screen === 'NOT_LOGGED_IN' || /Sign in|Login to Cursor|Not logged in/i.test(screen)) {
    return {
      tool: account?.id ?? 'cursor',
      displayName: account?.displayName ?? 'Cursor Agent',
      remainingPercent: null,
      usedPercent: null,
      resetAt: 'not logged in',
      source: 'unknown',
    };
  }

  // Pattern 1: "Included X% used"
  const includedMatch = screen.match(/Included\s+([0-9.]+)%\s+used/i);
  let remaining: number | null = null;
  let used: number | null = null;
  if (includedMatch) {
    used = parseFloat(includedMatch[1]);
    remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
  }

  // Pattern 2: "Resets 27 Nov" or "Resets Nov 27"
  const resetMatch = screen.match(/Resets\s+(\d+\s+[A-Za-z]+|[A-Za-z]+\s+\d+)/i);
  const resetAt = resetMatch ? resetMatch[1] : null;
  const isFreeTier = /Usage\s*•\s*Free|Free plan|Hobby|\(Free\)/i.test(screen);
  const limitType: 'weekly' | 'monthly' = isFreeTier ? 'weekly' : 'monthly';

  return {
    tool: account?.id ?? 'cursor',
    displayName: account?.displayName ?? 'Cursor Agent',
    remainingPercent: remaining,
    usedPercent: used,
    resetAt,
    limitType,
    isFreeTier,
    weeklyLimitReached: limitType === 'weekly' && remaining === 0,
    monthlyLimitReached: limitType === 'monthly' && remaining === 0,
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
    const configEndpoint = env?.CURSOR_API_ENDPOINT;
    const rawEndpoint = configEndpoint || process.env.CURSOR_API_ENDPOINT;

    // 2. Try fast direct Connect API if token is present
    const stored = getStoredAccessToken(env);
    if (stored) {
      try {
        const endpoint = resolveCursorEndpoint(rawEndpoint, {
          fromKeychain: stored.fromKeychain,
          fromAccountConfig: Boolean(configEndpoint),
        });
        debug('cursor:api', 'attempting fast Connect API query');
        const [usageSettled, planSettled] = await Promise.allSettled([
          callDashboardService<CursorUsageApiResponse>(endpoint, 'GetCurrentPeriodUsage', stored.token),
          callDashboardService<CursorPlanInfoApiResponse>(endpoint, 'GetPlanInfo', stored.token),
        ]);

        if (usageSettled.status === 'fulfilled') {
          const planRes = planSettled.status === 'fulfilled' ? planSettled.value : null;
          const snapshot = buildCursorApiSnapshot(usageSettled.value, planRes, this.account);
          await saveOfficial(snapshot, this.account);
          return [snapshot];
        }
        throw usageSettled.reason;
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
