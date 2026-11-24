import { execFileSync } from 'node:child_process';
import fs, { unlinkSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { debug } from './debug.js';
import {
  CONFIG_DIR,
  ensurePrivateDir,
  getSafeWorkingDir,
  isSafeCommandString,
  isValidEnvKey,
  redactEnv,
} from './config.js';

function ensureSafeTmuxDir(): void {
  if (process.env.TMUX_TMPDIR) return;
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const tmpCandidate = path.join(os.tmpdir(), `af-tmux-${uid}`);
    if (ensurePrivateDir(tmpCandidate)) {
      process.env.TMUX_TMPDIR = tmpCandidate;
      return;
    }
    // If /tmp/af-tmux-${uid} was pre-created by another user or is a symlink,
    // use a private subdir under CONFIG_DIR or a unique mkdtemp dir instead.
    const configTmuxDir = path.join(CONFIG_DIR, 'tmux');
    if (ensurePrivateDir(configTmuxDir)) {
      process.env.TMUX_TMPDIR = configTmuxDir;
      return;
    }
    process.env.TMUX_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), `af-tmux-${uid}-`));
  } catch {
    // ignore
  }
}

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

export function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Single-quotes a string for safe POSIX shell evaluation. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Merges validated account env overrides into process.env, expanding leading tildes. */
export function resolveEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (!isValidEnvKey(k)) continue;
      merged[k] = expandTilde(v);
    }
  }
  return merged;
}

/** Validates a configured command string and returns it trimmed. */
export function assertSafeCommand(cmd: string): string {
  const trimmed = cmd.trim();
  if (!isSafeCommandString(trimmed)) {
    throw new Error(`Unsafe CLI command rejected: ${JSON.stringify(cmd)}`);
  }
  return trimmed;
}

/** Builds a safely-quoted `env KEY='VAL' <cmd> 'arg1' ...` string for interactive shell alias resolution. */
export function buildInteractiveShellCommand(
  cmd: string,
  env?: Record<string, string>,
  extraArgs: string[] = [],
): string {
  const safeCmd = assertSafeCommand(cmd);
  const envEntries = env
    ? Object.entries(env).filter(([k]) => isValidEnvKey(k))
    : [];
  const envPrefix = envEntries.length > 0
    ? 'env ' + envEntries.map(([k, v]) => `${k}=${shellQuote(expandTilde(v))}`).join(' ') + ' '
    : '';
  const quotedExtra = extraArgs.length > 0
    ? ' ' + extraArgs.map(a => shellQuote(a)).join(' ')
    : '';
  return `${envPrefix}${safeCmd}${quotedExtra}`;
}

/** Strips ANSI CSI/OSC escape sequences and non-printable control chars from captured terminal text. */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    .replace(/\x1B[^[]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '');
}

/** Strips terminal escape sequences, control characters, and line breaks for single-line UI output. */
export function sanitizeTerminalText(str: string): string {
  return stripAnsi(str).replace(/[\r\n\t]+/g, ' ');
}

export class TuiScraper {
  readonly sessionId: string;
  private lastCaptured = '';

  constructor(
    private readonly command: string,
    private readonly env?: Record<string, string>,
    private readonly width = 220,
    private readonly height = 50,
    private readonly extraArgs: string[] = [],
  ) {
    this.sessionId = `af-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  isAlive(): boolean {
    try {
      execFileSync('tmux', ['has-session', '-t', this.sessionId], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    ensureSafeTmuxDir();
    try {
      execFileSync('which', ['tmux'], { stdio: 'ignore', timeout: 5000 });
    } catch {
      throw new Error('tmux not found — install with: brew install tmux');
    }

    const fullCmd = buildInteractiveShellCommand(this.command, this.env, this.extraArgs);
    const userShell = process.env.SHELL || '/bin/sh';
    const cwd = getSafeWorkingDir();

    debug(
      'tmux',
      `starting session ${this.sessionId} for command ${JSON.stringify(this.command)} in ${cwd} via ${userShell}`,
      this.env ? { env: redactEnv(this.env), extraArgs: this.extraArgs } : undefined,
    );

    // Pass shell and args as separate argv entries so tmux invokes userShell directly
    // without passing fullCmd through an extra /bin/sh -c double-quote parse.
    const runArgs = [
      'new-session', '-d', '-s', this.sessionId,
      '-c', cwd,
      '-x', String(this.width), '-y', String(this.height),
      userShell, '-i', '-c', fullCmd,
    ];

    execFileSync('tmux', runArgs, { stdio: 'ignore', timeout: 5000 });
    activeScrapers.add(this);
  }

  // historyLines > 0 → include that many lines of scrollback above the visible screen.
  // This catches transient overlays that rendered and then re-rendered away.
  capture(historyLines = 0): string {
    const args = historyLines > 0
      ? ['capture-pane', '-t', this.sessionId, '-S', `-${historyLines}`, '-p']
      : ['capture-pane', '-t', this.sessionId, '-p'];
    try {
      const text = execFileSync('tmux', args, { stdio: 'pipe', timeout: 5000 }).toString();
      debug('tmux:capture', `[${this.sessionId}] captured ${text.length} chars (history=${historyLines})`);
      this.lastCaptured = text;
      return text;
    } catch (err) {
      debug('tmux:capture', `[${this.sessionId}] capture failed or session ended: ${String(err)}`);
      return this.lastCaptured;
    }
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
      const aliveBefore = this.isAlive();
      const text = this.capture(historyLines);
      if (aliveBefore && pattern.test(text)) {
        debug('tmux:waitFor', `[${this.sessionId}] matched ${pattern}`);
        return text;
      }
      if (!this.isAlive()) {
        debug('tmux:waitFor', `[${this.sessionId}] session exited early while waiting for ${pattern}`);
        throw new Error(`TuiScraper session exited early before matching ${pattern}`);
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
    activeScrapers.delete(this); // delete after kill attempt so a concurrent signal doesn't see a half-killed scraper
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}
