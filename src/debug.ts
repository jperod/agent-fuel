import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const enabled = process.argv.includes('--debug');
const MAX_DEBUG_LOGS = 10;

function ensurePrivateLogDir(): string {
  const preferred = join(homedir(), '.config', 'agent-fuel', 'logs');
  try {
    mkdirSync(preferred, { recursive: true, mode: 0o700 });
    const st = lstatSync(preferred);
    const uidOk = typeof process.getuid !== 'function' || st.uid === process.getuid();
    if (!st.isSymbolicLink() && st.isDirectory() && uidOk) {
      if ((st.mode & 0o077) !== 0) chmodSync(preferred, 0o700);
      return preferred;
    }
  } catch {
    // Fallback below
  }
  return mkdtempSync(join(tmpdir(), 'agent-fuel-logs-'));
}

/** Masks Bearer headers, common API key prefixes, and inline secret env assignments. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/\b(?:sk|xai|ghp|gho|github_pat|AIza)[-_A-Za-z0-9]{10,}/g, '***')
    .replace(/(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PWD|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*=)('[^']*'|"[^"]*"|\S+)/g, '$1***');
}

function pruneOldLogs(dir: string): void {
  try {
    // Count first — stat only if pruning is actually needed.
    // Use MAX_DEBUG_LOGS - 1 to reserve a slot for the new log file that is
    // created after this call, so the total on disk never exceeds MAX_DEBUG_LOGS.
    const names = readdirSync(dir)
      .filter(f => f.startsWith('debug-') && f.endsWith('.log'));

    if (names.length < MAX_DEBUG_LOGS) return;

    const files = names.map(f => {
      const p = join(dir, f);
      return { path: p, time: statSync(p).mtimeMs };
    });

    // Sort by modification time, oldest first
    files.sort((a, b) => a.time - b.time);

    const toDeleteCount = files.length - (MAX_DEBUG_LOGS - 1);
    for (let i = 0; i < toDeleteCount; i++) {
      try {
        unlinkSync(files[i].path);
      } catch {
        // ignore individual deletion failures
      }
    }
  } catch {
    // ignore directory read/stat errors
  }
}

const logFile = enabled
  ? (() => {
      const dir = ensurePrivateLogDir();
      pruneOldLogs(dir);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      return join(dir, `debug-${ts}.log`);
    })()
  : null;

export function debug(tag: string, message: string, data?: unknown): void {
  if (!logFile) return;
  const raw = `[${new Date().toISOString()}] [${tag}] ${message}${data !== undefined ? '\n' + JSON.stringify(data, null, 2) : ''}\n`;
  appendFileSync(logFile, redactSecrets(raw), { encoding: 'utf8', mode: 0o600 });
}

export { enabled as debugEnabled, logFile as debugLogFile };
