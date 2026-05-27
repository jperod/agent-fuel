import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const enabled = process.argv.includes('--debug');
const MAX_DEBUG_LOGS = 10;

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
      const dir = join(process.cwd(), '.logs');
      mkdirSync(dir, { recursive: true });
      pruneOldLogs(dir);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      return join(dir, `debug-${ts}.log`);
    })()
  : null;

export function debug(tag: string, message: string, data?: unknown): void {
  if (!logFile) return;
  const line = `[${new Date().toISOString()}] [${tag}] ${message}${data !== undefined ? '\n' + JSON.stringify(data, null, 2) : ''}\n`;
  appendFileSync(logFile, line);
}

export { enabled as debugEnabled, logFile as debugLogFile };
