import { QuotaAdapter, UsageSnapshot } from './index.js';

export class CodexQuotaAdapter implements QuotaAdapter {
  public async fetchSnapshot(): Promise<UsageSnapshot> {
    // Placeholder as Codex usage remains unknown for now
    return {
      tool: 'codex',
      remainingPercent: null,
      usedPercent: null,
      resetAt: null,
      source: 'unknown'
    };
  }
}
