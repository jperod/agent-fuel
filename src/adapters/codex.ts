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
        throw new Error('ccusage package is not installed or available locally. Please run "npm install -g ccusage" to use this tool.');
      }

      const data = JSON.parse(stdout);
      const sessions = data && Array.isArray(data.sessions) ? data.sessions : (data && Array.isArray(data.session) ? data.session : data);

      if (!sessions || !Array.isArray(sessions)) {
        throw new Error('Invalid JSON format returned from ccusage codex session');
      }

      // Filter sessions for today's date in local time
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const todayPrefix = `${year}-${month}-${day}`;

      const todaySessions = sessions.filter((s: any) => {
        if (!s.lastActivity) return false;
        try {
          const dateObj = new Date(s.lastActivity);
          const sYear = dateObj.getFullYear();
          const sMonth = String(dateObj.getMonth() + 1).padStart(2, '0');
          const sDay = String(dateObj.getDate()).padStart(2, '0');
          const sLocalDate = `${sYear}-${sMonth}-${sDay}`;
          return sLocalDate === todayPrefix;
        } catch {
          return false;
        }
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
