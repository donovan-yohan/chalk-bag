import fs from 'node:fs';
import path from 'node:path';

import chokidar from 'chokidar';
import pLimit from 'p-limit';

import { buildGlobalScope } from './global.js';
import { buildAgentsRepo } from './render.js';
import { isPathIgnored } from './scope.js';
import type { ProviderId } from './providers/registry.js';
import { isChalkBagError } from './types.js';

/**
 * Format a watcher rebuild failure for the console: surface the repo
 * basename, the error kind (when ChalkBagError), and the failing file
 * relative to the scope root.
 */
function formatRebuildFailure(scopeRoot: string, error: unknown): string {
  const repoLabel = path.basename(scopeRoot) || scopeRoot;
  const kind = isChalkBagError(error) ? error.kind : 'error';
  const message = error instanceof Error ? error.message : String(error);
  const failingFile = isChalkBagError(error) && error.file ? toRepoRelative(scopeRoot, error.file) : null;
  const where = failingFile ? ` in ${failingFile}` : '';
  return `chalkbag watcher: ${repoLabel} build failed (${kind}${where}): ${message}`;
}

function toRepoRelative(scopeRoot: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(scopeRoot, file);
  const relative = path.relative(scopeRoot, absolute);
  if (relative === '' || relative.startsWith('..')) return file;
  return relative;
}

// Concurrency cap: at most 2 concurrent buildAgentsRepo calls across all scopes (eng M-2)
const BUILD_CONCURRENCY = pLimit(2);

// ---------------------------------------------------------------------------
// Repo watcher
// ---------------------------------------------------------------------------

type RepoWatcherOptions = {
  providers?: ProviderId[];
  yes?: boolean;
};

/**
 * Watches `<repoRoot>/.chalk/**` for changes and triggers a rebuild on each event.
 *
 * Equivalent to xt's `startAgentsWatcher`. Debounces events by 200ms.
 * Uses `BUILD_CONCURRENCY` (pLimit 2) to avoid stampede (eng M-2).
 *
 * @returns an object with `close()` to stop watching and `failed` promise that
 *   rejects if the watcher encounters a fatal error.
 */
export function startRepoWatcher(
  repoRoot: string,
  options: RepoWatcherOptions = {},
) {
  const agentsRoot = path.join(repoRoot, '.chalk');

  const ignored = [
    /\/\.chalk-tmp\//u,
    /\/\.chalk\/\.state\.lock$/u,
    /\/\.chalk\/\.state\.json$/u,
  ];

  const watcher = chokidar.watch(agentsRoot, {
    ignoreInitial: true,
    ignored,
    followSymlinks: false,
  });

  let debounceTimer: NodeJS.Timeout | undefined;
  let failReject: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    failReject = reject;
  });

  const queueRender = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void BUILD_CONCURRENCY(async () => {
        try {
          await buildAgentsRepo(repoRoot, { force: true, yes: true, providers: options.providers });
        } catch (error) {
          console.error(formatRebuildFailure(repoRoot, error));
        }
      });
    }, 200);
  };

  watcher.on('add', queueRender);
  watcher.on('change', queueRender);
  watcher.on('unlink', queueRender);
  watcher.on('error', (error) => {
    const typed = error instanceof Error ? error : new Error(String(error));
    console.error(`chalkbag watcher: watch error for ${repoRoot}: ${typed.message}`);
    failReject(typed);
  });

  return {
    close: async (): Promise<void> => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      await watcher.close();
    },
    failed,
  };
}

// ---------------------------------------------------------------------------
// Global watcher
// ---------------------------------------------------------------------------

/**
 * Watches the machine-level `<home>/.chalk/**` tree and rebuilds the global
 * scope on each change. Structurally identical to {@link startRepoWatcher} but
 * dispatches to {@link buildGlobalScope} instead of the per-repo build.
 */
export function startGlobalWatcher(homeRoot: string) {
  const agentsRoot = path.join(homeRoot, '.chalk');

  const ignored = [
    /\/\.chalk-tmp\//u,
    /\/\.chalk\/\.state\.lock$/u,
    /\/\.chalk\/\.state\.json$/u,
  ];

  const watcher = chokidar.watch(agentsRoot, {
    ignoreInitial: true,
    ignored,
    followSymlinks: false,
  });

  let debounceTimer: NodeJS.Timeout | undefined;
  let failReject: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    failReject = reject;
  });

  const queueRender = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void BUILD_CONCURRENCY(async () => {
        try {
          await buildGlobalScope({});
        } catch (error) {
          console.error(formatRebuildFailure(agentsRoot, error));
        }
      });
    }, 200);
  };

  watcher.on('add', queueRender);
  watcher.on('change', queueRender);
  watcher.on('unlink', queueRender);
  watcher.on('error', (error) => {
    const typed = error instanceof Error ? error : new Error(String(error));
    console.error(`chalkbag watcher: watch error for global ${agentsRoot}: ${typed.message}`);
    failReject(typed);
  });

  return {
    close: async (): Promise<void> => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      await watcher.close();
    },
    failed,
  };
}

// ---------------------------------------------------------------------------
// Parent watcher
// ---------------------------------------------------------------------------

type ParentWatcherOptions = {
  ignore?: string[];
  providers?: ProviderId[];
};

