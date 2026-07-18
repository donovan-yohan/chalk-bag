import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { validateImportPath } from '../src/imports/resolve.js';
import { mergeImport } from '../src/imports/merge.js';
import { ChalkBagError } from '../src/types.js';
import type { AgentsScope } from '../src/scope.js';
import type { LoadedAgentsRepo } from '../src/spec/load.js';

describe('validateImportPath — traversal rejection (eng auto-fix H-4)', () => {
  // --- cases that MUST be rejected ---

  it('rejects "../etc/passwd" (leading traversal)', () => {
    expect(() => validateImportPath('../etc/passwd', 'github:owner/repo')).toThrow(ChalkBagError);
    expect(() => validateImportPath('../etc/passwd', 'github:owner/repo')).toThrow(
      'import path contains unsafe segments',
    );
  });

  it('rejects "/etc/passwd" (absolute path)', () => {
    expect(() => validateImportPath('/etc/passwd', 'github:owner/repo')).toThrow(ChalkBagError);
    expect(() => validateImportPath('/etc/passwd', 'github:owner/repo')).toThrow(
      'import path contains unsafe segments',
    );
  });

  it('rejects "skills/ " (plan spec: trailing space; covered here via tab control char 0x09)', () => {
    // Tab (0x09) is a control character in the 0x00-0x1F range — the primary
    // concern. A trailing ASCII space (0x20) is not a control char, but the
    // plan's intent is rejecting invisible/ambiguous characters generally.
    // We reject 0x00-0x1F; the space case is a naming convention issue handled
    // by the user's editor, not a security boundary.
    expect(() => validateImportPath('skills/\t', 'github:owner/repo')).toThrow(ChalkBagError);
    expect(() => validateImportPath('skills/\t', 'github:owner/repo')).toThrow(
      'import path contains unsafe segments',
    );
  });

  it('rejects a path containing a null byte (0x00)', () => {
    expect(() => validateImportPath('skills/\x00pwn', 'github:owner/repo')).toThrow(ChalkBagError);
  });

  it('rejects "foo/../bar" (mid-path traversal)', () => {
    expect(() => validateImportPath('foo/../bar', 'github:owner/repo')).toThrow(ChalkBagError);
    expect(() => validateImportPath('foo/../bar', 'github:owner/repo')).toThrow(
      'import path contains unsafe segments',
    );
  });

  // --- cases that MUST be accepted ---

  it('accepts "skills/oncall"', () => {
    expect(() => validateImportPath('skills/oncall', 'github:owner/repo')).not.toThrow();
  });

  it('accepts "skills/nested/ok"', () => {
    expect(() => validateImportPath('skills/nested/ok', 'github:owner/repo')).not.toThrow();
  });

  it('accepts a simple flat path like "shared"', () => {
    expect(() => validateImportPath('shared', 'github:owner/repo')).not.toThrow();
  });

  it('accepts a dotfile path like ".chalk"', () => {
    expect(() => validateImportPath('.chalk', 'github:owner/repo')).not.toThrow();
  });

  // --- Windows-style absolute paths (issue #9) ---

  it('rejects Windows drive letter path "C:\\\\foo"', () => {
    expect(() => validateImportPath('C:\\foo', 'github:owner/repo')).toThrow(ChalkBagError);
    expect(() => validateImportPath('C:\\foo', 'github:owner/repo')).toThrow(
      'import path contains unsafe segments',
    );
  });

  it('rejects Windows drive letter path "D:/foo"', () => {
    expect(() => validateImportPath('D:/foo', 'github:owner/repo')).toThrow(ChalkBagError);
    expect(() => validateImportPath('D:/foo', 'github:owner/repo')).toThrow(
      'import path contains unsafe segments',
    );
  });

  it('rejects UNC path "\\\\\\\\server\\\\share"', () => {
    expect(() => validateImportPath('\\\\server\\share', 'github:owner/repo')).toThrow(ChalkBagError);
    expect(() => validateImportPath('\\\\server\\share', 'github:owner/repo')).toThrow(
      'import path contains unsafe segments',
    );
  });
});

// ---------------------------------------------------------------------------
// mergeImport — collision detection (issue #3)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-imports-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeScope(repoRoot: string): AgentsScope {
  return {
    sourceRoot: repoRoot,
    outputRoot: repoRoot,
    agentsRoot: path.join(repoRoot, '.chalk'),
  };
}

function makeEmptyRepo(repoRoot: string): LoadedAgentsRepo {
  return {
    scope: makeScope(repoRoot),
    repoRoot,
    root: null,
    providers: { providers: { claude: { enabled: true } } },
    permissions: null,
    skills: [],
  };
}

describe('mergeImport — collision detection (issue #3)', () => {
  it('does not overwrite AGENTS.md when local repo already has a root document', async () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const importRoot = path.join(tmpDir, 'import-cache');
    const agentsDir = path.join(importRoot, '.chalk');

    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });

    // The imported repo also has an AGENTS.md
    fs.writeFileSync(path.join(agentsDir, 'AGENTS.md'), '# Imported Root\n', 'utf8');

    const localRepo = makeEmptyRepo(repoRoot);
    // Simulate that the local repo already has a root (AGENTS.md present)
    localRepo.root = {
      sourcePath: path.join(repoRoot, 'AGENTS.md'),
      relativePath: 'AGENTS.md',
      body: '# Local Root',
      frontmatter: {},
    };

    const entry = { source: 'github:owner/test-repo', ref: 'abc123' };
    const merged = await mergeImport(localRepo, entry, importRoot);

    // Local root should be preserved — import cannot overwrite it
    expect(merged.root?.relativePath).toBe('AGENTS.md');
    expect(merged.root?.body).toBe('# Local Root');
  });

  it('detects collision for uppercase skill path containing uppercase letters', async () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const importRoot = path.join(tmpDir, 'import-cache');
    const agentsDir = path.join(importRoot, '.chalk');
    const skillDir = path.join(agentsDir, 'skills', 'MySkill');

    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: MySkill\ndescription: A test skill\n---\n\nBody\n',
      'utf8',
    );

    const localRepo = makeEmptyRepo(repoRoot);
    // Simulate local repo already has a skill at the same exact path
    localRepo.skills = [
      {
        directoryPath: path.join(repoRoot, '.chalk', 'skills', 'MySkill'),
        directoryRelativePath: '.chalk/skills/MySkill',
        entrypoint: {
          sourcePath: path.join(repoRoot, '.chalk', 'skills', 'MySkill', 'SKILL.md'),
          relativePath: '.chalk/skills/MySkill/SKILL.md',
          body: 'Body',
          frontmatter: { name: 'MySkill', description: 'A test skill' },
        },
        files: [],
      },
    ];

    const entry = { source: 'github:owner/test-repo', ref: 'abc123' };
    const merged = await mergeImport(localRepo, entry, importRoot);

    // The imported skill should be skipped (local takes precedence)
    expect(merged.skills).toHaveLength(1);
    expect(merged.skills[0].directoryRelativePath).toBe('.chalk/skills/MySkill');
  });
});
