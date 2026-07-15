#!/usr/bin/env node

import { debugEnabled, debugLogFile } from './debug.js';
import { ClaudeQuotaAdapter } from './adapters/claude.js';
import { CodexQuotaAdapter } from './adapters/codex.js';
import { AgyQuotaAdapter } from './adapters/agy.js';
import { UsageSnapshot } from './adapters/index.js';
import { printHeader, printFooter, formatRow, getDisplayName, SHADE_CHAR } from './render.js';
import { loadConfig, handleConfigCommand } from './config.js';
import { checkUpdateBackground, promptAndUpgrade, runUpdateCheckNow } from './update.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// Fixed display order — never changes regardless of which adapter resolves first
const SLOT_ORDER = ['claude-code', 'codex', 'agy-gemini', 'agy-other'] as const;
type SlotTool = typeof SLOT_ORDER[number];

const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const R     = '\x1b[0m';
const GRAY  = '\x1b[90m';
const CYAN  = '\x1b[36m';
const isTTY = Boolean(process.stdout.isTTY);

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTick = 0;

const config = loadConfig();

function spinnerLine(tool: SlotTool): string {
  const frame = SPINNER[spinnerTick % SPINNER.length];
  return `${BOLD}${getDisplayName(tool).padEnd(13)}${R} ${GRAY}${frame} loading...${R}\x1b[K`;
}

function calculateTotalLine(snapshots: Map<SlotTool, UsageSnapshot | null>): string {
  let totalWeight = 0;
  let totalRemainingWeight = 0;
  let hasActive = false;
  let isAnyLoading = false;
  
  for (const tool of SLOT_ORDER) {
    const snap = snapshots.get(tool);
    if (snap === undefined || snap === null) {
      isAnyLoading = true;
      continue;
    }
    if (snap.remainingPercent !== null) {
      const w = config.weights[tool] ?? 0;
      totalWeight += w;
      totalRemainingWeight += (snap.remainingPercent / 100) * w;
      hasActive = true;
    }
  }
  
  if (!hasActive) {
    if (isAnyLoading) {
      const frame = SPINNER[spinnerTick % SPINNER.length];
      return `${BOLD}${CYAN}Total${R}         [${GRAY}${SHADE_CHAR.repeat(30)}${R}] ${GRAY}${frame} loading...${R}\x1b[K`;
    }
    
    const totalSnap: UsageSnapshot = {
      tool: 'total',
      remainingPercent: null,
      usedPercent: null,
      source: 'unknown',
      isLoading: true
    };
    return formatRow(totalSnap);
  }
  
  const pct = totalWeight > 0 
    ? Math.max(0, Math.min(100, Math.round((totalRemainingWeight / totalWeight) * 100)))
    : null;
    
  const totalSnap: UsageSnapshot = {
    tool: 'total',
    remainingPercent: pct,
    usedPercent: pct !== null ? 100 - pct : null,
    source: 'local-state',
    isLoading: isAnyLoading
  };
  
  let formatted = formatRow(totalSnap);
  
  if (isAnyLoading) {
    const frame = SPINNER[spinnerTick % SPINNER.length];
    formatted += ` ${GRAY}${frame} loading...${R}`;
  } else {
    formatted += `  ${GRAY}(tune weights: agent-fuel config)${R}`;
  }
  
  return formatted;
}

// In TTY mode: restore cursor to saved position and repaint all slots.
// In pipe mode: emit each newly-resolved line exactly once (tracked via emitted set).
function redraw(
  slots: Map<SlotTool, string | null>,
  emitted: Set<SlotTool | 'total'>,
  snapshots: Map<SlotTool, UsageSnapshot | null>
): void {
  if (!isTTY) {
    for (const tool of SLOT_ORDER) {
      const line = slots.get(tool);
      if (line != null && !emitted.has(tool)) {
        process.stdout.write(line + '\n');
        emitted.add(tool);
      }
    }
    
    if (config.showTotal && emitted.size === SLOT_ORDER.length && !emitted.has('total')) {
      const totalLine = calculateTotalLine(snapshots);
      process.stdout.write('\n' + totalLine + '\n');
      emitted.add('total');
    }
    return;
  }
  
  process.stdout.write('\x1b8'); // DEC restore-cursor — teleports back to saved position
  
  if (config.showTotal) {
    process.stdout.write('\x1b[2K\r');
    const totalLine = calculateTotalLine(snapshots);
    process.stdout.write(totalLine + '\n');
    process.stdout.write('\x1b[2K\r\n'); // spacer line
  }
  
  for (const tool of SLOT_ORDER) {
    process.stdout.write('\x1b[2K\r');
    const line = slots.get(tool);
    process.stdout.write((line != null ? line + '\x1b[K' : spinnerLine(tool)) + '\n');
  }
}

function loadPackageVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, '../package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return '0.6.0';
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const currentVersion = loadPackageVersion();
  if (args.includes('--check-update-now')) {
    await runUpdateCheckNow(currentVersion);
    return;
  }

  if (handleConfigCommand(args)) {
    return;
  }

  const updateVersion = checkUpdateBackground(currentVersion);

  const claudeAdapter = new ClaudeQuotaAdapter();
  const codexAdapter  = new CodexQuotaAdapter();
  const agyAdapter    = new AgyQuotaAdapter();

  if (debugEnabled) process.stderr.write(`\x1b[2m[debug] logging to ${debugLogFile}\x1b[0m\n`);
  printHeader();

  // Save cursor before the placeholder rows so redraw() can teleport back and overwrite them
  const slots     = new Map<SlotTool, string | null>(SLOT_ORDER.map(t => [t, null]));
  const snapshots = new Map<SlotTool, UsageSnapshot | null>(SLOT_ORDER.map(t => [t, null]));
  const emitted   = new Set<SlotTool | 'total'>(); // pipe-mode: tracks which lines have been printed
  
  if (isTTY) {
    process.stdout.write('\x1b7'); // DEC save-cursor
    
    if (config.showTotal) {
      process.stdout.write(calculateTotalLine(snapshots) + '\n\n');
    }
  }
  
  for (const tool of SLOT_ORDER) {
    process.stdout.write(spinnerLine(tool) + '\n');
  }

  // Animate spinner at 80ms while any slot is still loading
  const spinnerTimer = isTTY
    ? setInterval(() => { spinnerTick++; redraw(slots, emitted, snapshots); }, 80)
    : null;

  // Each adapter fills its slot(s) and triggers a redraw; order is always fixed
  function fill(snaps: UsageSnapshot[]): void {
    for (const snap of snaps) {
      if (SLOT_ORDER.includes(snap.tool as SlotTool)) {
        snapshots.set(snap.tool as SlotTool, snap);
        slots.set(snap.tool as SlotTool, formatRow(snap));
      }
    }
    redraw(slots, emitted, snapshots);
  }

  await Promise.allSettled([
    claudeAdapter.fetchSnapshots().then(fill),
    codexAdapter.fetchSnapshots().then(fill),
    agyAdapter.fetchSnapshots().then(fill),
  ]);

  if (spinnerTimer) clearInterval(spinnerTimer);
  redraw(slots, emitted, snapshots); // final clean repaint with all data
  printFooter();

  if (updateVersion) {
    await promptAndUpgrade(updateVersion);
  }
}

main().catch((error) => {
  console.error('\x1b[31mFatal error orchestrating Agent Fuel CLI:\x1b[0m', error);
  process.exit(1);
});
