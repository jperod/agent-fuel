import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { QuotaAdapter, UsageSnapshot } from './index.js';

export class AgyQuotaAdapter implements QuotaAdapter {
  private configDir: string;

  constructor() {
    // Default to the standard AGY CLI config directory
    this.configDir = path.join(os.homedir(), '.gemini/antigravity-cli');
  }

  public async fetchSnapshot(): Promise<UsageSnapshot> {
    try {
      const settingsPath = path.join(this.configDir, 'settings.json');
      const historyPath = path.join(this.configDir, 'history.jsonl');

      let activeModel = 'Gemini 3.5 Flash';
      
      // 1. Read active model from settings.json if it exists
      try {
        const settingsContent = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        if (settings && settings.model) {
          activeModel = settings.model;
        }
      } catch {
        // Fallback to default model name if reading or parsing settings failed
      }

      // 2. Read history.jsonl to detect active prompts today
      let todayPromptsCount = 0;
      let latestPromptTimestamp: number | null = null;

      // Construct local todayPrefix in YYYY-MM-DD format (timezone aware)
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const todayPrefix = `${year}-${month}-${day}`;

      try {
        const historyContent = await fs.readFile(historyPath, 'utf-8');
        const historyLines = historyContent.trim().split('\n');
        
        for (const line of historyLines) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line);
          if (entry && entry.timestamp) {
            // Get local date YYYY-MM-DD for the entry's timestamp
            const entryDateObj = new Date(entry.timestamp);
            const eYear = entryDateObj.getFullYear();
            const eMonth = String(entryDateObj.getMonth() + 1).padStart(2, '0');
            const eDay = String(entryDateObj.getDate()).padStart(2, '0');
            const entryDate = `${eYear}-${eMonth}-${eDay}`;

            if (entryDate === todayPrefix) {
              todayPromptsCount++;
              if (!latestPromptTimestamp || entry.timestamp > latestPromptTimestamp) {
                latestPromptTimestamp = entry.timestamp;
              }
            }
          }
        }
      } catch {
        // Fallback if reading or parsing history failed (e.g. file doesn't exist)
      }

      // 3. Calculate remaining percent based on active usage and model tier
      // Support dynamic overrides using AGENT_FUEL_AGY_PERCENT environment variable
      let remainingPercent = 100;
      const isProModel = activeModel.toLowerCase().includes('pro');
      const limit = isProModel ? 3 : 5; // Pro models have a tighter limit of 3, Flash has 5
      const costPerPrompt = 100 / limit;
      const calculatedPercent = Math.max(0, Math.round(100 - (todayPromptsCount * costPerPrompt)));

      if (process.env.AGENT_FUEL_AGY_PERCENT) {
        const envVal = Number(process.env.AGENT_FUEL_AGY_PERCENT);
        remainingPercent = !isNaN(envVal) ? Math.max(0, Math.min(100, envVal)) : calculatedPercent;
      } else {
        remainingPercent = calculatedPercent;
      }

      // 4. Calculate rolling reset time (5 hours rolling or resets in 4h 37m from latest prompt, giving ~01:30 PM resets)
      let resetAt: string | null = null;
      if (latestPromptTimestamp) {
        try {
          const lastActivityDate = new Date(latestPromptTimestamp);
          // Roll forward 5 hours (refreshes in ~4h 37m from active run)
          const resetDate = new Date(lastActivityDate.getTime() + 5 * 60 * 60 * 1000);
          resetAt = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
          resetAt = null;
        }
      }

      return {
        tool: 'agy',
        remainingPercent,
        usedPercent: 100 - remainingPercent,
        resetAt,
        source: 'local-state',
        raw: { activeModel, todayPromptsCount }
      };

    } catch (error) {
      return {
        tool: 'agy',
        remainingPercent: null,
        usedPercent: null,
        resetAt: null,
        source: 'unknown',
        raw: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
