import { QuotaAdapter, UsageSnapshot } from './index.js';

export class AgyQuotaAdapter implements QuotaAdapter {
  public async fetchSnapshot(): Promise<UsageSnapshot> {
    // Placeholder as Antigravity/AGY usage remains unknown for now
    return {
      tool: 'agy',
      remainingPercent: null,
      usedPercent: null,
      resetAt: null,
      source: 'unknown'
    };
  }
}
