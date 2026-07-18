import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { providerIds, renderProvidersConfig } from '../providers/registry.js';
import { ChalkBagError } from '../types.js';

export type ScaffoldOptions = {
  providers?: string[];
  templateRoot?: string;
  dryRun?: boolean;
};

export type ScaffoldResult = {
  created: string[];
  skipped: string[];
  wouldCreate: string[];
};

function validateProviders(providers: string[] | undefined): void {
  if (!providers || providers.length === 0) return;
  const invalid = providers.filter((id) => !providerIds.includes(id as (typeof providerIds)[number]));
  if (invalid.length > 0) {
    throw new ChalkBagError({
      kind: 'cli',
      file: invalid[0],
      message: `unknown provider id: ${invalid.join(', ')}. Valid providers: ${providerIds.join(', ')}`,
      fix: `use one or more of: ${providerIds.join(', ')}`,
    });
  }
}

export async function scaffoldRepo(
  targetRoot: string,
  options: ScaffoldOptions = {},
): Promise<ScaffoldResult> {
  validateProviders(options.providers);

  const templateRoot = options.templateRoot ?? (await resolveTemplateRoot());
  const agentsDir = path.join(targetRoot, '.chalk');
  if (!options.dryRun) {
    await fs.promises.mkdir(agentsDir, { recursive: true });
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const wouldCreate: string[] = [];

  // Check if providers.yaml already exists (user-modified) BEFORE template copy
  const providersPath = path.join(agentsDir, 'providers.yaml');
  const providersExistedBefore = await pathExists(providersPath);

  await copyTemplateTree(templateRoot, agentsDir, created, skipped, wouldCreate, options.dryRun);

  if (options.providers && options.providers.length > 0) {
    if (providersExistedBefore) {
      // User already has a providers.yaml — skip to avoid clobbering edits
      skipped.push('providers.yaml');
    } else {
      // Fresh scaffold: patch the freshly-copied template providers.yaml
      if (!options.dryRun) await patchProviders(providersPath, options.providers);
      // providers.yaml was already counted in created/wouldCreate by copyTemplateTree
      // (the template copied it); no need to push again
    }
  }

  const agentsMdPath = path.join(targetRoot, 'AGENTS.md');
  if (!(await pathExists(agentsMdPath))) {
    if (!options.dryRun) {
      await fs.promises.writeFile(agentsMdPath, renderAgentsMdStub(path.basename(targetRoot)), 'utf8');
    }
    created.push('AGENTS.md');
    wouldCreate.push('AGENTS.md');
  } else {
    skipped.push('AGENTS.md');
  }

  // Create Claude bridge symlink when Claude is enabled
  const claudeEnabled =
    !options.providers || options.providers.length === 0 || options.providers.includes('claude');
  const claudeMdPath = path.join(targetRoot, 'CLAUDE.md');
  if (claudeEnabled && !(await pathExists(claudeMdPath))) {
    if (!options.dryRun) {
      await fs.promises.symlink('AGENTS.md', claudeMdPath);
    }
    created.push('CLAUDE.md');
    wouldCreate.push('CLAUDE.md');
  } else if (claudeEnabled) {
    skipped.push('CLAUDE.md');
  }

  return { created, skipped, wouldCreate };
}

async function resolveTemplateRoot(): Promise<string> {
  // Respect explicit override for unusual install layouts.
  const overrideRoot = process.env.CHALKBAG_TEMPLATE_ROOT;
  if (overrideRoot) {
    const candidate = path.resolve(overrideRoot);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  // This file compiles to one of:
  //   src/commands/scaffold.ts  (tsx dev)       → ../../.. =  repo / ../.. = package root
  //   dist/commands/scaffold.js (installed)     → ../.. = package root
  // Try 2 ups first (compiled + tsx), then 3 ups (older dev layout).
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(selfDir, '..', '..', 'templates', '.chalk'),
    path.resolve(selfDir, '..', '..', '..', 'templates', '.chalk'),
  ];
  for (const templatePath of candidates) {
    if (await pathExists(templatePath)) {
      return templatePath;
    }
  }

  const templatePath = candidates[0];
  if (!(await pathExists(templatePath))) {
    throw new ChalkBagError({
      kind: 'io',
      file: templatePath,
      message: 'template directory not found; is chalkbag installed correctly?',
      fix: 'reinstall chalkbag or set CHALKBAG_TEMPLATE_ROOT to the .chalk template directory path',
    });
  }

  return templatePath;
}

async function copyTemplateTree(
  sourceRoot: string,
  targetRoot: string,
  created: string[],
  skipped: string[],
  wouldCreate: string[],
  dryRun: boolean | undefined,
): Promise<void> {
  const entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);

    if (entry.isDirectory()) {
      if (!dryRun) {
        await fs.promises.mkdir(targetPath, { recursive: true });
      }
      await copyTemplateTree(sourcePath, targetPath, created, skipped, wouldCreate, dryRun);
      continue;
    }

    if (entry.isFile()) {
      if (await pathExists(targetPath)) {
        skipped.push(path.relative(targetRoot, targetPath));
      } else {
        if (!dryRun) {
          await fs.promises.copyFile(sourcePath, targetPath);
        }
        const rel = path.relative(targetRoot, targetPath);
        created.push(rel);
        wouldCreate.push(rel);
      }
    }
  }
}

