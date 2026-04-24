import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChalkBagError } from '../types.js';
import { isPathIgnored } from '../scope.js';
import type { ProviderId } from '../providers/registry.js';

export type WatchMode = 'repo' | 'parent';

export type WatchedPath = {
  path: string;
  mode: WatchMode;
  providers: ProviderId[];
  ignore: string[];
  installedAt: string;
};

export type Registry = {
  version: 1;
  paths: WatchedPath[];
};

const HEARTBEAT_STALE_MS = 90_000;

/**
 * Returns the config home directory for chalkbag.
 *
 * Reads from `CHALKBAG_CONFIG_HOME` env var, or defaults to
 * `~/.config/chalkbag`. Validates that the value is absolute and contains no
 * control characters before returning.
 *
 * @throws {ChalkBagError} if the resolved path is not absolute or contains control characters.
 */
export function getConfigHome(): string {
  const raw = process.env.CHALKBAG_CONFIG_HOME ?? path.join(os.homedir(), '.config', 'chalkbag');
  // eng M-1: validate absolute + no control chars BEFORE using the value
  if (!path.isAbsolute(raw)) {
    throw new ChalkBagError({
      kind: 'config',
      file: 'CHALKBAG_CONFIG_HOME',
      message: `CHALKBAG_CONFIG_HOME must be an absolute path (got: ${raw})`,
      fix: 'set CHALKBAG_CONFIG_HOME to an absolute path or unset to use ~/.config/chalkbag',
    });
  }
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      throw new ChalkBagError({
        kind: 'config',
        file: 'CHALKBAG_CONFIG_HOME',
        message: 'CHALKBAG_CONFIG_HOME contains control characters',
        fix: 'set CHALKBAG_CONFIG_HOME to a clean absolute path',
      });
    }
  }
  return raw;
}

/** Returns the absolute path to `registry.json`. */
export function getRegistryPath(): string {
  return path.join(getConfigHome(), 'registry.json');
}

/** Returns the absolute path to the heartbeat file. */
export function getHeartbeatPath(): string {
  return path.join(getConfigHome(), 'heartbeat');
}

/** Returns the absolute path to the logs directory. */
export function getLogDir(): string {
  return path.join(getConfigHome(), 'logs');
}

/** Returns the absolute path to the launchd plist for the chalkbag daemon. */
export function getLaunchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.chalkbag.daemon.plist');
}

/** Returns the absolute path to the pause flag file. */
export function getPauseFlagPath(): string {
  return path.join(getConfigHome(), 'paused');
}

/**
 * Reads the registry from disk.
 *
 * Returns an empty registry if the file does not exist yet. Throws a
 * `ChalkBagError` with `kind: 'config'` on corrupt JSON, missing `version`,
 * or invalid schema — no silent data loss (eng M-3).
 */
export async function readRegistry(): Promise<Registry> {
  const p = getRegistryPath();
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== 'object') {
      throw new Error('registry is not an object');
    }
    const obj = parsed as Record<string, unknown>;
    if (obj['version'] !== 1) {
      throw new Error(`unsupported registry version: ${String(obj['version'])}`);
    }
    if (!Array.isArray(obj['paths'])) {
      throw new Error('registry.paths must be an array');
    }
    return { version: 1, paths: (obj['paths'] as unknown[]).map(normalizeEntry) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, paths: [] };
    }
    throw new ChalkBagError({
      kind: 'config',
      file: p,
      message: 'registry.json is corrupt or unreadable',
      cause: error,
      fix: `fix the file manually or delete it to start fresh (backup first: cp ${p} ${p}.bak)`,
    });
  }
}

/**
 * Writes the registry to disk atomically via a temp-file + rename.
 *
 * Creates the config home directory if it does not exist.
 */
