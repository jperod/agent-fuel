import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { QuotaAdapter, UsageSnapshot } from './index.js';

const execAsync = promisify(exec);

// Budget limit for the rolling 5-hour billing window.
// Override with AGENT_FUEL_CLAUDE_BUDGET env var (dollars).
const DEFAULT_BUDGET_USD = 20.0;

export class ClaudeQuotaAdapter implements QuotaAdapter {
  private readonly budgetLimit: number;

  constructor() {
    const override = Number(process.env.AGENT_FUEL_CLAUDE_BUDGET);
    this.budgetLimit = Number.isFinite(override) && override > 0 ? override : DEFAULT_BUDGET_USD;
  }

  public async fetchSnapshots(): Promise<UsageSnapshot[]> {
    return [await this._fetch()];
  }

  private async _fetch(): Promise<UsageSnapshot> {
    const unknown = (): UsageSnapshot => ({
      tool: 'claude-code',
      remainingPercent: null,
      usedPercent: null,
      resetAt: null,
      source: 'unknown',
    });

    try {
      let stdout: string;
      try {
        ({ stdout } = await execAsync('npx --no-install ccusage blocks --json'));
      } catch {
        throw new Error(
          'ccusage not found. Run "npm install -g ccusage" to enable Claude Code tracking.',
        );
      }

      const data = JSON.parse(stdout);
      const blocks: unknown[] = Array.isArray(data?.blocks) ? data.blocks : data;

      if (!Array.isArray(blocks)) {
        throw new Error('Unexpected JSON shape from ccusage blocks.');
      }

      const activeBlock = (blocks as Record<string, unknown>[]).find(
        (b) => b.isActive === true,
      );

      if (!activeBlock) return unknown();

      const cost = typeof activeBlock.costUSD === 'number' ? activeBlock.costUSD : 0;
      const usedPct = (cost / this.budgetLimit) * 100;
      const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - usedPct)));

      let resetAt: string | null = null;
      if (typeof activeBlock.endTime === 'string') {
        try {
          resetAt = new Date(activeBlock.endTime).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });
        } catch {
          resetAt = activeBlock.endTime;
        }
      }

      return {
        tool: 'claude-code',
        remainingPercent,
        usedPercent: Math.round(usedPct),
        resetAt,
        source: 'ccusage',
        raw: activeBlock,
      };

    } catch (error) {
      return {
        ...unknown(),
        raw: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
