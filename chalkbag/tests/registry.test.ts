import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  addPath,
  removePath,
  findPathFor,
  readRegistry,
  getRegistryPath,
} from '../src/daemon/registry.js';
import { ChalkBagError } from '../src/types.js';

// Each test gets its own tmp dir pointed at via CHALKBAG_CONFIG_HOME
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-registry-test-'));
  process.env['CHALKBAG_CONFIG_HOME'] = tmpDir;
});

afterEach(() => {
  delete process.env['CHALKBAG_CONFIG_HOME'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// addPath — duplicate rejection
// ---------------------------------------------------------------------------

describe('addPath — duplicate path rejection', () => {
  it('rejects a path that is already registered', async () => {
    const p = '/Users/test/myrepo';
    await addPath({ path: p, mode: 'repo', providers: ['claude'], ignore: [] });

    await expect(
      addPath({ path: p, mode: 'repo', providers: ['codex'], ignore: [] }),
    ).rejects.toThrow(ChalkBagError);

    await expect(
      addPath({ path: p, mode: 'repo', providers: ['codex'], ignore: [] }),
    ).rejects.toThrow('already registered');
  });

  it('deduplicates and sorts providers', async () => {
    await addPath({ path: '/Users/test/repo1', mode: 'repo', providers: ['codex', 'claude', 'codex'], ignore: [] });
    const registry = await readRegistry();
    expect(registry.paths[0]?.providers).toEqual(['claude', 'codex']);
  });

  it('deduplicates and sorts ignore globs', async () => {
    await addPath({ path: '/Users/test/repo2', mode: 'repo', providers: [], ignore: ['z/**', 'a/**', 'a/**'] });
    const registry = await readRegistry();
    expect(registry.paths[0]?.ignore).toEqual(['a/**', 'z/**']);
  });
});

// ---------------------------------------------------------------------------
// addPath — overlap rejection (eng C-1)
// ---------------------------------------------------------------------------

describe('addPath — overlap rejection (eng C-1)', () => {
  it('rejects a child of an existing parent entry', async () => {
    await addPath({ path: '/Users/test/projects', mode: 'parent', providers: ['claude'], ignore: [] });

    await expect(
      addPath({ path: '/Users/test/projects/myrepo', mode: 'repo', providers: ['claude'], ignore: [] }),
    ).rejects.toThrow(ChalkBagError);

    await expect(
      addPath({ path: '/Users/test/projects/myrepo', mode: 'repo', providers: ['claude'], ignore: [] }),
    ).rejects.toThrow('already covered by parent entry');
  });

  it('rejects a parent entry that would cover an existing entry', async () => {
    await addPath({ path: '/Users/test/projects/myrepo', mode: 'repo', providers: ['claude'], ignore: [] });

    await expect(
      addPath({ path: '/Users/test/projects', mode: 'parent', providers: ['claude'], ignore: [] }),
    ).rejects.toThrow(ChalkBagError);

    await expect(
      addPath({ path: '/Users/test/projects', mode: 'parent', providers: ['claude'], ignore: [] }),
    ).rejects.toThrow('would cover existing entry');
  });

  it('allows sibling entries (no overlap)', async () => {
    await addPath({ path: '/Users/test/projects/alpha', mode: 'repo', providers: ['claude'], ignore: [] });
    await expect(
      addPath({ path: '/Users/test/projects/beta', mode: 'repo', providers: ['claude'], ignore: [] }),
    ).resolves.toBeUndefined();
  });

  it('allows two parent entries at the same depth with no overlap', async () => {
    await addPath({ path: '/Users/test/personal', mode: 'parent', providers: ['claude'], ignore: [] });
    await expect(
      addPath({ path: '/Users/test/work', mode: 'parent', providers: ['claude'], ignore: [] }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// addPath — global mode entry
// ---------------------------------------------------------------------------

describe('addPath — global scope entry', () => {
  it('registers a global entry at the home path', async () => {
    await addPath({ path: '/home/testuser', mode: 'global', providers: ['claude', 'codex'], ignore: [] });
    const registry = await readRegistry();
    expect(registry.paths).toHaveLength(1);
    expect(registry.paths[0]?.mode).toBe('global');
    expect(registry.paths[0]?.providers).toEqual(['claude', 'codex']);
  });

  it('is exempt from parent/repo overlap checks (home would otherwise contain every repo)', async () => {
    await addPath({ path: '/home/testuser', mode: 'global', providers: ['claude'], ignore: [] });
    // A repo living under the home dir must still be registerable despite the
    // global entry sitting at the home root.
    await expect(
      addPath({ path: '/home/testuser/projects/myrepo', mode: 'repo', providers: ['claude'], ignore: [] }),
    ).resolves.toBeUndefined();
    // And a (non-overlapping) parent under home is fine too.
    await expect(
      addPath({ path: '/home/testuser/work', mode: 'parent', providers: ['claude'], ignore: [] }),
    ).resolves.toBeUndefined();
  });

  it('rejects a second global entry', async () => {
    await addPath({ path: '/home/testuser', mode: 'global', providers: ['claude'], ignore: [] });
    await expect(
      addPath({ path: '/home/other', mode: 'global', providers: ['claude'], ignore: [] }),
    ).rejects.toThrow('global scope is already registered');
  });

  it('round-trips a global entry through readRegistry (mode accepted by normalizeEntry)', async () => {
    await addPath({ path: '/home/testuser', mode: 'global', providers: ['codex'], ignore: [] });
    const registry = await readRegistry();
    expect(registry.paths[0]?.mode).toBe('global');
  });
});

// ---------------------------------------------------------------------------
// removePath
// ---------------------------------------------------------------------------

describe('removePath', () => {
  it('removes an existing entry and returns true', async () => {
    await addPath({ path: '/Users/test/removeme', mode: 'repo', providers: [], ignore: [] });
    const result = await removePath('/Users/test/removeme');
    expect(result).toBe(true);
    const registry = await readRegistry();
    expect(registry.paths).toHaveLength(0);
  });

  it('returns false for an unregistered path', async () => {
    const result = await removePath('/Users/test/nonexistent');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findPathFor — longest-match
// ---------------------------------------------------------------------------

describe('findPathFor — longest match (eng C-1)', () => {
  it('returns null when no entry covers the target', async () => {
    const result = await findPathFor('/Users/test/unknown');
    expect(result).toBeNull();
  });

  it('returns a repo entry for an exact match', async () => {
    await addPath({ path: '/Users/test/myrepo', mode: 'repo', providers: ['claude'], ignore: [] });
    const entry = await findPathFor('/Users/test/myrepo');
    expect(entry).not.toBeNull();
    expect(entry?.mode).toBe('repo');
  });

  it('returns a parent entry for a child path', async () => {
    await addPath({ path: '/Users/test/projects', mode: 'parent', providers: ['codex'], ignore: [] });
    const entry = await findPathFor('/Users/test/projects/myrepo');
    expect(entry).not.toBeNull();
    expect(entry?.mode).toBe('parent');
  });

  it('prefers the longer (more specific) match — repo over parent', async () => {
    // Register parent first, then repo under it
    // Note: addPath would normally reject child of parent — so set up registry
    // directly by writing JSON to test the findPathFor logic in isolation.
    const registryPath = getRegistryPath();
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        paths: [
          {
            path: '/Users/test/projects',
            mode: 'parent',
            providers: ['codex'],
            ignore: [],
            installedAt: new Date().toISOString(),
          },
          {
            path: '/Users/test/projects/myrepo',
            mode: 'repo',
            providers: ['claude'],
            ignore: [],
            installedAt: new Date().toISOString(),
          },
        ],
      }) + '\n',
      'utf8',
    );

    const entry = await findPathFor('/Users/test/projects/myrepo');
    expect(entry).not.toBeNull();
    // repo path (/Users/test/projects/myrepo) is longer than parent path (/Users/test/projects)
    expect(entry?.mode).toBe('repo');
    expect(entry?.providers).toEqual(['claude']);
  });

  it('respects ignore patterns — skips ignored descendants', async () => {
    await addPath({
      path: '/Users/test/projects',
      mode: 'parent',
      providers: ['claude'],
      ignore: ['ignoreme/**'],
    });
    const entry = await findPathFor('/Users/test/projects/ignoreme/sub');
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readRegistry — corruption handling
// ---------------------------------------------------------------------------

describe('readRegistry — corruption and ENOENT handling', () => {
  it('returns empty registry when file does not exist (ENOENT)', async () => {
    const registry = await readRegistry();
    expect(registry.version).toBe(1);
    expect(registry.paths).toHaveLength(0);
  });

  it('throws ChalkBagError on malformed JSON', async () => {
    const registryPath = getRegistryPath();
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, 'not valid json{{{', 'utf8');

    await expect(readRegistry()).rejects.toThrow(ChalkBagError);
    await expect(readRegistry()).rejects.toThrow('corrupt or unreadable');
  });

  it('throws ChalkBagError when version field is missing', async () => {
    const registryPath = getRegistryPath();
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ paths: [] }) + '\n', 'utf8');

    await expect(readRegistry()).rejects.toThrow(ChalkBagError);
    await expect(readRegistry()).rejects.toThrow('corrupt or unreadable');
  });

  it('throws ChalkBagError on wrong version number', async () => {
    const registryPath = getRegistryPath();
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ version: 99, paths: [] }) + '\n', 'utf8');

    await expect(readRegistry()).rejects.toThrow(ChalkBagError);
    await expect(readRegistry()).rejects.toThrow('corrupt or unreadable');
  });

  it('throws ChalkBagError when paths is not an array', async () => {
    const registryPath = getRegistryPath();
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, paths: 'oops' }) + '\n', 'utf8');

    await expect(readRegistry()).rejects.toThrow(ChalkBagError);
    await expect(readRegistry()).rejects.toThrow('corrupt or unreadable');
  });

  it('throws ChalkBagError when an entry has an invalid mode', async () => {
    const registryPath = getRegistryPath();
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        paths: [
          { path: '/foo', mode: 'invalid', providers: [], ignore: [], installedAt: '' },
        ],
      }) + '\n',
      'utf8',
    );

    await expect(readRegistry()).rejects.toThrow(ChalkBagError);
  });

  it('includes a fix hint in the error', async () => {
    const registryPath = getRegistryPath();
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, '{bad', 'utf8');

    try {
      await readRegistry();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChalkBagError);
      const cbErr = err as ChalkBagError;
      expect(cbErr.fix).toMatch(/delete it to start fresh/);
    }
  });
});

// ---------------------------------------------------------------------------
// getConfigHome validation
// ---------------------------------------------------------------------------

describe('getConfigHome — validation', () => {
  it('throws when CHALKBAG_CONFIG_HOME is a relative path', async () => {
    process.env['CHALKBAG_CONFIG_HOME'] = 'relative/path';
    const { getConfigHome } = await import('../src/daemon/registry.js');
    expect(() => getConfigHome()).toThrow(ChalkBagError);
    expect(() => getConfigHome()).toThrow('must be an absolute path');
    process.env['CHALKBAG_CONFIG_HOME'] = tmpDir; // restore
  });

  it('throws when CHALKBAG_CONFIG_HOME contains a control character', async () => {
    process.env['CHALKBAG_CONFIG_HOME'] = '/valid/path\x01/oops';
    const { getConfigHome } = await import('../src/daemon/registry.js');
    expect(() => getConfigHome()).toThrow(ChalkBagError);
    expect(() => getConfigHome()).toThrow('control characters');
    process.env['CHALKBAG_CONFIG_HOME'] = tmpDir; // restore
  });
});
