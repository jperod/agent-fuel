import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const enabled = process.argv.includes('--debug');
const MAX_DEBUG_LOGS = 10;

function pruneOldLogs(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter(f => f.startsWith('debug-') && f.endsWith('.log'))
      .map(f => ({
        path: join(dir, f),
        time: statSync(join(dir, f)).mtimeMs
      }));

    if (files.length <= MAX_DEBUG_LOGS) return;

    // Sort by modification time, oldest first
    files.sort((a, b) => a.time - b.time);

    const toDeleteCount = files.length - MAX_DEBUG_LOGS;
    for (let i = 0; i < toDeleteCount; i++) {
      try {
        unlinkSync(files[i].path);
      } catch {
        // ignore individual deletions if they fail
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