async function patchProviders(providersPath: string, enabledProviders: string[]): Promise<void> {
  const enabledByProvider: Partial<Record<string, boolean>> = {};
  for (const id of providerIds) {
    enabledByProvider[id] = enabledProviders.includes(id);
  }
  await fs.promises.writeFile(providersPath, renderProvidersConfig(enabledByProvider), 'utf8');
}

/**
 * Renders the map-style `AGENTS.md` stub used by both the repo scaffold and the
 * machine-level (`--global`) scaffold. The `global` variant reframes the map
 * around the developer's machine instead of a single repository.
 */
export function renderAgentsMdStub(title: string, options: { global?: boolean } = {}): string {
  if (options.global) {
    return `# ${title}

<!-- Machine-level agent guidance. Write this as a MAP, not a README: keep it
     short and point at the real tools/docs. This file is the source of truth
     behind \`~/.claude/CLAUDE.md\` and \`~/.codex/AGENTS.md\` (chalkbag manages
     those bridge symlinks). Doctrine, with good/bad examples:
     https://github.com/donovan-yohan/chalk-bag/blob/master/chalkbag/docs/authoring-agents-md.md -->

One line: how you work on this machine and what an agent should always assume.

## Machine map

| Path | What lives there | When to read it |
|---|---|---|
| \`~/.chalk/\` | Machine-level chalkbag source (skills, permissions, this file) | Editing global agent config |
| \`~/<projects-dir>/\` | Where your repositories live | Locating a repo to work in |

## Defaults every agent should assume

- Prefer the machine's installed toolchain and package managers already on \`PATH\`.
- Repository-level \`AGENTS.md\` files override this file — read the repo's first.
- Keep secrets out of prompts and generated config.

## Working rules

- These rules apply everywhere; put repo-specific rules in that repo's \`AGENTS.md\`.
- Machine-wide skills live in \`~/.chalk/skills/\`; keep them broadly useful.
`;
  }

  return `# ${title}

<!-- Write this file as a MAP, not a README. Keep it ~60-120 lines: point at the
     real docs instead of duplicating them. Doctrine, with good/bad examples:
     https://github.com/donovan-yohan/chalk-bag/blob/master/chalkbag/docs/authoring-agents-md.md -->

One line: what this repository is and does.

## Directory map

| Path | What lives there | When to read it |
|---|---|---|
| \`src/\` | Application source | Changing behavior |
| \`tests/\` | Test suites | Adding or fixing tests |
| \`.chalk/\` | chalkbag source (skills, permissions, provider config) | Editing agent config; see \`.chalk/README.md\` |

## Commands

- Install: \`<install command>\`
- Build: \`<build command>\`
- Test: \`<test command>\` — single file: \`<single-test command>\`
- Lint: \`<lint command>\`

## Working rules

- Preserve the repo's established file organization.
- Keep thin entrypoints thin; move substantial logic into libraries or focused helper modules.
- When behavior changes, update the nearest spec/plan/docs that explain it.

## Scoped guides

| Path | Covers |
|---|---|
| _(add scoped AGENTS.md files here as the repo grows)_ | |
`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
