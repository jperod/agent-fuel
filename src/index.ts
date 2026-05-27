#!/usr/bin/env node

import { ClaudeQuotaAdapter } from './adapters/claude.js';
import { CodexQuotaAdapter } from './adapters/codex.js';
import { AgyQuotaAdapter } from './adapters/agy.js';
import { renderDashboard } from './render.js';

async function main(): Promise<void> {
  const claudeAdapter = new ClaudeQuotaAdapter();
  const codexAdapter = new CodexQuotaAdapter();
  const agyAdapter = new AgyQuotaAdapter();

  try {
    // Run all adapters concurrently to minimize startup latency
    const [claudeSnap, codexSnap, agySnap] = await Promise.all([
      claudeAdapter.fetchSnapshot(),
      codexAdapter.fetchSnapshot(),
      agyAdapter.fetchSnapshot()
    ]);

    // Render the beautiful 3-bar ASCII progress dashboard
    renderDashboard([
      codexSnap,
      claudeSnap,
      agySnap
    ]);
  } catch (error) {
    console.error('\x1b[31mFatal error orchestrating Agent Fuel CLI:\x1b[0m', error);
    process.exit(1);
  }
}

main();
