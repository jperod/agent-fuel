#!/usr/bin/env node

import { ClaudeQuotaAdapter } from './adapters/claude.js';
import { CodexQuotaAdapter } from './adapters/codex.js';
import { AgyQuotaAdapter } from './adapters/agy.js';
import { UsageSnapshot } from './adapters/index.js';
import { printHeader, printFooter, formatRow, getDisplayName, LOADING_LINE } from './render.js';

// Fixed display order — never changes regardless of which adapter resolves first
const SLOT_ORDER = ['claude-code', 'codex', 'agy-gemini', 'agy-other'] as const;
type SlotTool = typeof SLOT_ORDER[number];

const BOLD = '\x1b[1m';
const R    = '\x1b[0m';

const N = SLOT_ORDER.length;

// Redraws all N slot lines from the current cursor position (cursor must be
// just below the last slot line when called).
function redraw(slots: Map<SlotTool, string | null>): void {
  process.stdout.write(`\x1b[${N}A`); // cursor up N lines
  for (const tool of SLOT_ORDER) {
    process.stdout.write('\x1b[2K\r'); // clear line
    const line = slots.get(tool);
    if (line != null) {
      process.stdout.write(line + '\n');
    } else {
      process.stdout.write(`${BOLD}${getDisplayName(tool).padEnd(13)}${R} ${LOADING_LINE}\n`);
    }
  }
}

async function main(): Promise<void> {
  const claudeAdapter = new ClaudeQuotaAdapter();
  const codexAdapter  = new CodexQuotaAdapter();
  const agyAdapter    = new AgyQuotaAdapter();

  printHeader();

  // Print placeholder rows in fixed order
  const slots = new Map<SlotTool, string | null>(SLOT_ORDER.map(t => [t, null]));
  for (const tool of SLOT_ORDER) {
    process.stdout.write(`${BOLD}${getDisplayName(tool).padEnd(13)}${R} ${LOADING_LINE}\n`);
  }

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

  printFooter();
}

main().catch((error) => {
  console.error('\x1b[31mFatal error orchestrating Agent Fuel CLI:\x1b[0m', error);
  process.exit(1);
});
