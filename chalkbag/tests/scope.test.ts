import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resolveAgentsScope, isPathIgnored } from '../src/scope.js';
import { ChalkBagError } from '../src/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-scope-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveAgentsScope — basic resolution
// ---------------------------------------------------------------------------

describe('resolveAgentsScope — direct resolution', () => {
  it('resolves when .chalk/ exists at the start path', async () => {
    const agentsDir = path.join(tmpDir, '.chalk');
    fs.mkdirSync(agentsDir);

    const scope = await resolveAgentsScope(tmpDir);
    expect(scope.sourceRoot).toBe(tmpDir);
    expect(scope.outputRoot).toBe(tmpDir);
    expect(scope.agentsRoot).toBe(agentsDir);
  });

  it('returns all three scope fields', async () => {
    fs.mkdirSync(path.join(tmpDir, '.chalk'));
    const scope = await resolveAgentsScope(tmpDir);
    expect(scope).toHaveProperty('sourceRoot');
    expect(scope).toHaveProperty('outputRoot');
    expect(scope).toHaveProperty('agentsRoot');
  });

  it('resolves when called with the .chalk path directly', async () => {
    const agentsDir = path.join(tmpDir, '.chalk');
    fs.mkdirSync(agentsDir);

    const scope = await resolveAgentsScope(agentsDir);
    expect(scope.sourceRoot).toBe(tmpDir);
    expect(scope.agentsRoot).toBe(agentsDir);
  });
});

// ---------------------------------------------------------------------------
// resolveAgentsScope — walk-up resolution
// ---------------------------------------------------------------------------

describe('resolveAgentsScope — walk-up from nested subdirectory', () => {
  it('finds .chalk/ by walking up two levels', async () => {
    const agentsDir = path.join(tmpDir, '.chalk');
    fs.mkdirSync(agentsDir);
    const nestedDir = path.join(tmpDir, 'src', 'lib');
    fs.mkdirSync(nestedDir, { recursive: true });

    const scope = await resolveAgentsScope(nestedDir);
    expect(scope.sourceRoot).toBe(tmpDir);
    expect(scope.agentsRoot).toBe(agentsDir);
  });

  it('finds .chalk/ by walking up three levels', async () => {
    const agentsDir = path.join(tmpDir, '.chalk');
    fs.mkdirSync(agentsDir);
    const deepDir = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(deepDir, { recursive: true });

    const scope = await resolveAgentsScope(deepDir);
    expect(scope.sourceRoot).toBe(tmpDir);
    expect(scope.agentsRoot).toBe(agentsDir);
  });

  it('resolves from a file path inside the repo (uses dirname)', async () => {
    const agentsDir = path.join(tmpDir, '.chalk');
    fs.mkdirSync(agentsDir);
    const filePath = path.join(tmpDir, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');

    const scope = await resolveAgentsScope(filePath);
    expect(scope.sourceRoot).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// resolveAgentsScope — error when no .chalk/ found
// ---------------------------------------------------------------------------

describe('resolveAgentsScope — throws when no .chalk/ found', () => {
  it('throws ChalkBagError with kind: config when no .chalk/ exists', async () => {
    await expect(resolveAgentsScope(tmpDir)).rejects.toThrow(ChalkBagError);
  });

  it('throws with kind "config"', async () => {
    try {
      await resolveAgentsScope(tmpDir);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChalkBagError);
      const cbErr = err as ChalkBagError;
      expect(cbErr.kind).toBe('config');
    }
  });

  it('error includes a fix hint referencing chalkbag scaffold', async () => {
    try {
      await resolveAgentsScope(tmpDir);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChalkBagError);
      const cbErr = err as ChalkBagError;
      expect(cbErr.fix).toBeTruthy();
      expect(cbErr.fix).toMatch(/scaffold/);
    }
  });

  it('does not walk into a sibling directory with .chalk/', async () => {
    // Create a sibling tmp dir that has .chalk, but start from a different dir
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-scope-other-'));
    try {
      fs.mkdirSync(path.join(otherDir, '.chalk'));
      // tmpDir has no .chalk, so resolution should fail even though otherDir has one
      await expect(resolveAgentsScope(tmpDir)).rejects.toThrow(ChalkBagError);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// isPathIgnored — pattern matching
// ---------------------------------------------------------------------------

describe('isPathIgnored — pattern matching', () => {
  it('returns false when patterns array is empty', () => {
    expect(isPathIgnored(tmpDir, path.join(tmpDir, 'src', 'foo.ts'), [])).toBe(false);
  });

  it('returns true for a path matching a glob pattern', () => {
    expect(isPathIgnored(tmpDir, path.join(tmpDir, 'dist', 'index.js'), ['dist/**'])).toBe(true);
  });

  it('returns false for a path that does not match any pattern', () => {
    expect(isPathIgnored(tmpDir, path.join(tmpDir, 'src', 'index.ts'), ['dist/**'])).toBe(false);
  });

  it('returns true when any one of multiple patterns matches', () => {
    const patterns = ['dist/**', 'node_modules/**', '_drafts/**'];
    expect(isPathIgnored(tmpDir, path.join(tmpDir, '_drafts', 'note.md'), patterns)).toBe(true);
  });

  it('returns false when none of multiple patterns match', () => {
    const patterns = ['dist/**', 'node_modules/**'];
    expect(isPathIgnored(tmpDir, path.join(tmpDir, 'src', 'index.ts'), patterns)).toBe(false);
  });

  it('returns true for a path that escapes the base root (starts with ..)', () => {
    // isPathIgnored short-circuits escape-check only when patterns are non-empty.
    // With at least one pattern, out-of-bounds paths are treated as ignored.
    const outsidePath = path.join(tmpDir, '..', 'outside.ts');
    // Using a catch-all pattern to force the escape check path
    expect(isPathIgnored(tmpDir, outsidePath, ['**'])).toBe(true);
  });

  it('returns true for an absolute path unrelated to baseRoot (with patterns)', () => {
    // path.relative(baseRoot, absoluteUnrelated) starts with '..' → treated as out-of-bounds
    // This is only triggered when patterns is non-empty (otherwise early return is false).
    expect(isPathIgnored(tmpDir, '/some/other/absolute/path.ts', ['**'])).toBe(true);
  });

  it('matches nested patterns correctly', () => {
    expect(isPathIgnored(tmpDir, path.join(tmpDir, 'pkg', 'dist', 'a.js'), ['pkg/dist/**'])).toBe(true);
  });

  it('does not match a pattern when only the prefix matches', () => {
    // 'dist/**' should not match 'distribution/file.ts'
    expect(isPathIgnored(tmpDir, path.join(tmpDir, 'distribution', 'file.ts'), ['dist/**'])).toBe(false);
  });
});
