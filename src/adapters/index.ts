export interface UsageSnapshot {
  tool: 'codex' | 'claude-code' | 'agy';
  remainingPercent: number | null;
  usedPercent?: number | null;
  resetAt?: string | null;
  source: 'official-cli' | 'ccusage' | 'local-state' | 'provider-api' | 'unknown';
  raw?: unknown;
}

export interface QuotaAdapter {
  fetchSnapshot(): Promise<UsageSnapshot>;
}
