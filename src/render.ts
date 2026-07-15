import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageSnapshot } from './adapters/index.js';

// ── Constants ──────────────────────────────────────────────────────────────

const BLOCK_CHAR = '█';
export const SHADE_CHAR = '░';
const BAR_WIDTH   = 30;

// ── ANSI colour helpers ────────────────────────────────────────────────────

const R     = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW= '\x1b[33m';
const RED   = '\x1b[31m';
const GRAY  = '\x1b[90m';

// ── Helpers ────────────────────────────────────────────────────────────────

export function getDisplayName(tool: string): string {
  switch (tool) {
    case 'codex':       return 'Codex';
    case 'claude-code': return 'Claude Code';
    case 'agy-gemini':  return 'AGY Gemini';
    case 'agy-other':   return 'AGY Other';
    case 'total':       return 'Total';
    default:            return tool;
  }
}

function pickColour(remaining: number, isLoading?: boolean): string {
  if (isLoading) return CYAN;
  if (remaining < 20) return RED;
  if (remaining < 50) return YELLOW;
  return GREEN;
}

function loadVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, '../package.json'), 'utf8'));
    return ` v${pkg.version}`;
  } catch {
    return '';
  }
}

function formatResetAt(resetAt: string): string {
  if (resetAt.toLowerCase().includes('available')) {
    return `${GREEN}✓ quota available${R}`;
  }
  if (resetAt.toLowerCase().includes('billing active')) {
    return `${GREEN}✓ billing active${R}`;
  }
  if (resetAt.toLowerCase().includes('not logged in')) {
    return `${RED}✗ not logged in${R}`;
  }
  const codexMatch = resetAt.match(/^Resets in\s*(.+)/i);
  if (codexMatch) {
    return `${GRAY}(resets in ${codexMatch[1]})${R}`;
  }
  const agyMatch = resetAt.match(/^Refreshes in\s*(.+)/i);
  if (agyMatch) {
    return `${GRAY}(resets in ${agyMatch[1]})${R}`;
  }
  return `${GRAY}(resets ${resetAt})${R}`;
}

function isEstimate(snap: UsageSnapshot): boolean {
  return snap.source === 'ccusage';
}

// ── Core format (returns string, no newline) ───────────────────────────────

export function formatRow(snap: UsageSnapshot): string {
  const displayName = getDisplayName(snap.tool);
  const remaining   = snap.remainingPercent;

  let barStr: string;
  let percentStr: string;

  if (remaining === null) {
    barStr     = `${GRAY}${SHADE_CHAR.repeat(BAR_WIDTH)}${R}`;
    percentStr = `${GRAY}unknown${R}`;
  } else {
    const colour  = pickColour(remaining, snap.isLoading);
    const filled  = Math.max(0, Math.min(BAR_WIDTH, Math.round((remaining * BAR_WIDTH) / 100)));
    const empty   = BAR_WIDTH - filled;
    barStr     = `${colour}${BLOCK_CHAR.repeat(filled)}${R}${GRAY}${SHADE_CHAR.repeat(empty)}${R}`;
    percentStr = `${BOLD}${colour}${remaining.toString().padStart(3)}% remaining${R}`;
  }

  const parts: string[] = [];

  if (snap.breakdown) {
    parts.push(`${GRAY}(5h: ${snap.breakdown.fiveHour}% | wk: ${snap.breakdown.weekly}%)${R}`);
  } else {
    if (snap.limitType === 'weekly' && snap.tool !== 'agy-gemini' && snap.tool !== 'agy-other') {
      parts.push(`${GRAY}[weekly]${R}`);
    } else if (snap.limitType === 'session' && snap.tool !== 'agy-gemini' && snap.tool !== 'agy-other') {
      parts.push(`${GRAY}[session]${R}`);
    }
  }

  if (snap.resetAt) parts.push(formatResetAt(snap.resetAt));

  if ((snap.tool === 'agy-gemini' || snap.tool === 'agy-other') &&
       snap.raw && typeof snap.raw === 'object') {
    let label = (snap.raw as Record<string, unknown>).matchedModel;
    if (typeof label === 'string' && label) {
      label = label.replace(/\s*-\s*(?:weekly|five\s*hour|5\s*h)\s*limit/i, '');
      parts.push(`${GRAY}[${label}]${R}`);
    }
  }

  if (isEstimate(snap)) {
    parts.push(`${GRAY}[~est]${R}`);
  }

  if (snap.weeklyLimitReached) {
    parts.push(`${RED}⚠️ weekly limit${R}`);
  }

  const detailStr = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  const isTotal = snap.tool === 'total';
  const labelPrefix = isTotal ? `${BOLD}${CYAN}` : BOLD;
  return `${labelPrefix}${displayName.padEnd(13)}${R} [${barStr}] ${percentStr}${detailStr}`;
}

// ── Public render functions ────────────────────────────────────────────────

export function printHeader(): void {
  console.log(`\n${BOLD}${CYAN}⚡️ Agent Fuel - CLI Quota Monitor${R}\n`);
}

export function printRow(snap: UsageSnapshot): void {
  process.stdout.write(formatRow(snap) + '\n');
}

export function printFooter(): void {
  console.log(`\n${GRAY}agent-fuel${loadVersion()}${R}\n`);
}

export const LOADING_LINE = `${GRAY}loading...${R}`;

/** Convenience wrapper — renders a full static dashboard in one call. */
export function renderDashboard(snapshots: UsageSnapshot[]): void {
  printHeader();
  for (const snap of snapshots) printRow(snap);
  printFooter();
}
