import { readRegistry, touchHeartbeat, hasPauseFlag, getConfigHome } from './registry.js';
import { startRepoWatcher, startParentWatcher } from '../watcher.js';

type Watcher = { close: () => Promise<void>; failed: Promise<never> };

/**
 * Reads the registry and starts the appropriate watcher for each path entry.
 *
 * If the pause flag file (`~/.config/chalkbag/paused`) is present, no
 * watchers are started and an empty array is returned. The daemon continues
 * to heartbeat normally (eng DX H-5 escape hatch).
 */
async function startWatchers(): Promise<Watcher[]> {
  if (await hasPauseFlag()) {
    console.error('chalkbag daemon: paused; no watchers started (remove %s/paused to resume)', getConfigHome());
    return [];
  }

  const registry = await readRegistry();

  return registry.paths.map((entry) => {
    if (entry.mode === 'repo') {
      return startRepoWatcher(entry.path, { providers: entry.providers });
    }
    return startParentWatcher(entry.path, {
      ignore: entry.ignore,
      providers: entry.providers,
    });
  });
}

async function main(): Promise<void> {
  await touchHeartbeat();

  const heartbeatInterval = setInterval(() => {
    void touchHeartbeat();
  }, 30_000);

  let watchers = await startWatchers();

  // SIGHUP reloads the registry and restarts all watchers
  const reload = async (): Promise<void> => {
    for (const w of watchers.splice(0)) {
      await w.close();
    }
    watchers = await startWatchers();
  };

  process.on('SIGHUP', () => {
    void reload();
  });

  // Wait for SIGINT or SIGTERM to shut down gracefully
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  clearInterval(heartbeatInterval);

  for (const w of watchers) {
    await w.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
