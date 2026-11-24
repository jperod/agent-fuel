import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type ToolType = 'claude' | 'codex' | 'agy' | 'grok' | 'cursor';

export interface AccountConfig {
  id: string;
  displayName: string;
  type: ToolType;
  command?: string;
  env?: Record<string, string>;
  weight: number;
  subWeights?: Record<string, number>;
}

export interface Config {
  accounts: AccountConfig[];
  showTotal: boolean;
}

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'agent-fuel');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_ACCOUNTS: AccountConfig[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    type: 'claude',
    command: 'claude',
    weight: 20,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    type: 'codex',
    command: 'codex',
    weight: 20,
  },
  {
    id: 'cursor',
    displayName: 'Cursor Agent',
    type: 'cursor',
    command: 'cursor-agent',
    weight: 20,
  },
  {
    id: 'agy',
    displayName: 'AGY',
    type: 'agy',
    command: 'agy',
    weight: 20,
  },
];

export const DEFAULT_CONFIG: Config = {
  accounts: DEFAULT_ACCOUNTS,
  showTotal: true,
};

const SENSITIVE_ENV_KEY_RE = /(?:KEY|TOKEN|SECRET|PASS|PWD|AUTH|CREDENTIAL|COOKIE|BEARER)/i;

/** Returns true if an environment variable name is a valid POSIX identifier. */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Returns true if an account ID avoids path traversal and separator characters. */
export function isValidAccountId(id: string): boolean {
  return id.length > 0 && !/[\\/\0]/.test(id) && !id.includes('..');
}

