import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  agyCachePath,
  parseAgyJsonOutput,
  parseQuotaPanel,
  buildSnapshots,
  formatAgyResetTime,
} from '../dist/adapters/agy.js';
import { parseScrapeOutput as parseClaudeOutput } from '../dist/adapters/claude.js';
import {
  parseScrapeOutput as parseCodexOutput,
  buildSnapshotFromCodexAppServer,
  formatCodexResetEpoch,
} from '../dist/adapters/codex.js';
import {
  buildCursorApiSnapshot,
  parseScrapedScreen as parseCursorScreen,
  resolveCursorEndpoint,
} from '../dist/adapters/cursor.js';
import { parseGrokOutput } from '../dist/adapters/grok.js';
import {
  ensurePrivateDir,
  isSafeCommandString,
  isValidAccountId,
  isValidEnvKey,
  redactEnv,
} from '../dist/config.js';
import { redactSecrets } from '../dist/debug.js';
import { formatRow } from '../dist/render.js';
import {
  buildInteractiveShellCommand,
  sanitizeTerminalText,
  stripAnsi as stripTerminalAnsi,
} from '../dist/tmux.js';
import { isNewer, isValidSemver } from '../dist/update.js';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── AGY ────────────────────────────────────────────────────────────────────

test('AGY JSON parser handles 2-group layout with Argon merged into Gemini Models', () => {
  const now = Date.parse('2026-11-24T15:00:00Z');
  const payload = JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash',
            buckets: [
              { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.8643847, reset_time: '2026-12-01T11:00:00Z' },
              { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.503982, reset_time: '2026-11-24T17:00:00Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
            buckets: [
              { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-11-28T10:00:00Z' },
              { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
            ],
          },
        ],
      },
    },
  });

  const entries = parseAgyJsonOutput(payload, now);
  assert.equal(entries.length, 4);

  const snaps = buildSnapshots(entries, false);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].tool, 'agy-gemini');
  assert.equal(snaps[0].displayName, 'AGY ╭ Gemini');
  assert.equal(snaps[0].remainingPercent, 50);
  assert.deepEqual(snaps[0].breakdown, { fiveHour: 50, weekly: 86 });
  assert.equal(snaps[0].resetAt, 'Refreshes in 2h 0m');

  assert.equal(snaps[1].tool, 'agy-other');
  assert.equal(snaps[1].displayName, '    ╰ Other');
  assert.equal(snaps[1].remainingPercent, 50);
  assert.deepEqual(snaps[1].breakdown, { fiveHour: 100, weekly: 50 });
  assert.equal(snaps[1].resetAt, 'Refreshes in 91h 0m');
});

test('AGY reset time helper handles epoch zero full quota and expired reset times', () => {
  const now = Date.parse('2026-11-24T15:00:00Z');
  assert.equal(formatAgyResetTime('1970-01-01T00:00:00Z', 100, now), 'Quota available');
  assert.equal(formatAgyResetTime(undefined, 100, now), 'Quota available');
  assert.equal(formatAgyResetTime('2026-11-24T15:45:00Z', 75, now), 'Refreshes in 45m');
});

test('AGY TUI parser handles 2-group panel and dynamically includes Argon only if reported', () => {
  const twoGroupScreen = `
└ Models & Quota
  Account: user@example.com

GEMINI MODELS
  Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen

  Weekly Limit Remaining
    [█████████████████████] 86.47%
    Refreshes in 164h 52m

  Five Hour Limit Remaining
    [██████████░░░░░░░░░░] 50.39%
    Refreshes in 1h 52m

CLAUDE AND GPT MODELS
  Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B

  Weekly Limit Remaining
    [██████████░░░░░░░░░░] 50.00%
    Refreshes in 91h 28m

  Five Hour Limit Remaining
    [████████████████████] 100.00%
    Quota available
`;

  const twoEntries = parseQuotaPanel(twoGroupScreen);
  const twoSnaps = buildSnapshots(twoEntries, false);
  assert.equal(twoSnaps.length, 2);
  assert.equal(twoSnaps[0].remainingPercent, 50);
  assert.equal(twoSnaps[1].remainingPercent, 50);

  const legacyThreeGroupScreen = twoGroupScreen.replace(
    'CLAUDE AND GPT MODELS',
    `GEMINI 4 ARGON
  Models within this group: Gemini 4 Argon

  Weekly Limit Remaining
    Disabled: weekly quota exhausted

CLAUDE AND GPT MODELS`,
  );
  const threeEntries = parseQuotaPanel(legacyThreeGroupScreen);
  const threeSnaps = buildSnapshots(threeEntries, false);
  assert.equal(threeSnaps.length, 3);
  assert.equal(threeSnaps[1].tool, 'agy-argon');
  assert.equal(threeSnaps[1].remainingPercent, 0);
  assert.equal(threeSnaps[1].weeklyLimitReached, true);
});

