import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, writePrivateFileSync } from './config.js';
import { debug } from './debug.js';
import { sanitizeTerminalText } from './tmux.js';

const CACHE_FILE = path.join(CONFIG_DIR, 'update-cache.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

interface UpdateCache {
  lastChecked: number;
  latestVersion: string;
}

/** Validates a semver version string (without build metadata). */
export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version.trim());
}

/** Returns true if candidate `v2` is a newer release than `v1`, ignoring prereleases when current is stable. */
export function isNewer(v1: string, v2: string): boolean {
  const m1 = v1.trim().match(SEMVER_RE);
  const m2 = v2.trim().match(SEMVER_RE);
  if (!m1 || !m2) return false;

  const [major1, minor1, patch1] = [Number(m1[1]), Number(m1[2]), Number(m1[3])];
  const [major2, minor2, patch2] = [Number(m2[1]), Number(m2[2]), Number(m2[3])];
  const pre1 = m1[4];
  const pre2 = m2[4];

  // Do not offer prereleases to stable installations
  if (pre2) return false;
  if (major2 !== major1) return major2 > major1;
  if (minor2 !== minor1) return minor2 > minor1;
  if (patch2 !== patch1) return patch2 > patch1;
  return Boolean(pre1) && !pre2;
}

/**
 * Executes the actual registry fetch and updates the cache.
 * Called only inside the detached background process.
 */
export async function runUpdateCheckNow(currentVersion: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch('https://registry.npmjs.org/agent-fuel/latest', {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) return;

    const data = await res.json() as { version?: unknown };
    if (typeof data?.version !== 'string' || !isValidSemver(data.version)) return;
    const latestVersion = data.version.trim().replace(/^v/, '');

    writePrivateFileSync(CACHE_FILE, JSON.stringify({
      lastChecked: Date.now(),
      latestVersion
    }));

    debug('update:check', `Background query saved latest: ${latestVersion}`);
  } catch (err) {
    debug('update:check', 'Failed to fetch latest version', String(err));
  }
}

/**
 * Inspects cache. If expired, spawns a detached version of the CLI to query npm.
 * Returns the latest version string if the cache already contains a confirmed update.
 */
export function checkUpdateBackground(currentVersion: string): string | null {
  try {
    let cache: UpdateCache | null = null;
    if (fs.existsSync(CACHE_FILE)) {
      try {
        cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      } catch { /* ignore corrupted */ }
    }

    const now = Date.now();
    const needsCheck = !cache || !Number.isFinite(cache.lastChecked) || (now - cache.lastChecked > CHECK_INTERVAL_MS);

    if (needsCheck) {
      debug('update:check', 'Cache expired or missing. Spawning detached check process.');
      
      const currentFile = fileURLToPath(import.meta.url);
      const entryPoint = path.join(path.dirname(currentFile), 'index.js');

      // Spawn detached self. stdout/stderr MUST be ignored to allow detached exit.
      const child = spawn(process.execPath, [entryPoint, '--check-update-now'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref(); // Release node loop hold on child process
    }

    if (
      cache &&
      typeof cache.latestVersion === 'string' &&
      isValidSemver(cache.latestVersion) &&
      isNewer(currentVersion, cache.latestVersion)
    ) {
      return cache.latestVersion.trim().replace(/^v/, '');
    }
  } catch (err) {
    debug('update:check', 'Error during background update evaluation', String(err));
  }
  return null;
}

/**
 * Prompts the user with a 2-minute timeout to prevent blocking.
 */
export function promptAndUpgrade(latestVersion: string): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdout.isTTY || !process.stdin.isTTY || !isValidSemver(latestVersion)) {
      return resolve();
    }
    const safeVersion = sanitizeTerminalText(latestVersion.trim().replace(/^v/, ''));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const BOLD = '\x1b[1m';
    const CYAN = '\x1b[36m';
    const GREEN = '\x1b[32m';
    const RED = '\x1b[31m';
    const R = '\x1b[0m';

    // Auto-decline and exit after 2 minutes if user is away
    const promptTimeout = setTimeout(() => {
      rl.close();
      console.log(`\n${RED}⏰ Update prompt timed out (skipped).${R}\n`);
      resolve();
    }, 120000); // 2 minutes

    rl.question(`\n${BOLD}${CYAN}🔔 Update Available:${R} A new version (${GREEN}v${safeVersion}${R}) of agent-fuel is available.\nWould you like to install it now? [y/N]: `, (answer) => {
      clearTimeout(promptTimeout);
      rl.close();
      
      const cleanAnswer = answer.trim().toLowerCase();
      if (cleanAnswer === 'y' || cleanAnswer === 'yes') {
        console.log(`\n${BOLD}Updating agent-fuel to v${safeVersion}...${R}`);
        
        const result = spawnSync('npm', ['install', '-g', 'agent-fuel'], {
          stdio: 'inherit'
        });

        if (result.status === 0) {
          console.log(`\n${BOLD}${GREEN}✓ Successfully updated!${R} Please restart agent-fuel to use version v${safeVersion}.\n`);
        } else {
          console.error(`\n${BOLD}${RED}✗ Update failed.${R} Check npm global directory permissions (or use a user-scoped prefix / nvm) and re-run:`);
          console.error(`  ${BOLD}npm install -g agent-fuel${R}\n`);
        }
      }
      resolve();
    });
  });
}
