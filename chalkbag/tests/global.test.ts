import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  buildGlobalScope,
  cleanGlobalScope,
  scaffoldGlobal,
  validateGlobalScope,
} from '../src/global.js';
import { ChalkBagError } from '../src/types.js';

// Every test runs against a temp HOME via CHALKBAG_HOME — the real $HOME is
// never touched. (Mirrors the XDG/CHALKBAG_CONFIG_HOME seam in systemd.test.ts.)
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-global-test-'));
  process.env['CHALKBAG_HOME'] = home;
});

afterEach(() => {
  delete process.env['CHALKBAG_HOME'];
  fs.rmSync(home, { recursive: true, force: true });
});

const chalkDir = (): string => path.join(home, '.chalk');
const read = (p: string): string => fs.readFileSync(p, 'utf8');

function writeChalkFile(rel: string, content: string): void {
  const full = path.join(chalkDir(), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function addSkill(name: string): void {
  writeChalkFile(
    path.join('skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A ${name} skill.\n---\n\nDo ${name} things.\n`,
  );
}

// ---------------------------------------------------------------------------
// scaffoldGlobal
// ---------------------------------------------------------------------------

describe('scaffoldGlobal', () => {
  it('creates ~/.chalk with providers.yaml, skills/, README.md and a machine-level AGENTS.md', async () => {
    const result = await scaffoldGlobal();

    expect(fs.existsSync(path.join(chalkDir(), 'providers.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(chalkDir(), 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(chalkDir(), 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(chalkDir(), 'AGENTS.md'))).toBe(true);
    expect(result.created).toContain('AGENTS.md');
    expect(result.created).toContain('providers.yaml');
  });

  it('enables claude + codex but not opencode in providers.yaml', async () => {
    await scaffoldGlobal();
    const providers = read(path.join(chalkDir(), 'providers.yaml'));
    expect(providers).toMatch(/claude:\n\s+enabled: true/);
    expect(providers).toMatch(/codex:\n\s+enabled: true/);
    expect(providers).toMatch(/opencode:\n\s+enabled: false/);
  });

  it('writes a machine-level (not repo-level) AGENTS.md stub', async () => {
    await scaffoldGlobal();
    const agents = read(path.join(chalkDir(), 'AGENTS.md'));
    expect(agents).toContain('Machine map');
    expect(agents).toContain('~/.chalk/');
    // does NOT create AGENTS.md at the home root
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false);
  });

  it('is idempotent — second run skips existing files', async () => {
    await scaffoldGlobal();
    fs.writeFileSync(path.join(chalkDir(), 'AGENTS.md'), '# custom\n', 'utf8');
    const result = await scaffoldGlobal();
    expect(result.skipped).toContain('AGENTS.md');
    expect(read(path.join(chalkDir(), 'AGENTS.md'))).toBe('# custom\n');
  });
});

// ---------------------------------------------------------------------------
// build — skills projection
// ---------------------------------------------------------------------------

describe('buildGlobalScope — skills projection', () => {
  it('projects skills into ~/.claude/skills and ~/.agents/skills', async () => {
    await scaffoldGlobal();
    addSkill('deploy');

    await buildGlobalScope({});

    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(read(path.join(home, '.agents', 'skills', 'deploy', 'SKILL.md'))).toContain('name: deploy');
  });

  it('does not project into ~/opencode.json or ~/.codex/skills', async () => {
    await scaffoldGlobal();
    addSkill('deploy');
    await buildGlobalScope({});
    expect(fs.existsSync(path.join(home, 'opencode.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'skills'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// build — context-file bridging
// ---------------------------------------------------------------------------

describe('buildGlobalScope — context-file bridging', () => {
  it('symlinks ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md at ~/.chalk/AGENTS.md', async () => {
    await scaffoldGlobal();
    await buildGlobalScope({});

    const claudeLink = path.join(home, '.claude', 'CLAUDE.md');
    const codexLink = path.join(home, '.codex', 'AGENTS.md');
    const target = path.join(chalkDir(), 'AGENTS.md');

    expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(codexLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(claudeLink)).toBe(fs.realpathSync(target));
    expect(fs.realpathSync(codexLink)).toBe(fs.realpathSync(target));
  });

  it('is idempotent — a second build leaves the correct symlinks in place', async () => {
    await scaffoldGlobal();
    await buildGlobalScope({});
    const claudeLink = path.join(home, '.claude', 'CLAUDE.md');
    const before = fs.readlinkSync(claudeLink);

    const result = await buildGlobalScope({});
    expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(claudeLink)).toBe(before);
    // idempotent second run relinks nothing (already correct)
    expect(result.linked).not.toContain(path.join('.claude', 'CLAUDE.md'));
  });

  it('refuses to overwrite an existing regular file with content and points to the merge fix', async () => {
    await scaffoldGlobal();
    const claudeLink = path.join(home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeLink), { recursive: true });
    fs.writeFileSync(claudeLink, '# my existing global claude instructions\n', 'utf8');

    await expect(buildGlobalScope({})).rejects.toThrow(ChalkBagError);

    // the user's file is preserved untouched
    expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(false);
    expect(read(claudeLink)).toBe('# my existing global claude instructions\n');
  });

  it('reports an actionable merge instruction in the conflict error', async () => {
    await scaffoldGlobal();
    const codexLink = path.join(home, '.codex', 'AGENTS.md');
    fs.mkdirSync(path.dirname(codexLink), { recursive: true });
    fs.writeFileSync(codexLink, 'pre-existing codex agents content\n', 'utf8');

    try {
      await buildGlobalScope({});
      expect.fail('expected a conflict error');
    } catch (err) {
      expect(err).toBeInstanceOf(ChalkBagError);
      const cb = err as ChalkBagError;
      expect(cb.message).toContain('~/.codex/AGENTS.md');
      expect(cb.fix).toMatch(/merge the existing content/);
    }
  });

  it('replaces an empty regular file with the bridge symlink', async () => {
    await scaffoldGlobal();
    const claudeLink = path.join(home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeLink), { recursive: true });
    fs.writeFileSync(claudeLink, '   \n', 'utf8'); // whitespace-only

    await buildGlobalScope({});
    expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(true);
  });

  it('refuses to repoint a foreign symlink and leaves it untouched', async () => {
    await scaffoldGlobal();
    const claudeLink = path.join(home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeLink), { recursive: true });
    // A user-managed symlink pointing at some other real file.
    const foreign = path.join(home, 'my-global-claude.md');
    fs.writeFileSync(foreign, '# my own global instructions\n', 'utf8');
    fs.symlinkSync(foreign, claudeLink);

    try {
      await buildGlobalScope({});
      expect.fail('expected a conflict error');
    } catch (err) {
      expect(err).toBeInstanceOf(ChalkBagError);
      expect((err as ChalkBagError).message).toContain(foreign);
    }

    // The foreign link is left exactly as it was — never repointed.
    expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(claudeLink)).toBe(foreign);
  });

  it('refuses a dangling symlink rather than silently repointing it', async () => {
    await scaffoldGlobal();
    const claudeLink = path.join(home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeLink), { recursive: true });
    const missing = path.join(home, 'gone.md');
    fs.symlinkSync(missing, claudeLink); // target does not exist

    try {
      await buildGlobalScope({});
      expect.fail('expected a conflict error');
    } catch (err) {
      expect(err).toBeInstanceOf(ChalkBagError);
      expect((err as ChalkBagError).message).toContain('dangling');
    }

    // Still the same dangling link — not repointed at ~/.chalk/AGENTS.md.
    expect(fs.readlinkSync(claudeLink)).toBe(missing);
  });

  it('leaves a correct-target bridge symlink as an idempotent no-op', async () => {
    await scaffoldGlobal();
    const claudeLink = path.join(home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeLink), { recursive: true });
    // Pre-create the exact bridge link chalkbag would make.
    fs.symlinkSync(path.join(chalkDir(), 'AGENTS.md'), claudeLink);

    const result = await buildGlobalScope({});
    expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(claudeLink)).toBe(fs.realpathSync(path.join(chalkDir(), 'AGENTS.md')));
    // Already correct — not relisted as newly linked.
    expect(result.linked).not.toContain(path.join('.claude', 'CLAUDE.md'));
  });
});

// ---------------------------------------------------------------------------
// build — codex managed block
// ---------------------------------------------------------------------------

describe('buildGlobalScope — codex managed block', () => {
  const permissions = `sandbox:
  mode: "workspace-write"
  networkAccess: true
webfetch:
  allow:
    - "domain:github.com"
`;

  it('inserts a managed block into ~/.codex/config.toml preserving user content, no project trust block', async () => {
    await scaffoldGlobal();
    writeChalkFile('permissions.yaml', permissions);

    const configPath = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '# user codex config\nmodel = "gpt-5"\n', 'utf8');

    await buildGlobalScope({});

    const config = read(configPath);
    expect(config).toContain('# user codex config');
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain('>>> chalkbag managed');
    expect(config).toContain('sandbox_mode = "workspace-write"');
    // repo-only project-trust block must NOT appear in the global managed block
    expect(config).not.toContain('[projects.');
    expect(config).not.toContain('trust_level');
  });

  it('replaces the managed block on rebuild without duplicating it', async () => {
    await scaffoldGlobal();
    writeChalkFile('permissions.yaml', permissions);
    await buildGlobalScope({});
    await buildGlobalScope({});

    const config = read(path.join(home, '.codex', 'config.toml'));
    expect(config.split('>>> chalkbag managed')).toHaveLength(2);
  });

  it('does not touch ~/.codex/config.toml when no permissions.yaml exists', async () => {
    await scaffoldGlobal();
    await buildGlobalScope({});
    expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// build — claude settings.json merge preservation
// ---------------------------------------------------------------------------

describe('buildGlobalScope — settings.json merge', () => {
  it('merges permissions while preserving unrelated user keys and permissions', async () => {
    await scaffoldGlobal();
    writeChalkFile('permissions.yaml', `bash:\n  allow:\n    - "git status"\n`);

    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: 'claude-opus',
          permissions: { allow: ['Bash(npm run build)'], deny: [] },
        },
        null,
        2,
      ),
      'utf8',
    );

    await buildGlobalScope({});

    const settings = JSON.parse(read(settingsPath)) as {
      model?: string;
      permissions: { allow: string[] };
    };
    // unrelated top-level key preserved
    expect(settings.model).toBe('claude-opus');
    // user's own permission preserved
    expect(settings.permissions.allow).toContain('Bash(npm run build)');
    // chalkbag's permission added
    expect(settings.permissions.allow).toContain('Bash(git status)');
  });

  it('fails closed on a malformed settings.json and leaves the user file untouched', async () => {
    await scaffoldGlobal();
    writeChalkFile('permissions.yaml', `bash:\n  allow:\n    - "git status"\n`);

    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    // A hand-edit slip / partial write: present but not valid JSON.
    const malformed = '{ "model": "claude-opus", "permissions": { "allow": [ }';
    fs.writeFileSync(settingsPath, malformed, 'utf8');

    await expect(buildGlobalScope({})).rejects.toThrow(ChalkBagError);

    // The real settings.json is never rewritten from the broken read.
    expect(read(settingsPath)).toBe(malformed);
  });

  it('names the settings.json path and gives a repair fix in the error', async () => {
    await scaffoldGlobal();
    writeChalkFile('permissions.yaml', `bash:\n  allow:\n    - "git status"\n`);

    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, 'not json at all', 'utf8');

    try {
      await buildGlobalScope({});
      expect.fail('expected a config error');
    } catch (err) {
      expect(err).toBeInstanceOf(ChalkBagError);
      const cb = err as ChalkBagError;
      expect(cb.kind).toBe('config');
      expect(cb.file).toBe(settingsPath);
      expect(cb.fix).toMatch(/fix or move the malformed file, then re-run/);
    }
  });
});

// ---------------------------------------------------------------------------
// clean — safety
// ---------------------------------------------------------------------------

describe('cleanGlobalScope — safety', () => {
  it('removes chalkbag outputs but preserves the user config files', async () => {
    await scaffoldGlobal();
    addSkill('deploy');
    writeChalkFile(
      'permissions.yaml',
      `bash:\n  allow:\n    - "git status"\nsandbox:\n  mode: "read-only"\n`,
    );

    // Seed a user codex config with content outside the managed block.
    const codexPath = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(codexPath, '# user codex\nmodel = "gpt-5"\n', 'utf8');

    await buildGlobalScope({});

    const settingsPath = path.join(home, '.claude', 'settings.json');
    const claudeSkill = path.join(home, '.claude', 'skills', 'deploy', 'SKILL.md');
    const agentsSkill = path.join(home, '.agents', 'skills', 'deploy', 'SKILL.md');
    const claudeLink = path.join(home, '.claude', 'CLAUDE.md');
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(fs.existsSync(claudeSkill)).toBe(true);
    expect(fs.existsSync(agentsSkill)).toBe(true);
    expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(true);

    const result = await cleanGlobalScope();

    // skills removed
    expect(fs.existsSync(claudeSkill)).toBe(false);
    expect(fs.existsSync(agentsSkill)).toBe(false);
    // bridge symlinks removed (they pointed at ~/.chalk/AGENTS.md)
    expect(fs.existsSync(claudeLink)).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'AGENTS.md'))).toBe(false);
    // codex managed block stripped, user content preserved
    const codex = read(codexPath);
    expect(codex).toContain('model = "gpt-5"');
    expect(codex).not.toContain('chalkbag managed');
    // user settings.json preserved (never deleted)
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(result.preserved).toContain(path.join('.claude', 'settings.json'));
    // the removed report accurately lists the reaped skill outputs
    expect(result.removed).toContain(path.join('.claude', 'skills', 'deploy', 'SKILL.md'));
    expect(result.removed).toContain(path.join('.agents', 'skills', 'deploy', 'SKILL.md'));
  });

  it('does not remove a foreign CLAUDE.md that points elsewhere', async () => {
    await scaffoldGlobal();
    await buildGlobalScope({});

    // Repoint the bridge symlink at some other file — clean must leave it.
    const claudeLink = path.join(home, '.claude', 'CLAUDE.md');
    fs.rmSync(claudeLink, { force: true });
    const foreign = path.join(home, 'elsewhere.md');
    fs.writeFileSync(foreign, 'x\n', 'utf8');
    fs.symlinkSync(foreign, claudeLink);

    await cleanGlobalScope();
    expect(fs.existsSync(claudeLink)).toBe(true);
    expect(fs.readlinkSync(claudeLink)).toBe(foreign);
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('validateGlobalScope', () => {
  it('passes for a scaffolded tree', async () => {
    await scaffoldGlobal();
    await expect(validateGlobalScope()).resolves.toBeUndefined();
  });

  it('throws when ~/.chalk is missing', async () => {
    await expect(validateGlobalScope()).rejects.toThrow(ChalkBagError);
  });
});
