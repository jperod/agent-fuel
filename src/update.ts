import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './config.js';
import { debug } from './debug.js';

const CACHE_FILE = path.join(CONFIG_DIR, 'update-cache.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  lastChecked: number;
  latestVersion: string;
}

function isNewer(v1: string, v2: string): boolean {
  const parse = (s: string) => s.replace(/^v/, '').split('.').map(Number);
  const [major1, minor1, patch1] = parse(v1);
  const [major2, minor2, patch2] = parse(v2);

  if (major2 !== major1) return major2 > major1;
  if (major2 === major1 && minor2 !== minor1) return minor2 > minor1;
  return patch2 > patch1;
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

    const data = await res.json() as { version: string };
    const latestVersion = data.version;

    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      lastChecked: Date.now(),
      latestVersion
    }), 'utf8');

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
    const needsCheck = !cache || (now - cache.lastChecked > CHECK_INTERVAL_MS);

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

    if (cache && isNewer(currentVersion, cache.latestVersion)) {
      return cache.latestVersion;
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
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      return resolve();
    }

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

    rl.question(`\n${BOLD}${CYAN}🔔 Update Available:${R} A new version (${GREEN}v${latestVersion}${R}) of agent-fuel is available.\nWould you like to install it now? [y/N]: `, (answer) => {
      clearTimeout(promptTimeout);
      rl.close();
      
      const cleanAnswer = answer.trim().toLowerCase();
      if (cleanAnswer === 'y' || cleanAnswer === 'yes') {
        console.log(`\n${BOLD}Updating agent-fuel to v${latestVersion}...${R}`);
        
        const result = spawnSync('npm', ['install', '-g', 'agent-fuel'], {
          stdio: 'inherit'
        });

        if (result.status === 0) {
          console.log(`\n${BOLD}${GREEN}✓ Successfully updated!${R} Please restart agent-fuel to use version v${latestVersion}.\n`);
        } else {
          console.error(`\n${BOLD}${RED}✗ Update failed.${R} You may need administrative privileges. Please try running:`);
          console.error(`  ${BOLD}sudo npm install -g agent-fuel${R}\n`);
        }
      }
      resolve();
    });
  });
}
