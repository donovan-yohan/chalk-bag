import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { scaffoldRepo } from '../src/commands/scaffold.js';
import { ChalkBagError } from '../src/types.js';

// Point at the built-in template directory
const TEMPLATE_ROOT = path.resolve(
  new URL('../templates/.chalk', import.meta.url).pathname,
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-scaffold-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scaffoldRepo — creates .chalk/ with template files
// ---------------------------------------------------------------------------

describe('scaffoldRepo — creates .chalk/ with template files', () => {
  it('creates the .chalk/ directory', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    expect(fs.existsSync(path.join(tmpDir, '.chalk'))).toBe(true);
  });

  it('copies providers.yaml from the template', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    expect(fs.existsSync(path.join(tmpDir, '.chalk', 'providers.yaml'))).toBe(true);
  });

  it('copies README.md from the template', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    expect(fs.existsSync(path.join(tmpDir, '.chalk', 'README.md'))).toBe(true);
  });

  it('copies the skills directory with example skill', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    expect(fs.existsSync(path.join(tmpDir, '.chalk', 'skills'))).toBe(true);
  });

  it('creates AGENTS.md stub at repo root', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    const agentsMd = path.join(tmpDir, 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    const content = fs.readFileSync(agentsMd, 'utf8');
    // Stub contains the repo name as heading
    expect(content).toContain('#');
  });

  it('reports created files in result.created', async () => {
    const result = await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    expect(result.created.length).toBeGreaterThan(0);
    // AGENTS.md should be in created list
    expect(result.created).toContain('AGENTS.md');
  });

  it('creates CLAUDE.md symlink when claude is enabled (default)', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    expect(fs.existsSync(claudeMdPath)).toBe(true);
    const stat = fs.lstatSync(claudeMdPath);
    expect(stat.isSymbolicLink()).toBe(true);
    // Should link to AGENTS.md
    const linkTarget = fs.readlinkSync(claudeMdPath);
    expect(linkTarget).toBe('AGENTS.md');
  });
});

// ---------------------------------------------------------------------------
// scaffoldRepo — idempotent (second run skips existing files)
// ---------------------------------------------------------------------------

describe('scaffoldRepo — idempotent on second run', () => {
  it('does not throw on second call', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    await expect(scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT })).resolves.toBeDefined();
  });

  it('reports existing files as skipped on second run', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    const result = await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('does not overwrite AGENTS.md on second run', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    const agentsMd = path.join(tmpDir, 'AGENTS.md');
    const original = fs.readFileSync(agentsMd, 'utf8');

    // Modify the file
    fs.writeFileSync(agentsMd, '# My Custom Content\n', 'utf8');

    // Second run should skip it
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    const after = fs.readFileSync(agentsMd, 'utf8');
    expect(after).toBe('# My Custom Content\n');
  });

  it('does not overwrite CLAUDE.md symlink on second run', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    const claudeMd = path.join(tmpDir, 'CLAUDE.md');
    const original = fs.readlinkSync(claudeMd);

    const result = await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    expect(result.skipped).toContain('CLAUDE.md');
    expect(fs.readlinkSync(claudeMd)).toBe(original);
  });

  it('reports empty created list on fully-idempotent second run', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    const result = await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    // On second run all files already exist — nothing should be newly created
    expect(result.created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scaffoldRepo — --provider filter
// ---------------------------------------------------------------------------

describe('scaffoldRepo — --provider filter', () => {
  it('filters providers.yaml to only include requested providers', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT, providers: ['claude'] });
    const providersPath = path.join(tmpDir, '.chalk', 'providers.yaml');
    const content = fs.readFileSync(providersPath, 'utf8');
    // claude should be enabled
    expect(content).toContain('claude');
    expect(content).toContain('enabled: true');
    // codex and opencode should be disabled
    expect(content).toContain('codex');
    expect(content).toContain('enabled: false');
  });

  it('creates CLAUDE.md symlink when claude is in providers list', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT, providers: ['claude'] });
    const claudeMd = path.join(tmpDir, 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(true);
  });

  it('does NOT create CLAUDE.md symlink when claude is not in providers list', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT, providers: ['codex'] });
    const claudeMd = path.join(tmpDir, 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(false);
  });

  it('throws ChalkBagError for unknown provider ids', async () => {
    await expect(
      scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT, providers: ['nonexistent-provider'] }),
    ).rejects.toThrow(ChalkBagError);
  });

  it('includes all providers when no filter is given', async () => {
    await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT });
    const providersPath = path.join(tmpDir, '.chalk', 'providers.yaml');
    const content = fs.readFileSync(providersPath, 'utf8');
    expect(content).toContain('claude');
    expect(content).toContain('codex');
    expect(content).toContain('opencode');
  });
});

// ---------------------------------------------------------------------------
// scaffoldRepo — dryRun mode
// ---------------------------------------------------------------------------

describe('scaffoldRepo — dryRun mode', () => {
  it('does not create any files in dryRun mode', async () => {
    const result = await scaffoldRepo(tmpDir, { templateRoot: TEMPLATE_ROOT, dryRun: true });
    expect(fs.existsSync(path.join(tmpDir, '.chalk'))).toBe(false);
    // wouldCreate should list what would be created
    expect(result.wouldCreate.length).toBeGreaterThan(0);
  });
});
