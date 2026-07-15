export interface UsageSnapshot {
  tool: 'codex' | 'claude-code' | 'agy-gemini' | 'agy-other' | 'total';
  remainingPercent: number | null;
  usedPercent?: number | null;
  resetAt?: string | null;
  source: 'official-cli' | 'ccusage' | 'local-state' | 'provider-api' | 'cache' | 'unknown';
  isLoading?: boolean;
  weeklyLimitReached?: boolean;
  limitType?: 'session' | 'weekly';
  breakdown?: {
    fiveHour: number | null;
    weekly: number | null;
  };
  raw?: unknown;
}

export interface QuotaAdapter {
  /** Returns one or more snapshots (adapters that produce multiple rows return an array). */
  fetchSnapshots(): Promise<UsageSnapshot[]>;
}
