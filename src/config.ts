import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface Config {
  weights: {
    'claude-code': number;
    'codex': number;
    'agy-gemini': number;
    'agy-other': number;
  };
  showTotal: boolean;
}

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'agent-fuel');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG: Config = {
  weights: {
    'claude-code': 20,
    'codex': 20,
    'agy-gemini': 10,
    'agy-other': 10,
  },
  showTotal: true,
};

function ensureDir(dir: string): void {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Ignore, let write fail if it must
  }
}

export function loadConfig(): Config {
  const config = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights } };

  // 1. Read from config file
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(content);
      
      if (parsed && typeof parsed === 'object') {
        if (parsed.weights && typeof parsed.weights === 'object') {
          for (const key of ['claude-code', 'codex', 'agy-gemini', 'agy-other'] as const) {
            const w = parsed.weights[key];
            if (typeof w === 'number' && Number.isFinite(w) && w >= 0) {
              config.weights[key] = w;
            }
          }
        }
        if (typeof parsed.showTotal === 'boolean') {
          config.showTotal = parsed.showTotal;
        }
      }
    }
  } catch {
    // Fail silently, use defaults
  }

  // 2. Read from Environment Variables
  const envClaude = process.env.AGENT_FUEL_WEIGHT_CLAUDE_CODE ?? process.env.AGENT_FUEL_WEIGHT_CLAUDE;
  if (envClaude) {
    const val = Number(envClaude);
    if (Number.isFinite(val) && val >= 0) config.weights['claude-code'] = val;
  }

  const envCodex = process.env.AGENT_FUEL_WEIGHT_CODEX;
  if (envCodex) {
    const val = Number(envCodex);
    if (Number.isFinite(val) && val >= 0) config.weights['codex'] = val;
  }

  const envGemini = process.env.AGENT_FUEL_WEIGHT_AGY_GEMINI ?? process.env.AGENT_FUEL_WEIGHT_GEMINI;
  if (envGemini) {
    const val = Number(envGemini);
    if (Number.isFinite(val) && val >= 0) config.weights['agy-gemini'] = val;
  }

  const envOther = process.env.AGENT_FUEL_WEIGHT_AGY_OTHER ?? process.env.AGENT_FUEL_WEIGHT_OTHER;
  if (envOther) {
    const val = Number(envOther);
    if (Number.isFinite(val) && val >= 0) config.weights['agy-other'] = val;
  }

  const envShowTotal = process.env.AGENT_FUEL_SHOW_TOTAL;
  if (envShowTotal) {
    if (envShowTotal.toLowerCase() === 'true') config.showTotal = true;
    if (envShowTotal.toLowerCase() === 'false') config.showTotal = false;
  }

  return config;
}

export function saveConfig(config: Config): void {
  ensureDir(CONFIG_DIR);
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not write config file ${CONFIG_FILE}: ${msg}`);
  }
}

export function handleConfigCommand(args: string[]): boolean {
  if (args.length === 0) return false;

  const firstArg = args[0].toLowerCase();
  if (firstArg !== 'config') return false;

  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[36m';
  const RED = '\x1b[31m';
  const GREEN = '\x1b[32m';
  const R = '\x1b[0m';
  const GRAY = '\x1b[90m';

  const config = loadConfig();

  const subCommand = args[1]?.toLowerCase();

  if (!subCommand || subCommand === 'list') {
    console.log(`\n${BOLD}${CYAN}⚡️ Agent Fuel Configuration${R}`);
    console.log(`${GRAY}Config file: ${CONFIG_FILE}${R}\n`);
    
    console.log(`${BOLD}Weights:${R}`);
    console.log(`  claude-code : ${config.weights['claude-code']}`);
    console.log(`  codex       : ${config.weights['codex']}`);
    console.log(`  agy-gemini  : ${config.weights['agy-gemini']}`);
    console.log(`  agy-other   : ${config.weights['agy-other']}`);
    console.log();
    console.log(`${BOLD}Settings:${R}`);
    console.log(`  show-total  : ${config.showTotal}`);
    console.log();
    console.log(`${BOLD}Examples:${R}`);
    console.log(`  agent-fuel config set claude-code 50`);
    console.log(`  agent-fuel config set show-total false`);
    console.log();
    return true;
  }

  if (subCommand === 'set') {
    const key = args[2]?.toLowerCase();
    const rawVal = args[3];

    if (!key || !rawVal) {
      console.error(`\n${BOLD}${RED}Error:${R} Usage: agent-fuel config set <key> <value>`);
      console.error(`Keys: claude, claude-code, codex, gemini, agy-gemini, other, agy-other, show-total\n`);
      process.exit(1);
    }

    if (key === 'show-total') {
      const lowerVal = rawVal.toLowerCase();
      if (lowerVal !== 'true' && lowerVal !== 'false') {
        console.error(`\n${BOLD}${RED}Error:${R} show-total must be true or false\n`);
        process.exit(1);
      }
      config.showTotal = lowerVal === 'true';
      saveConfig(config);
      console.log(`\n${BOLD}${GREEN}✓${R} Set show-total to ${config.showTotal}\n`);
      return true;
    }

    // Handle weights keys
    let targetKey: keyof Config['weights'] | null = null;
    if (key === 'claude' || key === 'claude-code') {
      targetKey = 'claude-code';
    } else if (key === 'codex') {
      targetKey = 'codex';
    } else if (key === 'gemini' || key === 'agy-gemini') {
      targetKey = 'agy-gemini';
    } else if (key === 'other' || key === 'agy-other') {
      targetKey = 'agy-other';
    }

    if (!targetKey) {
      console.error(`\n${BOLD}${RED}Error:${R} Unknown key "${key}".`);
      console.error(`Valid keys: claude, claude-code, codex, gemini, agy-gemini, other, agy-other, show-total\n`);
      process.exit(1);
    }

    const val = Number(rawVal);
    if (!Number.isFinite(val) || val < 0) {
      console.error(`\n${BOLD}${RED}Error:${R} Weight must be a positive number or 0.\n`);
      process.exit(1);
    }

    config.weights[targetKey] = val;
    saveConfig(config);
    console.log(`\n${BOLD}${GREEN}✓${R} Set weight.${targetKey} to ${val}\n`);
    return true;
  }

  console.error(`\n${BOLD}${RED}Error:${R} Unknown config sub-command "${subCommand}".`);
  console.error(`Usage: agent-fuel config [list|set]\n`);
  process.exit(1);
}
