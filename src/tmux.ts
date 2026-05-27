import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import crypto from 'node:crypto';
import { debug } from './debug.js';

// Global registries for active resources
const activeScrapers = new Set<TuiScraper>();
const activeTempFiles = new Set<string>();

export function registerTempFile(filePath: string): void {
  activeTempFiles.add(filePath);
}

export function unregisterTempFile(filePath: string): void {
  activeTempFiles.delete(filePath);
}

function cleanupAll(): void {
  if (activeScrapers.size === 0 && activeTempFiles.size === 0) return;

  process.stderr.write(`\n\x1b[33m[agent-fuel] Clean up triggered. Cleaning up resources...\x1b[0m\n`);

  for (const scraper of activeScrapers) {
    try {
      scraper.kill();
    } catch {
      // ignore
    }
  }
  activeScrapers.clear();

  for (const file of activeTempFiles) {
    try {
      unlinkSync(file);
    } catch {
      // ignore
    }
  }
  activeTempFiles.clear();
}

// Register signal handlers eagerly at module load time so that any temp files
// registered before TuiScraper.start() (e.g. between registerTempFile and start())
// are still cleaned up on SIGINT/SIGTERM/SIGHUP.
let signalsRegistered = false;
function registerSignalHandlers(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;

  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const sig of signals) {
    process.on(sig, () => {
      cleanupAll();
      const code = sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 129;
      process.exit(code);
    });
  }

  process.on('uncaughtException', (err) => {
    process.stderr.write(`\x1b[31mUncaught Exception:\x1b[0m ${err.stack || err}\n`);
    cleanupAll();
    process.exit(1);
  });
}
registerSignalHandlers(); // called at import time — guarded by signalsRegistered flag

export class TuiScraper {
  readonly sessionId: string;

  constructor(
    private readonly command: string,
    private readonly width = 220,
    private readonly height = 50,
  ) {
    this.sessionId = `af-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  start(): void {
    try {
      execFileSync('which', ['tmux'], { stdio: 'ignore', timeout: 5000 });
    } catch {
      throw new Error('tmux not found — install with: brew install tmux');
    }
    debug('tmux', `starting session ${this.sessionId} for command: ${this.command}`);
    execFileSync('tmux', [
      'new-session', '-d', '-s', this.sessionId,
      '-x', String(this.width), '-y', String(this.height),
      this.command,
    ], { stdio: 'ignore', timeout: 5000 });
    activeScrapers.add(this);
  }

  // historyLines > 0 → include that many lines of scrollback above the visible screen.
  // This catches transient overlays that rendered and then re-rendered away.
  capture(historyLines = 0): string {
    const args = historyLines > 0
      ? ['capture-pane', '-t', this.sessionId, '-S', `-${historyLines}`, '-p']
      : ['capture-pane', '-t', this.sessionId, '-p'];
    const text = execFileSync('tmux', args, { timeout: 5000 }).toString();
    debug('tmux:capture', `[${this.sessionId}] captured ${text.length} chars (history=${historyLines})`);
    return text;
  }

  send(text: string): void {
    debug('tmux:send', `[${this.sessionId}] sending: ${JSON.stringify(text)}`);
    execFileSync('tmux', ['send-keys', '-t', this.sessionId, text, 'Enter'], { stdio: 'ignore', timeout: 5000 });
  }

  // Send a named key (Tab, Escape, Up, Down, etc.) without appending Enter.
  sendKey(key: string): void {
    debug('tmux:send', `[${this.sessionId}] sendKey: ${key}`);
    execFileSync('tmux', ['send-keys', '-t', this.sessionId, key], { stdio: 'ignore', timeout: 5000 });
  }

  async waitFor(pattern: RegExp, timeoutMs: number, historyLines = 500): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    debug('tmux:waitFor', `[${this.sessionId}] waiting for ${pattern} (timeout ${timeoutMs}ms, history=${historyLines})`);
    while (Date.now() < deadline) {
      const text = this.capture(historyLines);
      if (pattern.test(text)) {
        debug('tmux:waitFor', `[${this.sessionId}] matched ${pattern}`);
        return text;
      }
      await sleep(100);
    }
    const last = this.capture(historyLines);
    debug('tmux:waitFor', `[${this.sessionId}] TIMEOUT for ${pattern}, last screen:\n${last}`);
    throw new Error(`TuiScraper.waitFor timeout after ${timeoutMs}ms: ${pattern}`);
  }

  kill(): void {
    debug('tmux', `killing session ${this.sessionId}`);
    try {
      execFileSync('tmux', ['kill-session', '-t', this.sessionId], { stdio: 'ignore', timeout: 3000 });
    } catch { /* already dead */ }
    activeScrapers.delete(this); // delete after kill attempt so cleanupAll() can retry on timeout
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}