// ── Claude Code ────────────────────────────────────────────────────────────

test('Claude parser handles Team /usage output, 24h conversion, and Extra usage isolation', () => {
  const screen = `
  Settings  Status   Config   Usage   Stats

  Current session
  ██████████▌                                        21% used
  Resets 6:39pm (Europe/Copenhagen)

  Current week (all models)
  ██████████████████████████                         52% used
  Resets Nov 28 at 4:59am (Europe/Copenhagen)

  Current week (Fable)
  █████                                              10% used
  Resets Nov 28 at 4:59am (Europe/Copenhagen)

  Extra usage
  ██████████████████████████████████████████████████ 90% used
  Resets Dec 1 at 12:00am (Europe/Copenhagen)
`;
  const res = parseClaudeOutput(screen);
  assert.equal(res.sessionUsedPct, 21);
  assert.equal(res.sessionResetAt, '18:39 (Europe/Copenhagen)');
  assert.equal(res.weeklyUsedPct, 52);
  assert.equal(res.weeklyResetAt, 'Nov 28 at 04:59 (Europe/Copenhagen)');
  assert.equal(res.isApiBilling, false);
  assert.equal(res.isNotLoggedIn, false);
});

test('Claude parser detects API Usage Billing and not logged in states', () => {
  assert.equal(parseClaudeOutput('API Usage Billing enabled').isApiBilling, true);
  assert.equal(parseClaudeOutput('NOT_LOGGED_IN').isNotLoggedIn, true);
  assert.equal(parseClaudeOutput('Auth token: none').isNotLoggedIn, true);
});

// ── Codex CLI ──────────────────────────────────────────────────────────────

test('Codex app-server snapshot builder handles rate limits, free tier, and reset formatting', () => {
  const now = Date.parse('2026-11-24T15:00:00Z');
  const fiveHoursLaterSec = Math.floor((now + 4 * 3600_000) / 1000);
  const fourDaysLaterSec = Math.floor((now + 4 * 86400_000) / 1000);

  const snap = buildSnapshotFromCodexAppServer(
    {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: fiveHoursLaterSec },
        secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: fourDaysLaterSec },
        planType: 'free',
      },
    },
    { account: { type: 'chatgpt', planType: 'free' }, requiresOpenaiAuth: true },
    undefined,
    now,
  );

  assert.ok(snap);
  assert.equal(snap.remainingPercent, 0);
  assert.equal(snap.usedPercent, 100);
  assert.equal(snap.limitType, 'session');
  assert.deepEqual(snap.breakdown, { fiveHour: 0, weekly: 30 });
  assert.equal(snap.isFreeTier, true);
  assert.equal(snap.weeklyLimitReached, false);
  assert.match(snap.resetAt ?? '', /^\d{2}:\d{2}$/);
  assert.match(formatCodexResetEpoch(fourDaysLaterSec, now) ?? '', /^\d{2}:\d{2} on \d+ [A-Z][a-z]{2}$/);
});

test('Codex TUI parser handles /status output, sub-model limits, and quota reached', () => {
  const statusScreen = `
  Account: pedro@example.com (Free)
  /status
  5h limit:            [░░░░░░░░░░░░░░░░░░░░] 0% left (resets 18:58)
  GPT-5.3-Codex-Spark 5h limit: [████████████████████] 100% left (resets 19:58)
  Weekly limit:        [██████░░░░░░░░░░░░░░] 30% left (resets 17:55 on 28 Nov)
`;
  const parsed = parseCodexOutput(statusScreen);
  assert.equal(parsed.isFreeTier, true);
  assert.equal(parsed.fiveHourRemainingPct, 0);
  assert.equal(parsed.weeklyRemainingPct, 30);
  assert.equal(parsed.weeklyResetAt, '17:55 on 28 Nov');

  const reached = parseCodexOutput('Individual quota reached. Resets in 4h33m29s.');
  assert.equal(reached.quotaReached, true);
  assert.equal(reached.resetIn, '4h 33m');
});

// ── Cursor Agent ───────────────────────────────────────────────────────────