export async function writeRegistry(registry: Registry): Promise<void> {
  const p = getRegistryPath();
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  try {
    await fs.promises.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, p);
  } catch (error) {
    // Clean up temp file on failure (best-effort)
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw new ChalkBagError({
      kind: 'io',
      file: p,
      message: 'failed to write registry.json',
      cause: error,
      fix: `check write permissions on ${path.dirname(p)}`,
    });
  }
}

const REGISTRY_LOCK_TIMEOUT_MS = 5000;
const REGISTRY_LOCK_POLL_MS = 50;

async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(getConfigHome(), 'registry.lock');
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      if (Date.now() - start >= REGISTRY_LOCK_TIMEOUT_MS) {
        throw new ChalkBagError({
          kind: 'lock',
          file: lockPath,
          message: `timed out waiting for registry lock after ${REGISTRY_LOCK_TIMEOUT_MS}ms`,
          fix: `if no other chalkbag process is running, delete the lock file: rm ${lockPath}`,
        });
      }
      await new Promise((r) => setTimeout(r, REGISTRY_LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.promises.rm(lockPath, { force: true });
  }
}

/**
 * Adds a path entry to the registry.
 *
 * Enforces overlap invariants (eng C-1):
 * - Rejects if the exact path is already registered.
 * - Rejects if the new path is a descendant of an existing `parent`-mode entry.
 * - Rejects if the new path is `parent` mode and an existing entry is a descendant of it.
 *
 * Deduplicates and sorts `providers` and `ignore` arrays before persisting.
 */
export async function addPath(entry: Omit<WatchedPath, 'installedAt'>): Promise<void> {
  await withRegistryLock(async () => {
    const registry = await readRegistry();
    const newPath = path.resolve(entry.path);

    for (const existing of registry.paths) {
      const e = path.resolve(existing.path);

      if (e === newPath) {
        throw new ChalkBagError({
          kind: 'config',
          file: newPath,
          message: `path is already registered: ${newPath}`,
          fix: 'use `chalkbag unregister` first if you want to change its mode or providers',
        });
      }

      // New path is a child of an existing parent entry
      if (existing.mode === 'parent' && isDescendant(e, newPath)) {
        throw new ChalkBagError({
          kind: 'config',
          file: newPath,
          message: `${newPath} is already covered by parent entry ${e}`,
          fix: `unregister ${e}, or register ${newPath} with ignore patterns from the parent`,
        });
      }

      // New parent entry would contain an existing entry
      if (entry.mode === 'parent' && isDescendant(newPath, e)) {
        throw new ChalkBagError({
          kind: 'config',
          file: newPath,
          message: `parent ${newPath} would cover existing entry ${e}`,
          fix: `unregister ${e} first, or choose a more specific parent`,
        });
      }
    }

    registry.paths.push({
      ...entry,
      path: newPath,
      installedAt: new Date().toISOString(),
      providers: [...new Set(entry.providers)].sort(),
      ignore: [...new Set(entry.ignore)].sort(),
    });

    await writeRegistry(registry);
  });
}

/**
 * Removes a path entry from the registry.
 *
 * @returns `true` if the entry was found and removed; `false` if not found.
 */
export async function removePath(target: string): Promise<boolean> {
  return withRegistryLock(async () => {
    const registry = await readRegistry();
    const resolved = path.resolve(target);
    const before = registry.paths.length;
    registry.paths = registry.paths.filter((p) => path.resolve(p.path) !== resolved);
    if (registry.paths.length === before) {
      return false;
    }
    await writeRegistry(registry);
    return true;
  });
}

/**
 * Finds the registry entry that covers the given target path.
 *
 * Uses longest-match — a `repo` entry beats a `parent` entry when both match
 * the same path, since the repo entry path string is longer (eng C-1).
 * Respects `ignore` patterns configured on each entry.
 *
 * @returns the matching `WatchedPath`, or `null` if no entry covers the target.
 */
