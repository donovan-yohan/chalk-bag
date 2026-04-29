import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ChalkBagError } from '../types.js';
import { getLaunchdPlistPath, getLogDir, getConfigHome } from './registry.js';

/**
 * Builds the launchd plist XML string for the chalkbag daemon.
 *
 * The `configHome` value is validated (absolute, no control chars) before
 * interpolation to prevent plist injection (eng M-1).
 */
export function buildLaunchdPlist(options: {
  nodePath: string;
  entryPath: string;
  configHome: string;
}): string {
  validateConfigHomeSafe(options.configHome);

  const logDir = path.join(options.configHome, 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.chalkbag.daemon</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(options.nodePath)}</string>
      <string>${escapeXml(options.entryPath)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CHALKBAG_CONFIG_HOME</key>
      <string>${escapeXml(options.configHome)}</string>
    </dict>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(`${logDir}/chalkbag.log`)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(`${logDir}/chalkbag.log`)}</string>
  </dict>
</plist>
`;
}

/**
 * Installs (or reinstalls) the launchd agent from the provided plist content.
 *
 * Writes the plist to `~/Library/LaunchAgents/com.chalkbag.daemon.plist`,
 * then runs `launchctl bootout` + `launchctl bootstrap` to activate it.
 * No-ops on non-macOS platforms.
 *
 * @throws {ChalkBagError} with `kind: 'daemon'` if `launchctl bootstrap` fails.
 */
export async function installLaunchdAgent(plistContent: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }

  const plistPath = getLaunchdPlistPath();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  await fs.promises.mkdir(getLogDir(), { recursive: true });
  await fs.promises.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.promises.writeFile(plistPath, plistContent, 'utf8');

  if (uid === null) {
    return;
  }

  // Bootout first — ignore errors (agent may not be loaded yet)
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], {
      stdio: 'ignore',
    });
  } catch {
    // Intentionally swallowed — agent may not have been running
  }

  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
      stdio: 'ignore',
    });
  } catch (error) {
    throw new ChalkBagError({
      kind: 'daemon',
      file: plistPath,
      message: 'failed to bootstrap launchd agent (com.chalkbag.daemon)',
      cause: error,
      fix: 'check that the plist is valid and that you have launchctl access; try `launchctl list | grep chalkbag` to diagnose',
    });
  }
}

/**
 * Reloads the launchd agent with updated plist content.
 *
 * Equivalent to uninstall + reinstall — calls `installLaunchdAgent` which
 * does bootout before bootstrap.
 */
export async function reloadLaunchdAgent(plistContent: string): Promise<void> {
  await installLaunchdAgent(plistContent);
}

/**
 * Uninstalls the launchd agent and removes its plist file.
 *
 * Runs `launchctl bootout` to stop the running agent, then deletes the plist.
 * No-ops on non-macOS platforms.
 */
export async function uninstallLaunchdAgent(): Promise<void> {
  const plistPath = getLaunchdPlistPath();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  if (process.platform === 'darwin' && uid !== null) {
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], {
        stdio: 'ignore',
      });
    } catch {
      // Intentionally swallowed — agent may not have been running
    }
  }

  await fs.promises.rm(plistPath, { force: true });
}

/**
 * Returns the launchd agent status for the running user via `launchctl list`.
 *
 * @returns the raw launchctl output, or a message indicating the daemon is not loaded.
 */
export async function getLaunchdStatus(): Promise<string> {
  if (process.platform !== 'darwin') {
    return 'daemon install: platform unsupported (macOS only)';
  }

  try {
    const output = execFileSync('launchctl', ['list', 'com.chalkbag.daemon'], {
      encoding: 'utf8',
    });
    return output.trim();
  } catch {
    return 'com.chalkbag.daemon: not loaded';
  }
}

/**
 * Builds plist content using paths derived from the current Node.js process
 * and the resolved config home.
 *
 * Convenience wrapper for the `daemon install` CLI command.
 */
export async function buildDefaultLaunchdPlist(): Promise<string> {
  const nodePath = process.execPath;
  const entryPath = resolveEntryPath();
  const configHome = getConfigHome();

  return buildLaunchdPlist({ nodePath, entryPath, configHome });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validates that a config home value is safe to embed in a plist.
 * Must be absolute and contain no control characters.
 *
 * @throws {ChalkBagError} with `kind: 'daemon'` on violation.
 */
function validateConfigHomeSafe(configHome: string): void {
  if (!path.isAbsolute(configHome)) {
    throw new ChalkBagError({
      kind: 'daemon',
      file: configHome,
      message: `configHome must be an absolute path (got: ${configHome})`,
      fix: 'set CHALKBAG_CONFIG_HOME to an absolute path or unset to use ~/.config/chalkbag',
    });
  }
  for (const ch of configHome) {
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      throw new ChalkBagError({
        kind: 'daemon',
        file: configHome,
        message: 'configHome contains control characters — cannot write safe plist',
        fix: 'set CHALKBAG_CONFIG_HOME to a clean absolute path',
      });
    }
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function resolveEntryPath(): string {
  // When installed as a dist build, entry is dist/daemon/entry.js
  // When running via tsx in dev, entry is src/daemon/entry.ts
  const distEntry = fileURLToPath(new URL('../daemon/entry.js', import.meta.url));
  return distEntry;
}
