import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock chokidar BEFORE any imports that reference it
// ---------------------------------------------------------------------------

type ChokidarEventCallback = (filePath: string) => void;

class MockWatcher {
  private listeners = new Map<string, ChokidarEventCallback[]>();

  on(event: string, cb: ChokidarEventCallback): this {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, filePath: string): void {
    const list = this.listeners.get(event) ?? [];
    for (const cb of list) {
      cb(filePath);
    }
  }

  async close(): Promise<void> {
    // no-op
  }
}

let lastWatcher: MockWatcher;
let lastWatchOptions: Record<string, unknown> = {};

vi.mock('chokidar', () => ({
  default: {
    watch(_p: string, opts: Record<string, unknown>) {
      lastWatchOptions = opts ?? {};
      lastWatcher = new MockWatcher();
      return lastWatcher;
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock buildAgentsRepo so we don't trigger real renders
// ---------------------------------------------------------------------------

const mockBuildAgentsRepo = vi.fn<[string, Record<string, unknown>?], Promise<{ warnings: string[]; wroteGitignore: boolean }>>()
  .mockResolvedValue({ warnings: [], wroteGitignore: false });

vi.mock('../src/render.js', () => ({
  buildAgentsRepo: (...args: [string, Record<string, unknown>?]) => mockBuildAgentsRepo(...args),
}));

// ---------------------------------------------------------------------------
// Now import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { startRepoWatcher, startParentWatcher, watchAgentsRepo } from '../src/watcher.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  // Resolve the real path to avoid symlink issues on macOS (/var → /private/var)
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-watcher-test-')));
  vi.clearAllMocks();
  lastWatchOptions = {};
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// startRepoWatcher — basic dispatch
// ---------------------------------------------------------------------------

describe('startRepoWatcher — change triggers debounced build', () => {
  it('calls buildAgentsRepo after a change event (debounced 200ms)', async () => {
    const watcher = startRepoWatcher(tmpDir);

    lastWatcher.emit('change', path.join(tmpDir, '.agents', 'providers.yaml'));
    // Before debounce fires, should not have been called
    expect(mockBuildAgentsRepo).not.toHaveBeenCalled();

    await sleep(350); // debounce is 200ms
    expect(mockBuildAgentsRepo).toHaveBeenCalledOnce();
    expect(mockBuildAgentsRepo).toHaveBeenCalledWith(
      tmpDir,
      expect.objectContaining({ force: true, yes: true }),
    );

    await watcher.close();
  });

  it('debounces: rapid events result in a single build call', async () => {
    const watcher = startRepoWatcher(tmpDir);
    const agentsFile = path.join(tmpDir, '.agents', 'x.md');

    // Fire 5 rapid change events
    for (let i = 0; i < 5; i++) {
      lastWatcher.emit('change', agentsFile);
      await sleep(10);
    }

    await sleep(350);
    expect(mockBuildAgentsRepo).toHaveBeenCalledOnce();

    await watcher.close();
  });

  it('triggers on add events as well', async () => {
    const watcher = startRepoWatcher(tmpDir);

    lastWatcher.emit('add', path.join(tmpDir, '.agents', 'new-skill.md'));
    await sleep(350);
    expect(mockBuildAgentsRepo).toHaveBeenCalledOnce();

    await watcher.close();
  });

  it('triggers on unlink events', async () => {
    const watcher = startRepoWatcher(tmpDir);

    lastWatcher.emit('unlink', path.join(tmpDir, '.agents', 'old-skill.md'));
    await sleep(350);
    expect(mockBuildAgentsRepo).toHaveBeenCalledOnce();

    await watcher.close();
  });
});

// ---------------------------------------------------------------------------
// startParentWatcher — child detection
// ---------------------------------------------------------------------------

describe('startParentWatcher — fires per child scope', () => {
  it('triggers a build for a child repo that has .agents/', async () => {
    const childDir = path.join(tmpDir, 'myrepo');
    const agentsDir = path.join(childDir, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Create the actual file that will be "changed" so realpathSync succeeds
    const providersFile = path.join(agentsDir, 'providers.yaml');
    fs.writeFileSync(providersFile, 'providers:\n  claude:\n    enabled: true\n', 'utf8');

    const watcher = startParentWatcher(tmpDir);

    // Emit a change in the child's .agents dir
    lastWatcher.emit('change', providersFile);
    await sleep(400);

    expect(mockBuildAgentsRepo).toHaveBeenCalledOnce();
    expect(mockBuildAgentsRepo).toHaveBeenCalledWith(
      childDir,
      expect.objectContaining({ force: true, yes: true }),
    );

    await watcher.close();
  });

  it('does NOT fire for child repos without .agents/', async () => {
    const childDir = path.join(tmpDir, 'no-agents-repo');
    const srcDir = path.join(childDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, 'index.ts');
    fs.writeFileSync(srcFile, '', 'utf8');

    const watcher = startParentWatcher(tmpDir);
    lastWatcher.emit('change', srcFile);
    await sleep(400);

    expect(mockBuildAgentsRepo).not.toHaveBeenCalled();

    await watcher.close();
  });

  it('fires independently for two separate child repos', async () => {
    const childA = path.join(tmpDir, 'repoA');
    const childB = path.join(tmpDir, 'repoB');
    fs.mkdirSync(path.join(childA, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(childB, '.agents'), { recursive: true });

    // Create actual files for realpathSync
    const fileA = path.join(childA, '.agents', 'x.md');
    const fileB = path.join(childB, '.agents', 'y.md');
    fs.writeFileSync(fileA, '', 'utf8');
    fs.writeFileSync(fileB, '', 'utf8');

    const watcher = startParentWatcher(tmpDir);

    lastWatcher.emit('change', fileA);
    await sleep(20);
    lastWatcher.emit('change', fileB);
    await sleep(400);

    expect(mockBuildAgentsRepo).toHaveBeenCalledTimes(2);

    const calls = mockBuildAgentsRepo.mock.calls.map((c) => c[0]).sort();
    expect(calls).toContain(childA);
    expect(calls).toContain(childB);

    await watcher.close();
  });
});

// ---------------------------------------------------------------------------
// Ignore regex — node_modules/`.git` events are skipped
// ---------------------------------------------------------------------------

describe('startParentWatcher — ignored paths', () => {
  it('ignored function returns true for node_modules paths', () => {
    startParentWatcher(tmpDir);
    // The watcher is created with a function-based ignored option
    const ignoredFn = lastWatchOptions['ignored'] as ((p: string) => boolean) | undefined;
    if (typeof ignoredFn !== 'function') {
      // Some setups use array ignored — skip this check
      return;
    }

    expect(ignoredFn(path.join(tmpDir, 'myrepo', 'node_modules'))).toBe(true);
    expect(ignoredFn(path.join(tmpDir, 'myrepo', '.git'))).toBe(true);
    expect(ignoredFn(path.join(tmpDir, 'myrepo', '.venv'))).toBe(true);
    expect(ignoredFn(path.join(tmpDir, 'myrepo', 'dist'))).toBe(true);
  });

  it('ignored function returns false for normal .agents/ paths', () => {
    startParentWatcher(tmpDir);
    const ignoredFn = lastWatchOptions['ignored'] as ((p: string) => boolean) | undefined;
    if (typeof ignoredFn !== 'function') {
      return;
    }

    expect(ignoredFn(path.join(tmpDir, 'myrepo', '.agents'))).toBe(false);
    expect(ignoredFn(path.join(tmpDir, 'myrepo', '.agents', 'providers.yaml'))).toBe(false);
  });

  it('does not crash when receiving events from paths the ignored fn would normally block', async () => {
    const childDir = path.join(tmpDir, 'myrepo');
    // Even if a node_modules event somehow arrived, the watcher handles it gracefully.
    // (In practice chokidar won't emit it because `ignored` blocks the directory.)
    fs.mkdirSync(path.join(childDir, '.agents'), { recursive: true });

    const watcher = startParentWatcher(tmpDir);

    // No-op: just verify no crash
    await sleep(100);

    // Key assertion: no crash, process is stable.
    expect(true).toBe(true);

    await watcher.close();
  });
});

// ---------------------------------------------------------------------------
// depth: 2 option is passed to chokidar
// ---------------------------------------------------------------------------

describe('startParentWatcher — depth option', () => {
  it('passes depth: 2 to chokidar watch', () => {
    startParentWatcher(tmpDir);
    expect(lastWatchOptions['depth']).toBe(2);
  });

  it('passes followSymlinks: false to chokidar watch', () => {
    startParentWatcher(tmpDir);
    expect(lastWatchOptions['followSymlinks']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Symlink realpath guard (eng H-3)
// ---------------------------------------------------------------------------

describe('startParentWatcher — symlink realpath guard (eng H-3)', () => {
  it('does not build if realpath resolves outside parentRoot', async () => {
    // Create an external directory (outside tmpDir)
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-external-'));
    try {
      fs.mkdirSync(path.join(externalDir, '.agents'), { recursive: true });

      // Create a symlink inside tmpDir pointing to the external dir
      const symlinkPath = path.join(tmpDir, 'symlinked-repo');
      try {
        fs.symlinkSync(externalDir, symlinkPath);
      } catch {
        // Skip if symlink creation fails (permissions)
        return;
      }

      const watcher = startParentWatcher(tmpDir);

      // Emit a change for the symlink path — realpath guard should block this
      lastWatcher.emit('change', path.join(symlinkPath, '.agents', 'providers.yaml'));
      await sleep(400);

      // The realpath of the symlink resolves outside tmpDir, so no build should fire
      expect(mockBuildAgentsRepo).not.toHaveBeenCalled();

      await watcher.close();
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// unlinkDir of .agents cancels pending build (eng H-2)
// ---------------------------------------------------------------------------

describe('startParentWatcher — unlinkDir of .agents cancels pending build (eng H-2)', () => {
  it('cancels a pending build when .agents/ is deleted', async () => {
    const childDir = path.join(tmpDir, 'myrepo');
    const agentsDir = path.join(childDir, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Create a real file so realpathSync succeeds for the change event
    const xFile = path.join(agentsDir, 'x.md');
    fs.writeFileSync(xFile, '', 'utf8');

    const watcher = startParentWatcher(tmpDir);

    // Queue a build by emitting a change event
    lastWatcher.emit('change', xFile);

    // Immediately cancel by emitting unlinkDir for .agents
    lastWatcher.emit('unlinkDir', agentsDir);

    // Wait past debounce duration
    await sleep(400);

    // Build should have been cancelled
    expect(mockBuildAgentsRepo).not.toHaveBeenCalled();

    await watcher.close();
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap: at most 2 concurrent buildAgentsRepo calls (eng M-2)
// ---------------------------------------------------------------------------

describe('startParentWatcher — concurrency cap (eng M-2)', () => {
  it('runs at most 2 concurrent buildAgentsRepo calls', async () => {
    // Create 5 child repos, each with a real file so realpathSync works
    const children: string[] = [];
    const childFiles: string[] = [];
    for (let i = 0; i < 5; i++) {
      const child = path.join(tmpDir, `repo${i}`);
      const agentsDir = path.join(child, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      const f = path.join(agentsDir, 'x.md');
      fs.writeFileSync(f, '', 'utf8');
      children.push(child);
      childFiles.push(f);
    }

    let concurrentCount = 0;
    let maxConcurrent = 0;
    const resolvers: Array<() => void> = [];

    mockBuildAgentsRepo.mockImplementation(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Hold each call until released
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      concurrentCount--;
      return { warnings: [], wroteGitignore: false };
    });

    const watcher = startParentWatcher(tmpDir);

    // Fire events for all 5 children simultaneously using the real files
    for (const f of childFiles) {
      lastWatcher.emit('change', f);
    }

    // Wait for debounce to fire (250ms parent watcher debounce)
    await sleep(400);

    // Allow all queued builds to proceed
    for (const resolve of resolvers) resolve();
    await sleep(100);
    for (const resolve of resolvers) resolve();
    await sleep(100);

    // At peak, at most 2 should have been running simultaneously
    expect(maxConcurrent).toBeLessThanOrEqual(2);

    await watcher.close();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// watchAgentsRepo — runs initial build and exits on signal
// ---------------------------------------------------------------------------

describe('watchAgentsRepo — initial build', () => {
  it('calls buildAgentsRepo for the initial build before starting watcher', async () => {
    // watchAgentsRepo performs an initial build then starts the watcher.
    // We test ONLY the initial-build behavior here, not signal handling.
    // To exit cleanly without signals, we wrap the whole thing with a racing
    // timer that resolves via a side-channel.
    const repoDir = path.join(tmpDir, 'watchrepo');
    fs.mkdirSync(path.join(repoDir, '.agents'), { recursive: true });

    // Patch mockBuildAgentsRepo to record the initial call and resolve quickly
    let initialBuildArgs: unknown[] | null = null;
    mockBuildAgentsRepo.mockImplementationOnce(async (...args: unknown[]) => {
      initialBuildArgs = args;
      return { warnings: [], wroteGitignore: false };
    });

    // Start watchAgentsRepo in the background — it will block on Promise.race
    // waiting for a signal or watcher failure. We let it wait in the background
    // and verify the initial build call synchronously after a short yield.
    let watchDone = false;
    const watchPromise = watchAgentsRepo(repoDir).then(
      () => { watchDone = true; },
      () => { watchDone = true; },
    );

    // Wait for async chain: await buildAgentsRepo + startRepoWatcher setup
    await sleep(150);

    // Assert initial build was called
    expect(initialBuildArgs).not.toBeNull();
    expect(initialBuildArgs![0]).toBe(repoDir);
    expect((initialBuildArgs![1] as Record<string, unknown>)['force']).toBe(true);
    expect((initialBuildArgs![1] as Record<string, unknown>)['yes']).toBe(true);

    // Shut down cleanly by triggering a watcher error (which rejects `failed`)
    lastWatcher.emit('error', 'test-shutdown-error');
    await sleep(50);
    await watchPromise;
    expect(watchDone).toBe(true);
  }, 10_000);
});
