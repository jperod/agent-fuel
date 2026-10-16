export interface UsageSnapshot {
  tool: string;
  displayName?: string;
  remainingPercent: number | null;
  usedPercent?: number | null;
  resetAt?: string | null;
  source: 'official-cli' | 'ccusage' | 'local-state' | 'provider-api' | 'cache' | 'unknown';
  isLoading?: boolean;
  isFreeTier?: boolean;
  weeklyLimitReached?: boolean;
  monthlyLimitReached?: boolean;
  limitType?: 'session' | 'weekly' | 'monthly' | 'daily' | string;
  breakdown?: {
    fiveHour?: number | null;
    weekly?: number | null;
    monthly?: number | null;
    daily?: number | null;
  };
  raw?: unknown;
}

export interface QuotaAdapter {
  /** Returns one or more snapshots (adapters that produce multiple rows return an array). */
  fetchSnapshots(): Promise<UsageSnapshot[]>;
}
