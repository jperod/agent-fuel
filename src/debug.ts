import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const enabled = process.argv.includes('--debug');

const logFile = enabled
  ? (() => {
      const dir = join(process.cwd(), '.logs');
      mkdirSync(dir, { recursive: true });
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
