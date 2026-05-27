import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageSnapshot } from './adapters/index.js';

// ── Constants ──────────────────────────────────────────────────────────────

const BLOCK_CHAR = '█';
const SHADE_CHAR = '░';
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
    default:            return tool;
  }
}

function pickColour(remaining: number): string {
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
    return `${DIM}${GREEN}✓ quota available${R}`;
  }
  const codexMatch = resetAt.match(/^Resets in\s*(.+)/i);
  if (codexMatch) {
    return `${DIM}${GRAY}(resets in ${codexMatch[1]})${R}`;
  }
  const agyMatch = resetAt.match(/^Refreshes in\s*(.+)/i);
  if (agyMatch) {
    return `${DIM}${GRAY}(resets in ${agyMatch[1]})${R}`;
  }
  return `${DIM}${GRAY}(resets ${resetAt})${R}`;
}

function isEstimate(snap: UsageSnapshot): boolean {
  return snap.source === 'ccusage' &&
    typeof snap.raw === 'object' && snap.raw !== null &&
    (snap.raw as Record<string, unknown>).isEstimate === true;
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
    const colour  = pickColour(remaining);
    const filled  = Math.max(0, Math.min(BAR_WIDTH, Math.round((remaining * BAR_WIDTH) / 100)));
    const empty   = BAR_WIDTH - filled;
    barStr     = `${colour}${BLOCK_CHAR.repeat(filled)}${R}${GRAY}${SHADE_CHAR.repeat(empty)}${R}`;
    percentStr = `${BOLD}${colour}${remaining.toString().padStart(3)}% remaining${R}`;
  }

  const parts: string[] = [];

  if (snap.resetAt) parts.push(formatResetAt(snap.resetAt));

  if ((snap.tool === 'agy-gemini' || snap.tool === 'agy-other') &&
       snap.raw && typeof snap.raw === 'object') {
    const label = (snap.raw as Record<string, unknown>).matchedModel;
    if (typeof label === 'string' && label) {
      parts.push(`${DIM}${GRAY}[${label}]${R}`);
    }
  }

  if (snap.tool === 'codex' && isEstimate(snap)) {
    parts.push(`${DIM}${GRAY}[~est]${R}`);
  }

  const detailStr = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  return `${BOLD}${displayName.padEnd(13)}${R} [${barStr}] ${percentStr}${detailStr}`;
}

// ── Public render functions ────────────────────────────────────────────────

export function printHeader(): void {
  console.log(`\n${BOLD}${CYAN}⚡️ Agent Fuel - CLI Quota Monitor${R}\n`);
}

export function printRow(snap: UsageSnapshot): void {
  process.stdout.write(formatRow(snap) + '\n');
}

export function printFooter(): void {
  console.log(`\n${DIM}${GRAY}agent-fuel${loadVersion()}${R}\n`);
}

export const LOADING_LINE = `${DIM}${GRAY}loading...${R}`;

/** Convenience wrapper — renders a full static dashboard in one call. */
export function renderDashboard(snapshots: UsageSnapshot[]): void {
  printHeader();
  for (const snap of snapshots) printRow(snap);
  printFooter();
}