export async function findPathFor(target: string): Promise<WatchedPath | null> {
  const registry = await readRegistry();
  const resolved = path.resolve(target);

  const candidates = registry.paths
    .map((entry) => ({ entry, resolved: path.resolve(entry.path) }))
    .filter(({ entry, resolved: e }) => {
      if (isPathIgnored(e, resolved, entry.ignore)) {
        return false;
      }
      if (entry.mode === 'repo') {
        return resolved === e;
      }
      // parent: resolved is the entry itself or a descendant
      return resolved === e || isDescendant(e, resolved);
    })
    .sort((a, b) => b.resolved.length - a.resolved.length);

  return candidates[0]?.entry ?? null;
}

/**
 * Convenience shim for render.ts consumer — returns `{ providers, ignore }`
 * for the entry watching the given repo root, or `null` if unregistered.
 */
export async function getRegistrationForRepo(
  repoRoot: string,
): Promise<{ providers: ProviderId[]; ignore: string[] } | null> {
  const entry = await findPathFor(repoRoot);
  if (!entry) {
    return null;
  }
  return { providers: entry.providers, ignore: entry.ignore };
}

/**
 * Writes the current timestamp (ms since epoch) to the heartbeat file,
 * creating the config home directory if needed.
 */
export async function touchHeartbeat(timestamp = Date.now()): Promise<void> {
  const heartbeatPath = getHeartbeatPath();
  await fs.promises.mkdir(path.dirname(heartbeatPath), { recursive: true });
  await fs.promises.writeFile(heartbeatPath, `${timestamp}\n`, 'utf8');
}

/**
 * Reads the heartbeat timestamp from disk.
 *
 * @returns the timestamp in milliseconds, or `null` if the file is missing or unreadable.
 */
export async function readHeartbeat(): Promise<number | null> {
  try {
    const raw = await fs.promises.readFile(getHeartbeatPath(), 'utf8');
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Returns `true` if the heartbeat is older than 90 seconds (or missing).
 */
export async function isHeartbeatStale(now = Date.now()): Promise<boolean> {
  const hb = await readHeartbeat();
  if (hb === null) {
    return true;
  }
  return now - hb > HEARTBEAT_STALE_MS;
}

/**
 * Returns `true` if the daemon pause flag file is present.
 *
 * When paused, the daemon skips starting watchers but continues to heartbeat.
 */
export async function hasPauseFlag(): Promise<boolean> {
  try {
    await fs.promises.access(getPauseFlagPath());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `child` is a strict descendant of `parent`.
 * Both paths must be absolute and already resolved.
 */
function isDescendant(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Validates and normalises a raw registry entry from disk.
 * Throws a plain `Error` on bad shape (wrapped by `readRegistry` into `ChalkBagError`).
 */
function normalizeEntry(raw: unknown): WatchedPath {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('registry entry is not an object');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj['path'] !== 'string' || obj['path'].length === 0) {
    throw new Error(`registry entry has invalid path: ${String(obj['path'])}`);
  }
  if (obj['mode'] !== 'repo' && obj['mode'] !== 'parent') {
    throw new Error(`registry entry has invalid mode: ${String(obj['mode'])}`);
  }
  if (!Array.isArray(obj['providers'])) {
    throw new Error('registry entry providers must be an array');
  }
  if (!Array.isArray(obj['ignore'])) {
    throw new Error('registry entry ignore must be an array');
  }
  if (typeof obj['installedAt'] !== 'string') {
    throw new Error('registry entry installedAt must be a string');
  }

  return {
    path: obj['path'] as string,
    mode: obj['mode'] as WatchMode,
    providers: (obj['providers'] as unknown[]).map((p) => {
      if (typeof p !== 'string') throw new Error(`provider id must be a string, got ${String(p)}`);
      return p as ProviderId;
    }),
    ignore: (obj['ignore'] as unknown[]).map((g) => {
      if (typeof g !== 'string') throw new Error(`ignore glob must be a string, got ${String(g)}`);
      return g;
    }),
    installedAt: obj['installedAt'] as string,
  };
}
