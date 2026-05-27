import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { QuotaAdapter, UsageSnapshot } from './index.js';

const execAsync = promisify(exec);

export class ClaudeQuotaAdapter implements QuotaAdapter {
  private budgetLimit: number;

  constructor() {
    // Default to $10.00 for the rolling 5-hour window, allow env override
    this.budgetLimit = Number(process.env.AGENT_FUEL_CLAUDE_BUDGET) || 10.0;
  }

  public async fetchSnapshot(): Promise<UsageSnapshot> {
    try {
      // Execute ccusage to get billing block information in JSON format
      // We run npx --no-install first to see if it's already cached/available, otherwise fall back to regular npx
      let stdout: string;
      try {
        const result = await execAsync('npx --no-install ccusage blocks --json');
        stdout = result.stdout;
      } catch {
        const result = await execAsync('npx ccusage blocks --json');
        stdout = result.stdout;
      }

      const data = JSON.parse(stdout);
      const blocks = data && Array.isArray(data.blocks) ? data.blocks : data;
      
      if (!blocks || !Array.isArray(blocks)) {
        throw new Error('Invalid JSON format returned from ccusage blocks');
      }

      // Find the active billing block
      const activeBlock = blocks.find((block: any) => block.isActive === true);

      if (!activeBlock) {
        return {
          tool: 'claude-code',
          remainingPercent: null,
          usedPercent: null,
          resetAt: null,
          source: 'unknown'
        };
      }

      const cost = activeBlock.costUSD || 0.0;
      const usedPercent = (cost / this.budgetLimit) * 100;
      const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));

      let resetAt: string | null = null;
      if (activeBlock.endTime) {
        try {
          const endDate = new Date(activeBlock.endTime);
          resetAt = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
          resetAt = activeBlock.endTime;
        }
      }

      return {
        tool: 'claude-code',
        remainingPercent,
        usedPercent: Math.round(usedPercent),
        resetAt,
        source: 'ccusage',
        raw: activeBlock
      };

    } catch (error) {
      // Fallback in case of execution errors
      return {
        tool: 'claude-code',
        remainingPercent: null,
        usedPercent: null,
        resetAt: null,
        source: 'unknown',
        raw: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