test('Cursor API snapshot detects Free weekly plan vs Pro monthly plan', () => {
  const freeSnap = buildCursorApiSnapshot(
    {
      billingCycleStart: '1795166197134',
      billingCycleEnd: '1795770997134',
      planUsage: { totalPercentUsed: 1.69 },
    },
    {
      planInfo: {
        planName: 'Free',
        price: 'Free',
        includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY',
        includedUsageResetsAt: '1795770997134',
      },
    },
  );
  assert.equal(freeSnap.remainingPercent, 98);
  assert.equal(freeSnap.isFreeTier, true);
  assert.equal(freeSnap.limitType, 'weekly');
  assert.equal(freeSnap.resetAt, 'Nov 27');

  const proSnap = buildCursorApiSnapshot(
    {
      billingCycleStart: '1793500000000',
      billingCycleEnd: '1796092000000',
      planUsage: { totalPercentUsed: 100 },
    },
    {
      planInfo: {
        planName: 'Pro',
        price: '$20/mo',
        includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY',
      },
    },
  );
  assert.equal(proSnap.remainingPercent, 0);
  assert.equal(proSnap.isFreeTier, false);
  assert.equal(proSnap.limitType, 'monthly');
  assert.equal(proSnap.monthlyLimitReached, true);
});

test('Cursor TUI parser handles Usage • Free and day-first reset dates', () => {
  const screen = `
  Usage • Free                                      Resets 27 Nov
  Monthly plan and on-demand usage
  Included        2% used             ███░░░░░░░
`;
  const snap = parseCursorScreen(screen);
  assert.equal(snap.remainingPercent, 98);
  assert.equal(snap.isFreeTier, true);
  assert.equal(snap.limitType, 'weekly');
  assert.equal(snap.resetAt, '27 Nov');
});

// ── Grok Build ─────────────────────────────────────────────────────────────

test('Grok parser handles /usage formats, decimal percentages, and weekly/spending limit messages', () => {
  const usageOut = parseGrokOutput('5h limit: 85.4% remaining (resets in 2h)\nWeekly limit: 40% left (resets in 4d)');
  assert.equal(usageOut.remainingPercent, 40);
  assert.equal(usageOut.sessionRemainingPct, 85);
  assert.equal(usageOut.weeklyRemainingPct, 40);
  assert.equal(usageOut.limitType, 'weekly');

  const hitWeekly = parseGrokOutput('You hit your weekly limit. Resets in 3d 4h');
  assert.equal(hitWeekly.quotaReached, true);
  assert.equal(hitWeekly.remainingPercent, 0);
  assert.equal(hitWeekly.limitType, 'weekly');

  const credits = parseGrokOutput('Credits: $14.20 / $20.00');
  assert.equal(credits.remainingPercent, 71);
});

// ── Renderer ───────────────────────────────────────────────────────────────

test('formatRow renders AGY tags, Disabled state, and Free badge cleanly', () => {
  const agyRow = stripAnsi(formatRow({
    tool: 'agy-gemini',
    displayName: 'AGY ╭ Gemini',
    remainingPercent: 50,
    usedPercent: 50,
    resetAt: 'Refreshes in 1h 52m',
    limitType: 'session',
    breakdown: { fiveHour: 50, weekly: 86 },
    source: 'official-cli',
    raw: { matchedModel: 'GEMINI MODELS' },
  }, 15));

  assert.ok(agyRow.includes('AGY ╭ Gemini'));
  assert.ok(agyRow.includes('(5h: 50% | wk: 86%)'));
  assert.ok(agyRow.includes('(resets in 1h 52m)'));
  assert.ok(agyRow.includes('[GEMINI MODELS]'));

  const disabledRow = stripAnsi(formatRow({
    tool: 'agy-argon',
    displayName: '    │ Argon',
    remainingPercent: 0,
    resetAt: 'Disabled: weekly limit exhausted',
    weeklyLimitReached: true,
    source: 'official-cli',
  }, 15));
  assert.ok(disabledRow.includes('(Disabled: weekly limit exhausted)'));
  assert.ok(!disabledRow.includes('(resets Disabled:'));

  const cursorFreeRow = stripAnsi(formatRow({
    tool: 'cursor',
    displayName: 'Cursor Agent',
    remainingPercent: 98,
    resetAt: 'Nov 27',
    limitType: 'weekly',
    isFreeTier: true,
    source: 'provider-api',
  }, 15));
  assert.ok(cursorFreeRow.includes('[weekly] (resets Nov 27) [free]'));
});

// ── Security Hardening ─────────────────────────────────────────────────────

