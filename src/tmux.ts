import { execFileSync } from 'node:child_process';
import { debug } from './debug.js';

export class TuiScraper {
  readonly sessionId: string;

  constructor(
    private readonly command: string,
    private readonly width = 220,
    private readonly height = 50,
  ) {
    this.sessionId = `af-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  start(): void {
    try {
      execFileSync('which', ['tmux'], { stdio: 'ignore' });
    } catch {
      throw new Error('tmux not found — install with: brew install tmux');
    }
    debug('tmux', `starting session ${this.sessionId} for command: ${this.command}`);
    execFileSync('tmux', [
      'new-session', '-d', '-s', this.sessionId,
      '-x', String(this.width), '-y', String(this.height),
      this.command,
    ]);
  }

  // historyLines > 0 → include that many lines of scrollback above the visible screen.
  // This catches transient overlays that rendered and then re-rendered away.
  capture(historyLines = 0): string {
    const args = historyLines > 0
      ? ['capture-pane', '-t', this.sessionId, '-S', `-${historyLines}`, '-p']
      : ['capture-pane', '-t', this.sessionId, '-p'];
    const text = execFileSync('tmux', args).toString();
    debug('tmux:capture', `[${this.sessionId}] captured ${text.length} chars (history=${historyLines})`);
    return text;
  }

  send(text: string): void {
    debug('tmux:send', `[${this.sessionId}] sending: ${JSON.stringify(text)}`);
    execFileSync('tmux', ['send-keys', '-t', this.sessionId, text, 'Enter']);
  }

  // Send a named key (Tab, Escape, Up, Down, etc.) without appending Enter.
  sendKey(key: string): void {
    debug('tmux:send', `[${this.sessionId}] sendKey: ${key}`);
    execFileSync('tmux', ['send-keys', '-t', this.sessionId, key]);
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
      execFileSync('tmux', ['kill-session', '-t', this.sessionId], { stdio: 'ignore' });
    } catch { /* already dead */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}
