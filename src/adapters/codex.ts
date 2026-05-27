import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { QuotaAdapter, UsageSnapshot } from './index.js';

const execAsync = promisify(exec);

export class CodexQuotaAdapter implements QuotaAdapter {
  private budgetLimit: number;

  constructor() {
    // Default budget limit of $20.00 for the rolling 5h window (Standard Team/Plus limit)
    // Allows dynamic override using environment variable AGENT_FUEL_CODEX_BUDGET
    this.budgetLimit = Number(process.env.AGENT_FUEL_CODEX_BUDGET) || 20.0;
  }

  public async fetchSnapshot(): Promise<UsageSnapshot> {
    try {
      // Execute ccusage to get Codex session data
      let stdout: string;
      try {
        const result = await execAsync('npx --no-install ccusage codex session --json');
        stdout = result.stdout;
      } catch {
        const result = await execAsync('npx ccusage codex session --json');
        stdout = result.stdout;
      }

      const data = JSON.parse(stdout);
      const sessions = data && Array.isArray(data.sessions) ? data.sessions : (data && Array.isArray(data.session) ? data.session : data);

      if (!sessions || !Array.isArray(sessions)) {
        throw new Error('Invalid JSON format returned from ccusage codex session');
      }

      // Filter sessions for today's date in local time
      const todayPrefix = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
      const todaySessions = sessions.filter((s: any) => {
        if (!s.lastActivity) return false;
        return s.lastActivity.startsWith(todayPrefix);
      });

      if (todaySessions.length === 0) {
        // No activity today, so 100% fuel remaining
        return {
          tool: 'codex',
          remainingPercent: 100,
          usedPercent: 0,
          resetAt: null,
          source: 'ccusage'
        };
      }

      // Sum today's cost
      const totalCost = todaySessions.reduce((acc: number, s: any) => acc + (s.costUSD || 0.0), 0.0);
      const usedPercent = (totalCost / this.budgetLimit) * 100;
      
      // Calculate remaining percentage
      let remainingPercent = 100 - usedPercent;
      if (usedPercent > 0 && remainingPercent > 99) {
        // Micro-interaction: if they burned any credits, show 99% instead of rounding to 100%
        remainingPercent = 99;
      } else {
        remainingPercent = Math.max(0, Math.min(100, Math.round(remainingPercent)));
      }

      // Calculate rolling 5-hour reset time based on the most recent session's activity
      let resetAt: string | null = null;
      const sortedSessions = [...todaySessions].sort(
        (a: any, b: any) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
      const latestSession = sortedSessions[0];

      if (latestSession && latestSession.lastActivity) {
        try {
          const lastActivityDate = new Date(latestSession.lastActivity);
          // Roll forward 5 hours for the rolling limit window
          const resetDate = new Date(lastActivityDate.getTime() + 5 * 60 * 60 * 1000);
          resetAt = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
          resetAt = null;
        }
      }

      return {
        tool: 'codex',
        remainingPercent,
        usedPercent: Math.round(usedPercent),
        resetAt,
        source: 'ccusage',
        raw: { totalCost, todaySessionsCount: todaySessions.length }
      };

    } catch (error) {
      return {
        tool: 'codex',
        remainingPercent: null,
        usedPercent: null,
        resetAt: null,
        source: 'unknown',
        raw: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