/** Returns true if a configured CLI command string is free of shell chaining/subshell operators. */
export function isSafeCommandString(cmd: string): boolean {
  const trimmed = cmd.trim();
  return trimmed.length > 0 && !/[\0\r\n;|&`<>]/.test(trimmed) && !trimmed.includes('$(');
}

/** Returns a shallow copy of env with secret-bearing variable values masked. */
export function redactEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    masked[k] = SENSITIVE_ENV_KEY_RE.test(k) ? '***' : v;
  }
  return masked;
}

/**
 * Ensures `dir` exists as a real directory (not a symlink) owned by the current
 * user with 0700 permissions. Returns false if an unsafe path is encountered.
 */
export function ensurePrivateDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    if ((st.mode & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700);
    }
    return true;
  } catch {
    return false;
  }
}

/** Writes `content` to `filePath` with 0600 permissions inside a verified private parent directory. */
export function writePrivateFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!ensurePrivateDir(dir)) {
    throw new Error(`Refusing to write to unsafe directory: ${dir}`);
  }
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/**
 * Returns an empty user-private working directory for running external CLIs so
 * they never execute inside or auto-trust an untrusted repository CWD.
 */
export function getSafeWorkingDir(): string {
  const workspaceDir = path.join(CONFIG_DIR, 'workspace');
  if (ensurePrivateDir(workspaceDir)) {
    return workspaceDir;
  }
  return os.tmpdir();
}

function tightenFileModeIfOwned(filePath: string): void {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return;
    if ((st.mode & 0o077) !== 0) {
      fs.chmodSync(filePath, 0o600);
    }
  } catch {
    // Ignore
  }
}

export function loadConfig(): Config {
  let config: Config = {
    accounts: DEFAULT_ACCOUNTS.map(a => ({ ...a })),
    showTotal: true,
  };

  // 1. Read from config file
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      ensurePrivateDir(CONFIG_DIR);
      tightenFileModeIfOwned(CONFIG_FILE);
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(content);
      
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
          config.accounts = parsed.accounts.map((ac: any) => {
            const rawId = String(ac.id || ac.displayName || 'account');
            const safeId = isValidAccountId(rawId) ? rawId : rawId.replace(/[\\/]/g, '-').replace(/\.\./g, '-');
            let safeEnv: Record<string, string> | undefined;
            if (ac.env && typeof ac.env === 'object' && !Array.isArray(ac.env)) {
              const filtered: Record<string, string> = {};
              for (const [k, v] of Object.entries(ac.env as Record<string, unknown>)) {
                if (isValidEnvKey(k) && typeof v === 'string') {
                  filtered[k] = v;
                }
              }
              if (Object.keys(filtered).length > 0) safeEnv = filtered;
            }
            const rawCmd = ac.command ? String(ac.command) : undefined;
            const safeCmd = rawCmd && isSafeCommandString(rawCmd) ? rawCmd : undefined;
            return {
              id: safeId || 'account',
              displayName: String(ac.displayName || safeId || 'Account'),
              type: (['claude', 'codex', 'agy', 'grok', 'cursor'].includes(ac.type) ? ac.type : 'claude') as ToolType,
              command: safeCmd,
              env: safeEnv,
              weight: typeof ac.weight === 'number' && Number.isFinite(ac.weight) && ac.weight >= 0 ? ac.weight : 20,
              subWeights: ac.subWeights && typeof ac.subWeights === 'object' ? ac.subWeights : undefined,
            };
          });
        } else if (parsed.weights && typeof parsed.weights === 'object') {
          // Migration path from legacy weights config
          const legacyClaude = parsed.weights['claude-code'] ?? 20;
          const legacyCodex = parsed.weights['codex'] ?? 20;
          const legacyAgyGemini = parsed.weights['agy-gemini'] ?? 10;
          const legacyAgyOther = parsed.weights['agy-other'] ?? 10;
          const legacyAgyArgon = parsed.weights['agy-argon'] ?? 0;

          config.accounts = [
            {
              id: 'claude-code',
              displayName: 'Claude Code',
              type: 'claude',
              command: 'claude',
              weight: legacyClaude,
            },
            {
              id: 'codex',
              displayName: 'Codex',
              type: 'codex',
              command: 'codex',
              weight: legacyCodex,
            },
            {
              id: 'agy',
              displayName: 'AGY',
              type: 'agy',
              command: 'agy',
              weight: legacyAgyGemini + legacyAgyOther + legacyAgyArgon,
            },
          ];
        }

        if (typeof parsed.showTotal === 'boolean') {
          config.showTotal = parsed.showTotal;
        }
      }
    }
  } catch {
    // Fail silently, use defaults
  }

  // 2. Read from Environment Variables overrides
  const envShowTotal = process.env.AGENT_FUEL_SHOW_TOTAL;
  if (envShowTotal) {
    if (envShowTotal.toLowerCase() === 'true') config.showTotal = true;
    if (envShowTotal.toLowerCase() === 'false') config.showTotal = false;
  }

  for (const acc of config.accounts) {
    const envKeyId = `AGENT_FUEL_WEIGHT_${acc.id.toUpperCase().replace(/-/g, '_')}`;
    const envKeyType = `AGENT_FUEL_WEIGHT_${acc.type.toUpperCase().replace(/-/g, '_')}`;
    const rawWeight = process.env[envKeyId] ?? process.env[envKeyType];
    if (rawWeight !== undefined) {
      const parsed = Number(rawWeight);
      if (Number.isFinite(parsed) && parsed >= 0) {
        acc.weight = parsed;
      }
    }
  }

  return config;
}

export function saveConfig(config: Config): void {
  try {
    writePrivateFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
    
    console.log(`${BOLD}Configured Accounts:${R}`);
    for (const acc of config.accounts) {
      const envStr = acc.env ? ` (env: ${JSON.stringify(redactEnv(acc.env))})` : '';
      const cmdStr = acc.command ? ` [cmd: ${acc.command}]` : '';
      const subStr = acc.subWeights
        ? ` (sub: Gemini=${acc.subWeights.gemini ?? 'auto'}, Other=${acc.subWeights.other ?? 'auto'}${acc.subWeights.argon !== undefined ? `, Argon=${acc.subWeights.argon}` : ''})`
        : (acc.type === 'agy' ? ' (sub-ratio: 5:1)' : '');
      console.log(`  ${BOLD}${acc.id.padEnd(16)}${R} | Type: ${acc.type.padEnd(7)} | Weight: ${String(acc.weight).padEnd(4)} | Name: "${acc.displayName}"${cmdStr}${envStr}${subStr}`);
    }
    console.log();
    console.log(`${BOLD}Settings:${R}`);
    console.log(`  show-total  : ${config.showTotal}`);
    console.log();
    console.log(`${BOLD}Examples:${R}`);
    console.log(`  agent-fuel config add-account claude-personal --type claude --name "Claude Personal" --env CLAUDE_CONFIG_DIR=~/.claude-personal`);
    console.log(`  agent-fuel config add-account codex-work --type codex --name "Codex Work" --cmd codex-work`);
    console.log(`  agent-fuel config add-account grok --type grok --name "Grok Build"`);
    console.log(`  agent-fuel config add-account cursor --type cursor --name "Cursor Agent"`);
    console.log(`  agent-fuel config remove-account claude-personal`);
    console.log(`  agent-fuel config set claude-code weight 50`);
    console.log(`  agent-fuel config set show-total false`);
    console.log();
    return true;
  }

  if (subCommand === 'add-account') {
    const id = args[2];
    if (!id || id.startsWith('-') || !isValidAccountId(id)) {
      console.error(`\n${BOLD}${RED}Error:${R} Invalid or missing account id. Usage: agent-fuel config add-account <id> --type <claude|codex|agy|grok|cursor> [--name "Name"] [--cmd "command"] [--env KEY=VAL] [--weight N]\n`);
      process.exit(1);
    }

    let type: ToolType = 'claude';
    let displayName = id;
    let command: string | undefined = undefined;
    let weight = 20;
    const env: Record<string, string> = {};

    for (let i = 3; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--type' && args[i + 1]) {
        const t = args[i + 1].toLowerCase();
        if (['claude', 'codex', 'agy', 'grok', 'cursor'].includes(t)) {
          type = t as ToolType;
        } else {
          console.error(`\n${BOLD}${RED}Error:${R} Invalid type "${t}". Must be claude, codex, agy, grok, or cursor.\n`);
          process.exit(1);
        }
        i++;
      } else if (arg === '--name' && args[i + 1]) {
        displayName = args[i + 1];
        i++;
      } else if ((arg === '--cmd' || arg === '--command') && args[i + 1]) {
        const candidate = args[i + 1];
        if (!isSafeCommandString(candidate)) {
          console.error(`\n${BOLD}${RED}Error:${R} Invalid command "${candidate}". Shell chaining operators are not allowed.\n`);
          process.exit(1);
        }
        command = candidate;
        i++;
      } else if (arg === '--weight' && args[i + 1]) {
        const w = Number(args[i + 1]);
        if (Number.isFinite(w) && w >= 0) weight = w;
        i++;
      } else if (arg === '--env' && args[i + 1]) {
        const parts = args[i + 1].split('=');
        if (parts.length >= 2) {
          const envKey = parts[0];
          if (!isValidEnvKey(envKey)) {
            console.error(`\n${BOLD}${RED}Error:${R} Invalid environment variable name "${envKey}".\n`);
            process.exit(1);
          }
          env[envKey] = parts.slice(1).join('=');
        }
        i++;
      }
    }

    const existingIdx = config.accounts.findIndex(a => a.id === id);
    const newAcc: AccountConfig = {
      id,
      displayName,
      type,
      command: command || undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      weight,
    };

    if (existingIdx >= 0) {
      config.accounts[existingIdx] = newAcc;
      console.log(`\n${BOLD}${GREEN}✓${R} Updated account "${id}"\n`);
    } else {
      config.accounts.push(newAcc);
      console.log(`\n${BOLD}${GREEN}✓${R} Added account "${id}" (${displayName})\n`);
    }

    saveConfig(config);
    return true;
  }

  if (subCommand === 'remove-account') {
    const id = args[2];
    if (!id) {
      console.error(`\n${BOLD}${RED}Error:${R} Usage: agent-fuel config remove-account <id>\n`);
      process.exit(1);
    }

    const initialLength = config.accounts.length;
    config.accounts = config.accounts.filter(a => a.id !== id);

    if (config.accounts.length === initialLength) {
      console.error(`\n${BOLD}${RED}Error:${R} Account "${id}" not found.\n`);
      process.exit(1);
    }

    saveConfig(config);
    console.log(`\n${BOLD}${GREEN}✓${R} Removed account "${id}"\n`);
    return true;
  }

  if (subCommand === 'set') {
    const keyOrId = args[2];
    const propertyOrVal = args[3];
    const rawVal = args[4];

    if (!keyOrId) {
      console.error(`\n${BOLD}${RED}Error:${R} Usage: agent-fuel config set <account-id|show-total> [weight|property] <value>\n`);
      process.exit(1);
    }

    if (keyOrId.toLowerCase() === 'show-total') {
      const val = propertyOrVal?.toLowerCase();
      if (val !== 'true' && val !== 'false') {
        console.error(`\n${BOLD}${RED}Error:${R} show-total must be true or false\n`);
        process.exit(1);
      }
      config.showTotal = val === 'true';
      saveConfig(config);
      console.log(`\n${BOLD}${GREEN}✓${R} Set show-total to ${config.showTotal}\n`);
      return true;
    }

    // Checking account update (support base account or sub-slot like agy-argon, agy-gemini, agy-other)
    let targetSubKey: string | null = null;
    let account = config.accounts.find(a => a.id.toLowerCase() === keyOrId.toLowerCase());

    if (!account) {
      for (const a of config.accounts) {
        for (const sub of ['gemini', 'flash', 'argon', 'other']) {
          if (keyOrId.toLowerCase() === `${a.id.toLowerCase()}-${sub}`) {
            account = a;
            targetSubKey = sub === 'flash' ? 'gemini' : sub;
            break;
          }
        }
        if (account) break;
      }
    }

    if (!account) {
      console.error(`\n${BOLD}${RED}Error:${R} Unknown account or setting "${keyOrId}". Use agent-fuel config list to view accounts.\n`);
      process.exit(1);
    }

    if (targetSubKey) {
      const val = Number(rawVal ?? propertyOrVal);
      if (!Number.isFinite(val) || val < 0) {
        console.error(`\n${BOLD}${RED}Error:${R} Weight must be a non-negative number.\n`);
        process.exit(1);
      }
      account.subWeights = account.subWeights || {};
      account.subWeights[targetSubKey] = val;
      saveConfig(config);
      console.log(`\n${BOLD}${GREEN}✓${R} Set sub-weight ${targetSubKey} for account "${account.id}" to ${val}\n`);
      return true;
    }

    const prop = rawVal ? propertyOrVal.toLowerCase() : 'weight';
    const valueStr = rawVal ?? propertyOrVal;

    if (['gemini', 'flash', 'argon', 'other'].includes(prop)) {
      const val = Number(valueStr);
      if (!Number.isFinite(val) || val < 0) {
        console.error(`\n${BOLD}${RED}Error:${R} Sub-weight must be a non-negative number.\n`);
        process.exit(1);
      }
      account.subWeights = account.subWeights || {};
      const key = prop === 'flash' ? 'gemini' : prop;
      account.subWeights[key] = val;
      saveConfig(config);
      console.log(`\n${BOLD}${GREEN}✓${R} Set sub-weight ${key} for account "${account.id}" to ${val}\n`);
      return true;
    }

    if (prop === 'weight') {
      const val = Number(valueStr);
      if (!Number.isFinite(val) || val < 0) {
        console.error(`\n${BOLD}${RED}Error:${R} Weight must be a non-negative number.\n`);
        process.exit(1);
      }
      account.weight = val;
      saveConfig(config);
      console.log(`\n${BOLD}${GREEN}✓${R} Set weight for account "${account.id}" to ${val}\n`);
      return true;
    }

    if (prop === 'name' || prop === 'displayname') {
      account.displayName = valueStr;
      saveConfig(config);
      console.log(`\n${BOLD}${GREEN}✓${R} Set displayName for account "${account.id}" to "${valueStr}"\n`);
      return true;
    }

    if (prop === 'command' || prop === 'cmd') {
      if (!isSafeCommandString(valueStr)) {
        console.error(`\n${BOLD}${RED}Error:${R} Invalid command "${valueStr}". Shell chaining operators are not allowed.\n`);
        process.exit(1);
      }
      account.command = valueStr;
      saveConfig(config);
      console.log(`\n${BOLD}${GREEN}✓${R} Set command for account "${account.id}" to "${valueStr}"\n`);
      return true;
    }

    console.error(`\n${BOLD}${RED}Error:${R} Unknown property "${prop}". Supported properties: weight, gemini, other, name, command\n`);
    process.exit(1);
  }

  console.error(`\n${BOLD}${RED}Error:${R} Unknown config sub-command "${subCommand}".`);
  console.error(`Usage: agent-fuel config [list|add-account|remove-account|set]\n`);
  process.exit(1);
}

