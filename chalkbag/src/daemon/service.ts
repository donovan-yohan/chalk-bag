import { ChalkBagError } from '../types.js';
import {
  buildDefaultLaunchdPlist,
  installLaunchdAgent,
  reloadLaunchdAgent,
  uninstallLaunchdAgent,
  getLaunchdStatus,
} from './launchd.js';
import {
  buildDefaultSystemdUnit,
  installSystemdUnit,
  reloadSystemdUnit,
  uninstallSystemdUnit,
  getSystemdActiveState,
  type ExecFn,
} from './systemd.js';
import {
  getLaunchdPlistPath,
  getSystemdUnitPath,
  isHeartbeatStale,
  hasPauseFlag,
} from './registry.js';

/**
 * Platform → service-manager dispatch for the chalkbag daemon.
 *
 * macOS uses launchd, Linux uses a systemd user unit. Any other platform is
 * unsupported and callers are pointed at the `chalkbag watch` foreground
 * fallback. This module is the only thing `cli.ts` talks to for daemon
 * lifecycle; the two backend modules (`launchd.ts`, `systemd.ts`) stay
 * independent and individually unit-tested.
 */

export type ServiceManagerId = 'launchd' | 'systemd';

export type ServiceDescription = {
  platform: NodeJS.Platform;
  manager: ServiceManagerId | null;
  unitPath: string | null;
};

export type DaemonStatus = ServiceDescription & {
  /** Manager-level liveness (systemd `is-active` / launchd summary). */
  active: string;
  heartbeatStale: boolean;
  paused: boolean;
};

/** Returns the service-manager id for the current platform, or `null`. */
export function currentServiceManager(): ServiceManagerId | null {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  return null;
}

/**
 * Describes the service manager for the current platform without invoking it —
 * safe for `chalkbag doctor` to call on any platform.
 */
export function describeServiceManager(): ServiceDescription {
  const manager = currentServiceManager();
  const unitPath =
    manager === 'launchd'
      ? getLaunchdPlistPath()
      : manager === 'systemd'
        ? getSystemdUnitPath()
        : null;
  return { platform: process.platform, manager, unitPath };
}

/** Installs and starts the daemon via the platform's service manager. */
export async function installDaemon(): Promise<ServiceDescription> {
  const manager = currentServiceManager();
  if (manager === 'launchd') {
    await installLaunchdAgent(await buildDefaultLaunchdPlist());
  } else if (manager === 'systemd') {
    await installSystemdUnit(buildDefaultSystemdUnit());
  } else {
    throw unsupportedPlatformError();
  }
  return describeServiceManager();
}

/** Rewrites the unit/plist and reloads the daemon. */
export async function reloadDaemon(): Promise<ServiceDescription> {
  const manager = currentServiceManager();
  if (manager === 'launchd') {
    await reloadLaunchdAgent(await buildDefaultLaunchdPlist());
  } else if (manager === 'systemd') {
    await reloadSystemdUnit(buildDefaultSystemdUnit());
  } else {
    throw unsupportedPlatformError();
  }
  return describeServiceManager();
}

/** Stops the daemon and removes its unit/plist. */
export async function uninstallDaemon(): Promise<ServiceDescription> {
  const manager = currentServiceManager();
  if (manager === 'launchd') {
    await uninstallLaunchdAgent();
  } else if (manager === 'systemd') {
    await uninstallSystemdUnit();
  } else {
    throw unsupportedPlatformError();
  }
  return describeServiceManager();
}

/**
 * Combines the service manager's liveness signal with the heartbeat-file
 * freshness check and pause flag, so `daemon status` and `doctor` report
 * coherently across platforms.
 */
export async function getDaemonStatus(exec?: ExecFn): Promise<DaemonStatus> {
  const description = describeServiceManager();
  const heartbeatStale = await isHeartbeatStale();
  const paused = await hasPauseFlag();

  let active: string;
  if (description.manager === 'launchd') {
    active = await getLaunchdStatus();
  } else if (description.manager === 'systemd') {
    active = getSystemdActiveState(exec);
  } else {
    active = 'unsupported platform (run `chalkbag watch` instead)';
  }

  return { ...description, active, heartbeatStale, paused };
}

function unsupportedPlatformError(): ChalkBagError {
  return new ChalkBagError({
    kind: 'daemon',
    file: process.platform,
    message: `daemon management is not supported on platform "${process.platform}"`,
    fix: 'chalkbag manages a background daemon via launchd (macOS) and systemd (Linux) only. On other platforms, run the foreground watcher instead: `chalkbag watch`',
  });
}