test('config and shell helpers validate identifiers, reject chaining, and mask secrets', () => {
  assert.equal(isValidEnvKey('CLAUDE_CONFIG_DIR'), true);
  assert.equal(isValidEnvKey('FOO;rm -rf /'), false);
  assert.equal(isValidEnvKey('1BAD'), false);

  assert.equal(isValidAccountId('cursor-work'), true);
  assert.equal(isValidAccountId('../etc/passwd'), false);
  assert.equal(isValidAccountId('a/b'), false);

  assert.equal(isSafeCommandString('codex-work --profile dev'), true);
  assert.equal(isSafeCommandString('codex; touch /tmp/pwn'), false);
  assert.equal(isSafeCommandString('codex $(whoami)'), false);

  assert.deepEqual(
    redactEnv({
      CLAUDE_CONFIG_DIR: '~/.claude-personal',
      CURSOR_API_KEY: 'cur_secret_value',
      CURSOR_ACCESS_TOKEN: 'tok_secret_value',
      XAI_API_KEY: 'xai-secret-value',
    }),
    {
      CLAUDE_CONFIG_DIR: '~/.claude-personal',
      CURSOR_API_KEY: '***',
      CURSOR_ACCESS_TOKEN: '***',
      XAI_API_KEY: '***',
    },
  );

  const built = buildInteractiveShellCommand('claude-work', {
    CLAUDE_CONFIG_DIR: '~/.claude-work',
    'BAD;KEY': 'ignored',
  }, ['--flag', 'a b']);
  assert.ok(!built.includes('BAD;KEY'));
  assert.ok(built.includes('CLAUDE_CONFIG_DIR='));
  assert.ok(built.endsWith("claude-work '--flag' 'a b'"));
});

test('Cursor endpoint validation enforces https and protects Keychain/ambient credentials', () => {
  assert.equal(resolveCursorEndpoint(undefined), 'https://api2.cursor.sh');
  assert.equal(
    resolveCursorEndpoint('https://api2.cursor.sh/', { fromKeychain: true }),
    'https://api2.cursor.sh',
  );
  assert.throws(() => resolveCursorEndpoint('http://api2.cursor.sh'), /https:\/\//i);
  assert.throws(
    () => resolveCursorEndpoint('https://evil.example.com', { fromKeychain: true }),
    /non-Cursor host/i,
  );
  assert.throws(
    () => resolveCursorEndpoint('https://evil.example.com', { fromAccountConfig: false }),
    /non-Cursor host/i,
  );
  assert.equal(
    resolveCursorEndpoint('https://cursor-proxy.internal:8443/api/', {
      fromKeychain: false,
      fromAccountConfig: true,
    }),
    'https://cursor-proxy.internal:8443/api',
  );
});

test('AGY cache path hashes account IDs safely against traversal', () => {
  const safePath = agyCachePath({ id: '../../outside', displayName: 'X', type: 'agy', weight: 20 });
  assert.ok(!safePath.includes('..'));
  assert.match(path.basename(safePath), /^agy-quota-[0-9a-f]{16}\.json$/);
});

test('renderer and debug redaction strip OSC/CSI terminal escapes and API tokens', () => {
  const dirty = '50% \x1b]0;pwned-title\x07\x1b[31mred\x1b[0m\r\nnext';
  assert.equal(stripTerminalAnsi(dirty), '50% red\nnext');
  assert.equal(sanitizeTerminalText(dirty), '50% red next');
  assert.equal(sanitizeTerminalText('    ╰ Other\x1b[31m'), '    ╰ Other');

  const row = formatRow({
    tool: 'agy-gemini',
    displayName: 'AGY\x1b]2;evil\x07',
    remainingPercent: 50,
    resetAt: '12:00\x1b[2J',
    source: 'official-cli',
    raw: { matchedModel: 'GEMINI\x07MODEL' },
  }, 15);
  assert.ok(!row.includes('\x1b]2;'));
  assert.ok(!row.includes('\x1b[2J'));

  const redacted = redactSecrets('Authorization: Bearer supersecret12345 XAI_API_KEY=xai-secret-abcdef123456');
  assert.ok(!redacted.includes('supersecret12345'));
  assert.ok(!redacted.includes('xai-secret-abcdef123456'));
  assert.ok(redacted.includes('Bearer ***'));
});

test('ensurePrivateDir rejects symlinks and enforces 0700 on owned directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dir-test-'));
  try {
    const targetDir = path.join(root, 'real');
    fs.mkdirSync(targetDir, { mode: 0o755 });
    const symlinkPath = path.join(root, 'link');
    fs.symlinkSync(targetDir, symlinkPath);

    assert.equal(ensurePrivateDir(symlinkPath), false);

    const ownedDir = path.join(root, 'owned');
    fs.mkdirSync(ownedDir, { mode: 0o755 });
    assert.equal(ensurePrivateDir(ownedDir), true);
    assert.equal(fs.lstatSync(ownedDir).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update semver helpers validate and ignore prerelease targets for stable releases', () => {
  assert.equal(isValidSemver('0.9.3'), true);
  assert.equal(isValidSemver('0.9.4-beta.1'), true);
  assert.equal(isValidSemver('0.9.4\x1b[31m'), false);

  assert.equal(isNewer('0.9.3', '0.9.4'), true);
  assert.equal(isNewer('0.9.3', '0.9.3'), false);
  assert.equal(isNewer('0.9.3', '1.0.0-beta.1'), false);
  assert.equal(isNewer('0.9.3-beta.1', '0.9.3'), true);
});
