import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ChalkBagError } from '../types.js';
import { getConfigHome, getSystemdUnitPath } from './registry.js';

/** The systemd user unit name for the chalkbag daemon. */
export const SYSTEMD_UNIT_NAME = 'chalkbag.service';

/** Result of a single `systemctl` invocation. */
export type SystemctlResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * The exec seam. Every `systemctl` call flows through a function of this shape,
 * so tests inject a recorder/mock and never touch the real `systemctl` binary.
 * The default implementation shells out via `spawnSync` and never throws — a
 * missing binary surfaces as `status: null`.
 */
export type ExecFn = (file: string, args: string[]) => SystemctlResult;

const defaultExec: ExecFn = (file, args) => {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/**
 * Builds the systemd user-unit file content for the chalkbag daemon.
 *
 * Runs the same daemon entry the launchd plist runs. `Restart=always` mirrors
 * the launchd `KeepAlive` behaviour, and `RestartSec=10` mirrors launchd's
 * `ThrottleInterval`. stdout/stderr are left on the default sinks so they are
 * captured by the systemd journal.
 *
 * Values are validated (absolute configHome, no control characters) and `%`
 * is escaped to `%%` so systemd specifier expansion cannot corrupt a path or
 * inject additional directives (eng M-1 parity with the launchd renderer).
 * Each embedded value is then systemd-double-quoted so a space in the node,
 * entry, or config path does not mis-split into multiple arguments.
 */
export function buildSystemdUnit(options: {
  nodePath: string;
  entryPath: string;
  configHome: string;
}): string {
  validateConfigHomeSafe(options.configHome);
  assertNoControlChars(options.nodePath, 'nodePath');
  assertNoControlChars(options.entryPath, 'entryPath');

  const nodePath = systemdQuote(escapeSpecifiers(options.nodePath));
  const entryPath = systemdQuote(escapeSpecifiers(options.entryPath));
  const configHome = systemdQuote(escapeSpecifiers(options.configHome));

  return `[Unit]
Description=chalkbag daemon (compiles .chalk/ into provider configs)
Documentation=https://github.com/donovan-yohan/chalk-bag
After=default.target

[Service]
Type=simple
ExecStart=${nodePath} ${entryPath}
Environment=CHALKBAG_CONFIG_HOME=${configHome}
Restart=always
RestartSec=10
# stdout and stderr are captured by the systemd journal:
#   journalctl --user -u chalkbag.service

[Install]
WantedBy=default.target
`;
}

/**
 * Installs (or reinstalls) the systemd user unit from the provided content.
 *
 * Writes the unit to `~/.config/systemd/user/chalkbag.service` (respecting
 * `XDG_CONFIG_HOME`), then runs `systemctl --user daemon-reload` and
 * `systemctl --user enable --now chalkbag.service`.
 *
 * Platform gating lives in the dispatcher (`service.ts`); this function is
 * platform-agnostic so it is fully unit-testable via an injected {@link ExecFn}.
 *
 * @throws {ChalkBagError} with `kind: 'daemon'` when the user session bus is
 *   unavailable, or when a `systemctl` command fails.
 */
export async function installSystemdUnit(unitContent: string, exec: ExecFn = defaultExec): Promise<void> {
  assertUserSystemdAvailable(exec);

  const unitPath = getSystemdUnitPath();
  await fs.promises.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.promises.writeFile(unitPath, unitContent, 'utf8');

  runSystemctlChecked(exec, ['daemon-reload']);
  runSystemctlChecked(exec, ['enable', '--now', SYSTEMD_UNIT_NAME]);
}

/**
 * Reloads the systemd user unit with updated content.
 *
 * Rewrites the unit, then runs `systemctl --user daemon-reload` and
 * `systemctl --user restart chalkbag.service`.
 */
export async function reloadSystemdUnit(unitContent: string, exec: ExecFn = defaultExec): Promise<void> {
  assertUserSystemdAvailable(exec);

  const unitPath = getSystemdUnitPath();
  await fs.promises.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.promises.writeFile(unitPath, unitContent, 'utf8');

  runSystemctlChecked(exec, ['daemon-reload']);
  runSystemctlChecked(exec, ['restart', SYSTEMD_UNIT_NAME]);
}

/**
 * Uninstalls the systemd user unit and removes its file.
 *
 * Runs `systemctl --user disable --now chalkbag.service` (best-effort — the
 * unit may not be loaded and the bus may be flaky), removes the unit file, then
 * runs `systemctl --user daemon-reload` (also best-effort). Never throws so the
 * unit file is always removed.
 */
export async function uninstallSystemdUnit(exec: ExecFn = defaultExec): Promise<void> {
  const unitPath = getSystemdUnitPath();

  // Best-effort: unit may not be loaded, or the session bus may be unavailable.
  runSystemctl(exec, ['disable', '--now', SYSTEMD_UNIT_NAME]);
  await fs.promises.rm(unitPath, { force: true });
  runSystemctl(exec, ['daemon-reload']);
}

/**
 * Returns the systemd `is-active` state for the chalkbag unit
 * (`active` / `inactive` / `failed` / ...), or `unknown` when `systemctl` is
 * unavailable. Read-only — never mutates unit state.
 */
export function getSystemdActiveState(exec: ExecFn = defaultExec): string {
  const result = runSystemctl(exec, ['is-active', SYSTEMD_UNIT_NAME]);
  if (result.status === null) {
    return 'unknown';
  }
  const state = result.stdout.trim();
  return state.length > 0 ? state : 'unknown';
}

/**
 * Builds unit content using paths derived from the current Node.js process and
 * the resolved config home. Convenience wrapper for the `daemon install` path.
 */
export function buildDefaultSystemdUnit(): string {
  return buildSystemdUnit({
    nodePath: process.execPath,
    entryPath: resolveEntryPath(),
    configHome: getConfigHome(),
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function runSystemctl(exec: ExecFn, args: string[]): SystemctlResult {
  return exec('systemctl', ['--user', ...args]);
}

function runSystemctlChecked(exec: ExecFn, args: string[]): void {
  const result = runSystemctl(exec, args);
  if (result.status !== 0) {
    throw new ChalkBagError({
      kind: 'daemon',
      file: getSystemdUnitPath(),
      message: `systemctl --user ${args.join(' ')} failed (exit ${result.status ?? 'null'})`,
      cause: result.stderr.trim() || undefined,
      fix: 'check `systemctl --user status chalkbag.service` and `journalctl --user -u chalkbag.service`; ensure a user session bus is available (headless boxes need `loginctl enable-linger $USER`), or run `chalkbag watch` as a fallback',
    });
  }
}

/**
 * Verifies that a systemd user session (D-Bus session bus) is reachable before
 * attempting a mutating command. Probes with `systemctl --user is-system-running`
 * — a `null` exit status (missing binary) or a bus-connection error indicates an
 * unusable user manager.
 *
 * @throws {ChalkBagError} with an actionable fix when the session is unavailable.
 */
function assertUserSystemdAvailable(exec: ExecFn): void {
  const probe = runSystemctl(exec, ['is-system-running']);
  const combined = `${probe.stdout}\n${probe.stderr}`;
  const state = probe.stdout.trim();
  const busDown =
    /Failed to connect to bus|Failed to get D-Bus connection|No medium found/i.test(combined) ||
    state === 'offline';

  if (probe.status === null || busDown) {
    throw new ChalkBagError({
      kind: 'daemon',
      file: getSystemdUnitPath(),
      message: 'systemd user session is unavailable (no D-Bus session bus)',
      fix: 'start a systemd user session, or on a headless box enable lingering so it survives logout: `loginctl enable-linger $USER`. To skip the daemon entirely, run the foreground watcher: `chalkbag watch`',
    });
  }
}

/**
 * Validates that a config home value is safe to embed in a unit file.
 * Must be absolute and contain no control characters.
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
  assertNoControlChars(configHome, 'configHome');
}

function assertNoControlChars(value: string, label: string): void {
  for (const ch of value) {
    if (ch.charCodeAt(0) < 0x20) {
      throw new ChalkBagError({
        kind: 'daemon',
        file: value,
        message: `${label} contains control characters — cannot write a safe systemd unit`,
        fix: 'use a clean absolute path without newlines or control characters',
      });
    }
  }
}

/** Escapes systemd specifier characters so a literal `%` is not expanded. */
function escapeSpecifiers(value: string): string {
  return value.replaceAll('%', '%%');
}

/**
 * Wraps a value in systemd double quotes, escaping the two characters that are
 * special inside a double-quoted systemd token: `\` and `"`. Backslash is
 * escaped first so the backslash introduced when escaping `"` is not re-escaped.
 * This keeps a path containing spaces from mis-splitting into multiple
 * ExecStart arguments (or truncating an Environment value).
 */
function systemdQuote(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function resolveEntryPath(): string {
  // When installed as a dist build, entry is dist/daemon/entry.js
  // When running via tsx in dev, entry is src/daemon/entry.ts
  return fileURLToPath(new URL('../daemon/entry.js', import.meta.url));
}
