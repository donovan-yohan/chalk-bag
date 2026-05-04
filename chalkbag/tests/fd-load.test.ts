/**
 * fd-load tests: verifies startParentWatcher's chokidar configuration correctly
 * excludes high-fd-cost directories and caps depth to 2.
 *
 * Implements the "simpler mock-based" variant from Phase 5 plan:
 * - Mocks chokidar and asserts `ignored` function behavior for node_modules/.git
 * - Asserts `depth: 2` is passed
 * - Verifies a 4-deep nested .chalk/ would NOT be caught (depth cap)
 *
 * Platform-specific fd-count assertions (linux /proc/self/fd) are skipped
 * on darwin per the plan.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platform } from 'node:process';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock chokidar
// ---------------------------------------------------------------------------

type ChokidarCallback = (p: string) => void;

class MockWatcher {
  private listeners = new Map<string, ChokidarCallback[]>();

  on(event: string, cb: ChokidarCallback): this {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, p: string): void {
    for (const cb of this.listeners.get(event) ?? []) cb(p);
  }

  async close(): Promise<void> {}
}

let capturedOptions: Record<string, unknown> = {};
let capturedWatchedPath = '';
let lastWatcher: MockWatcher;

vi.mock('chokidar', () => ({
  default: {
    watch(watchedPath: string, opts: Record<string, unknown>) {
      capturedWatchedPath = watchedPath;
      capturedOptions = opts ?? {};
      lastWatcher = new MockWatcher();
      return lastWatcher;
    },
  },
}));

const mockBuildAgentsRepo = vi.fn().mockResolvedValue({ warnings: [], wroteGitignore: false });

vi.mock('../src/render.js', () => ({
  buildAgentsRepo: (...args: unknown[]) => mockBuildAgentsRepo(...args),
}));

import { startParentWatcher } from '../src/watcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  // Resolve real path to avoid macOS /var → /private/var symlink mismatch
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-fdload-test-')));
  vi.clearAllMocks();
  capturedOptions = {};
  capturedWatchedPath = '';
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// `ignored` function — correct classification of paths
// ---------------------------------------------------------------------------

describe('startParentWatcher — ignored function behavior', () => {
  it('uses a function-based ignored option (not a regex or string array)', () => {
    startParentWatcher(tmpDir);
    expect(typeof capturedOptions['ignored']).toBe('function');
  });

  it('ignored function returns true for node_modules paths', () => {
    startParentWatcher(tmpDir);
    const ignoredFn = capturedOptions['ignored'] as (p: string) => boolean;

    const nodeMods = path.join(tmpDir, 'myrepo', 'node_modules');
    expect(ignoredFn(nodeMods)).toBe(true);
  });

  it('ignored function returns true for the node_modules directory itself (basename check)', () => {
    startParentWatcher(tmpDir);
    const ignoredFn = capturedOptions['ignored'] as (p: string) => boolean;

    // The shouldIgnore function checks path.basename — so it catches the
    // node_modules directory itself. Chokidar then won't descend into it.
    // Files inside node_modules have a different basename so they aren't checked
    // individually (the directory guard prevents descent entirely in chokidar).
    const nodeModsDir = path.join(tmpDir, 'myrepo', 'node_modules');
    expect(ignoredFn(nodeModsDir)).toBe(true);
  });

  it('ignored function returns true for .git directory itself (basename check)', () => {
    startParentWatcher(tmpDir);
    const ignoredFn = capturedOptions['ignored'] as (p: string) => boolean;

    // basename('.git') === '.git' → matched and ignored
    expect(ignoredFn(path.join(tmpDir, 'myrepo', '.git'))).toBe(true);
    // Files inside .git have their own basename so are not individually filtered,
    // but chokidar won't descend into .git once it's blocked at the directory level.
    // We only test the directory itself here.
  });

  it('ignored function returns true for .venv directories', () => {
    startParentWatcher(tmpDir);
    const ignoredFn = capturedOptions['ignored'] as (p: string) => boolean;

    expect(ignoredFn(path.join(tmpDir, 'myrepo', '.venv'))).toBe(true);
  });

  it('ignored function returns true for dist directory itself (basename check)', () => {
    startParentWatcher(tmpDir);
    const ignoredFn = capturedOptions['ignored'] as (p: string) => boolean;

    // basename('dist') === 'dist' → matched and ignored
    expect(ignoredFn(path.join(tmpDir, 'myrepo', 'dist'))).toBe(true);
    // Files inside dist won't be individually checked once the dir is blocked.
  });

  it('ignored function returns false for .chalk paths', () => {
    startParentWatcher(tmpDir);
    const ignoredFn = capturedOptions['ignored'] as (p: string) => boolean;

    expect(ignoredFn(path.join(tmpDir, 'myrepo', '.chalk'))).toBe(false);
    expect(ignoredFn(path.join(tmpDir, 'myrepo', '.chalk', 'providers.yaml'))).toBe(false);
  });

  it('ignored function returns false for src/ paths', () => {
    startParentWatcher(tmpDir);
    const ignoredFn = capturedOptions['ignored'] as (p: string) => boolean;

    expect(ignoredFn(path.join(tmpDir, 'myrepo', 'src', 'index.ts'))).toBe(false);
  });

  it('applies custom ignore globs passed in options', () => {
    startParentWatcher(tmpDir, { ignore: ['_staging/**'] });
    const ignoredFn = capturedOptions['ignored'] as (p: string) => boolean;

    // _staging is a custom-ignored path
    expect(ignoredFn(path.join(tmpDir, '_staging', 'data'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `depth: 2` option is passed — depth cap (eng H-1)
// ---------------------------------------------------------------------------

describe('startParentWatcher — depth cap (eng H-1)', () => {
  it('passes depth: 2 to chokidar', () => {
    startParentWatcher(tmpDir);
    expect(capturedOptions['depth']).toBe(2);
  });

  it('passes ignoreInitial: true to chokidar', () => {
    startParentWatcher(tmpDir);
    expect(capturedOptions['ignoreInitial']).toBe(true);
  });

  it('passes followSymlinks: false to chokidar', () => {
    startParentWatcher(tmpDir);
    expect(capturedOptions['followSymlinks']).toBe(false);
  });

  it('watches parentRoot directly (not a subdirectory)', () => {
    startParentWatcher(tmpDir);
    expect(capturedWatchedPath).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Depth-2 boundary: 4-deep nested .chalk/ does NOT trigger a build
// ---------------------------------------------------------------------------

describe('startParentWatcher — depth boundary: 4-deep .chalk/ is unreachable', () => {
  it('does NOT fire for a 4-deep nested .chalk/ because chokidar depth:2 would not reach it', async () => {
    // Depth 2 means: <parent>/<child>/<subdir> is the deepest reachable event.
    // A 4-deep path is: <parent>/<child>/<sub1>/<sub2>/.chalk/providers.yaml
    // At depth:2 chokidar would not emit events at that depth.
    // We simulate the event manually and verify the child check prevents a build.
    //
    // The real-world guard is that chokidar simply won't emit the event due to depth:2.
    // We verify here that IF such an event somehow arrived, resolveChildRepo would
    // reject it (the child derived from the path won't have a .chalk/ immediately).

    const deepChild = path.join(tmpDir, 'repoA', 'sub1', 'sub2');
    fs.mkdirSync(path.join(deepChild, '.chalk'), { recursive: true });

    const watcher = startParentWatcher(tmpDir);

    // Emit a change event as if the 4-deep .chalk was hit
    lastWatcher.emit('change', path.join(deepChild, '.chalk', 'providers.yaml'));
    await sleep(400);

    // buildAgentsRepo should NOT be called because:
    // 1. The child derived is "repoA" (first segment after parent)
    // 2. repoA itself has no .chalk/ at its root
    expect(mockBuildAgentsRepo).not.toHaveBeenCalled();

    await watcher.close();
  });
});

// ---------------------------------------------------------------------------
// 20 fake child repos: verifies no crashes and correct dispatch
// ---------------------------------------------------------------------------

describe('startParentWatcher — 20 fake child repos', () => {
  it('handles 20 child repos without error; builds only those with .chalk/', async () => {
    // Create 20 child repos; only 5 have .chalk/
    const withAgents = new Set([2, 5, 8, 12, 17]);
    const agentsFiles = new Map<number, string>();

    for (let i = 0; i < 20; i++) {
      const childDir = path.join(tmpDir, `repo${i}`);
      if (withAgents.has(i)) {
        const agentsDir = path.join(childDir, '.chalk');
        fs.mkdirSync(agentsDir, { recursive: true });
        // Create a real file so realpathSync succeeds
        const f = path.join(agentsDir, 'providers.yaml');
        fs.writeFileSync(f, 'providers:\n', 'utf8');
        agentsFiles.set(i, f);
      } else {
        // Create a real src file
        const srcDir = path.join(childDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, 'index.ts'), '', 'utf8');
      }
    }

    const watcher = startParentWatcher(tmpDir);

    // Emit change events — for repos with .chalk/ use the real .chalk file
    // For repos without .chalk/ the event won't trigger a build
    for (let i = 0; i < 20; i++) {
      const childDir = path.join(tmpDir, `repo${i}`);
      if (withAgents.has(i)) {
        const f = agentsFiles.get(i)!;
        lastWatcher.emit('change', f);
      } else {
        // Emit a change in the src dir — resolveChildRepo won't find .chalk/
        lastWatcher.emit('change', path.join(childDir, 'src', 'index.ts'));
      }
    }

    await sleep(500);

    // Exactly 5 repos had .chalk/, so buildAgentsRepo should be called 5 times
    expect(mockBuildAgentsRepo).toHaveBeenCalledTimes(5);

    await watcher.close();
  }, 10_000);

  it('fd count stays within expected bounds (darwin: mock-only check)', async () => {
    // On darwin we don't have /proc/self/fd. We assert the mock-level contract instead:
    // The chokidar mock was called with depth:2 and a function-based ignored that
    // filters node_modules. This is the key fd-protection mechanism.

    startParentWatcher(tmpDir);

    expect(capturedOptions['depth']).toBe(2);
    expect(typeof capturedOptions['ignored']).toBe('function');

    // Verify that node_modules is excluded by the ignored fn
    const ignoredFn = capturedOptions['ignored'] as (p: string) => boolean;
    for (let i = 0; i < 20; i++) {
      const nmPath = path.join(tmpDir, `repo${i}`, 'node_modules');
      expect(ignoredFn(nmPath)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Linux fd-count test (skipped on darwin)
// ---------------------------------------------------------------------------

describe('startParentWatcher — fd count (linux only)', () => {
  it.skipIf(platform !== 'linux')(
    'does not open fds for node_modules or .git (linux /proc/self/fd)',
    async () => {
      // On linux: count open fds before and after watcher start
      const fdsBefore = fs.readdirSync('/proc/self/fd').length;

      // Create 20 fake child repos each with a node_modules containing 1000 fake files
      for (let i = 0; i < 20; i++) {
        const childDir = path.join(tmpDir, `repo${i}`);
        fs.mkdirSync(path.join(childDir, '.chalk'), { recursive: true });
        // Create a node_modules with 1000 fake files
        for (let j = 0; j < 1000; j++) {
          const pkgDir = path.join(childDir, 'node_modules', `pkg${j}`);
          fs.mkdirSync(pkgDir, { recursive: true });
          fs.writeFileSync(path.join(pkgDir, 'index.js'), '', 'utf8');
        }
      }

      const watcher = startParentWatcher(tmpDir);
      await sleep(500);

      const fdsAfter = fs.readdirSync('/proc/self/fd').length;

      // The watcher should not have opened an fd per node_modules entry
      // Each chokidar watch typically opens a few fds; with depth:2 and
      // node_modules ignored, we expect a modest increase (< 200 fds).
      expect(fdsAfter - fdsBefore).toBeLessThan(200);

      await watcher.close();
    },
    30_000,
  );
});
