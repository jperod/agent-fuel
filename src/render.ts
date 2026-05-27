import { UsageSnapshot } from './adapters/index.js';

export function renderDashboard(snapshots: UsageSnapshot[]): void {
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';
  const cyan = '\x1b[36m';
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';
  const red = '\x1b[31m';
  const gray = '\x1b[90m';

  console.log(`\n${bold}${cyan}⚡️ Agent Fuel - CLI Quota Monitor${reset}\n`);

  for (const snap of snapshots) {
    const displayName = getDisplayName(snap.tool);
    const remaining = snap.remainingPercent;

    const width = 30;
    let barStr = '';
    let percentStr = '';

    if (remaining === null || remaining === undefined) {
      // Unknown/Unconfigured quota
      barStr = `${gray}${'░'.repeat(width)}${reset}`;
      percentStr = `${gray}unknown${reset}`;
    } else {
      const filled = Math.max(0, Math.min(width, Math.round((remaining * width) / 100)));
      const empty = width - filled;

      // Color scheme based on remaining percentage
      let color = green;
      if (remaining < 20) {
        color = red;
      } else if (remaining < 50) {
        color = yellow;
      }

      const blockChar = '█';
      const shadeChar = '░';

      barStr = `${color}${blockChar.repeat(filled)}${reset}${gray}${shadeChar.repeat(empty)}${reset}`;
      percentStr = `${bold}${color}${remaining.toString().padStart(3)}% remaining${reset}`;
    }

    // Add metadata/reset times if available
    let detailStr = '';
    if (snap.resetAt) {
      detailStr = ` ${dim}${gray}(resets ${snap.resetAt})${reset}`;
    }
    if (snap.tool === 'agy' && snap.raw && typeof snap.raw === 'object' && 'activeModel' in snap.raw) {
      detailStr += ` ${dim}${gray}[${(snap.raw as any).activeModel}]${reset}`;
    }

    console.log(`${bold}${displayName.padEnd(12)}${reset} [${barStr}] ${percentStr}${detailStr}`);
  }
  console.log('');
}

function getDisplayName(tool: string): string {
  switch (tool) {
    case 'codex':
      return 'Codex';
    case 'claude-code':
      return 'Claude Code';
    case 'agy':
      return 'AGY';
    default:
      return tool;
  }
}
