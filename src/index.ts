#!/usr/bin/env node

import { debugEnabled, debugLogFile } from './debug.js';
import { ClaudeQuotaAdapter } from './adapters/claude.js';
import { CodexQuotaAdapter } from './adapters/codex.js';
import { AgyQuotaAdapter } from './adapters/agy.js';
import { UsageSnapshot } from './adapters/index.js';
import { printHeader, printFooter, formatRow, getDisplayName } from './render.js';

// Fixed display order — never changes regardless of which adapter resolves first
const SLOT_ORDER = ['claude-code', 'codex', 'agy-gemini', 'agy-other'] as const;
type SlotTool = typeof SLOT_ORDER[number];

const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const R     = '\x1b[0m';
const GRAY  = '\x1b[90m';
const isTTY = Boolean(process.stdout.isTTY);

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTick = 0;

function spinnerLine(tool: SlotTool): string {
  const frame = SPINNER[spinnerTick % SPINNER.length];
  return `${BOLD}${getDisplayName(tool).padEnd(13)}${R} ${DIM}${GRAY}${frame} loading...${R}\x1b[K`;
}

// In TTY mode: restore cursor to saved position and repaint all slots.
// In pipe mode: emit each newly-resolved line once (no cursor tricks).
function redraw(slots: Map<SlotTool, string | null>): void {
  if (!isTTY) {
    for (const tool of SLOT_ORDER) {
      const line = slots.get(tool);
      if (line != null) process.stdout.write(line + '\n');
    }
    return;
  }
  process.stdout.write('\x1b8'); // DEC restore-cursor — teleports back to saved position
  for (const tool of SLOT_ORDER) {
    process.stdout.write('\x1b[2K\r');
    const line = slots.get(tool);
    process.stdout.write((line != null ? line + '\x1b[K' : spinnerLine(tool)) + '\n');
  }
}

async function main(): Promise<void> {
  const claudeAdapter = new ClaudeQuotaAdapter();
  const codexAdapter  = new CodexQuotaAdapter();
  const agyAdapter    = new AgyQuotaAdapter();

  if (debugEnabled) process.stderr.write(`\x1b[2m[debug] logging to ${debugLogFile}\x1b[0m\n`);
  printHeader();

  // Save cursor before the placeholder rows so redraw() can teleport back and overwrite them
  const slots = new Map<SlotTool, string | null>(SLOT_ORDER.map(t => [t, null]));
  if (isTTY) process.stdout.write('\x1b7'); // DEC save-cursor
  for (const tool of SLOT_ORDER) {
    process.stdout.write(spinnerLine(tool) + '\n');
  }

  // Animate spinner at 80ms while any slot is still loading
  const spinnerTimer = isTTY
    ? setInterval(() => { spinnerTick++; redraw(slots); }, 80)
    : null;

  // Each adapter fills its slot(s) and triggers a redraw; order is always fixed
  function fill(snaps: UsageSnapshot[]): void {
    for (const snap of snaps) {
      if (SLOT_ORDER.includes(snap.tool as SlotTool)) {
        slots.set(snap.tool as SlotTool, formatRow(snap));
      }
    }
    redraw(slots);
  }

  await Promise.allSettled([
    claudeAdapter.fetchSnapshots().then(fill),
    codexAdapter.fetchSnapshots().then(fill),
    agyAdapter.fetchSnapshots().then(fill),
  ]);

  if (spinnerTimer) clearInterval(spinnerTimer);
  redraw(slots); // final clean repaint with all data
  printFooter();
}

main().catch((error) => {
  console.error('\x1b[31mFatal error orchestrating Agent Fuel CLI:\x1b[0m', error);
  process.exit(1);
});