/**
 * Watches a parent directory that may contain many child repos.
 *
 * For each fs event under `parentRoot`, resolves which first-level child owns
 * the changed path and queues a rebuild for that child's `.chalk/` tree — but
 * only if the child has a `.chalk/` directory.
 *
 * Design decisions (from eng review):
 * - `depth: 2` caps chokidar's descent so `<parent>/<child>/.chalk/` is
 *   reachable but deeper subtrees are not traversed (eng H-1, fd cap).
 * - Function-based `ignored` short-circuits `node_modules`, `.git`, `.venv`,
 *   `dist`, `.cache`, `.oblv` by basename before stat (eng H-1).
 * - Realpath guard rejects events whose resolved path escapes `parentRoot`
 *   (symlink loop guard, eng H-3).
 * - On `unlinkDir` of `<child>/.chalk`: any pending build timer is cancelled
 *   and no rebuild is queued (eng H-2).
 * - `BUILD_CONCURRENCY` (pLimit 2) caps concurrent rebuilds (eng M-2).
 *
 * @returns an object with `close()` and `failed` promise.
 */
export function startParentWatcher(
  parentRoot: string,
  options: ParentWatcherOptions = {},
) {
  const shouldIgnore = (p: string): boolean => {
    const base = path.basename(p);
    if (['node_modules', '.git', '.venv', 'dist', '.cache', '.oblv'].includes(base)) {
      return true;
    }
    return isPathIgnored(parentRoot, p, options.ignore ?? []);
  };

  const watcher = chokidar.watch(parentRoot, {
    depth: 2, // cap at <parent>/<child>/.chalk/file (eng H-1)
    ignoreInitial: true,
    followSymlinks: false,
    ignored: shouldIgnore,
  });

  const queued = new Map<string, NodeJS.Timeout>();
  let failReject: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    failReject = reject;
  });

  /**
   * Resolves which child repo owns the event path, applying symlink-loop guard.
   * Returns the child's absolute root, or null if this event should be skipped.
   */
  const resolveChildRepo = (eventPath: string): string | null => {
    // Symlink-loop / escape guard (eng H-3)
    try {
      const real = fs.realpathSync(eventPath);
      const relReal = path.relative(parentRoot, real);
      if (relReal === '' || relReal.startsWith('..') || path.isAbsolute(relReal)) {
        return null;
      }
    } catch {
      // ENOENT during resolve — file deleted mid-watch, skip
      return null;
    }

    const rel = path.relative(parentRoot, eventPath).split(path.sep);
    if (rel.length < 1) return null;

    const child = rel[0];
    if (!child || child.startsWith('.')) return null;

    const childRoot = path.join(parentRoot, child);

    // Only dispatch if the child has a .chalk/ directory
    if (!fs.existsSync(path.join(childRoot, '.chalk'))) return null;

    return childRoot;
  };

  const queueBuild = (scopeRoot: string): void => {
    const existing = queued.get(scopeRoot);
    if (existing) clearTimeout(existing);

    queued.set(
      scopeRoot,
      setTimeout(() => {
        queued.delete(scopeRoot);
        void BUILD_CONCURRENCY(async () => {
          try {
            await buildAgentsRepo(scopeRoot, { force: true, yes: true, providers: options.providers });
          } catch (error) {
            console.error(formatRebuildFailure(scopeRoot, error));
          }
        });
      }, 250),
    );
  };

  const onEvent = (eventPath: string): void => {
    const childRoot = resolveChildRepo(eventPath);
    if (childRoot) queueBuild(childRoot);
  };

  watcher.on('add', onEvent);
  watcher.on('change', onEvent);
  watcher.on('unlink', onEvent);

  // eng H-2: if .chalk/ itself is deleted, cancel any pending build for that child
  watcher.on('unlinkDir', (p: string) => {
    if (path.basename(p) === '.chalk') {
      const childRoot = path.dirname(p);
      const timer = queued.get(childRoot);
      if (timer) {
        clearTimeout(timer);
        queued.delete(childRoot);
        console.error(`chalkbag watcher: .chalk/ deleted for ${childRoot} — cancelling pending build`);
      }
    }
  });

  watcher.on('error', (error) => {
    const typed = error instanceof Error ? error : new Error(String(error));
    console.error(`chalkbag watcher: watch error for parent ${parentRoot}: ${typed.message}`);
    failReject(typed);
  });

  return {
    close: async (): Promise<void> => {
      for (const timer of queued.values()) clearTimeout(timer);
      queued.clear();
      await watcher.close();
    },
    failed,
  };
}

// ---------------------------------------------------------------------------
// Inline repo watch (for `chalkbag watch` command — no daemon)
// ---------------------------------------------------------------------------

/**
 * Performs an immediate build then starts a repo watcher, running until
 * `SIGINT` or `SIGTERM`.
 *
 * This is the implementation for the `chalkbag watch` CLI command — a
 * single-repo, no-daemon fallback (known debt L-1 in eng review).
 */
export async function watchAgentsRepo(
  repoRoot: string,
  options: RepoWatcherOptions = {},
): Promise<void> {
  // Initial build
  await buildAgentsRepo(repoRoot, { force: true, yes: true, ...options });

  const watcher = startRepoWatcher(repoRoot, options);

  await Promise.race([
    watcher.failed,
    new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    }),
  ]);

  await watcher.close();
}
