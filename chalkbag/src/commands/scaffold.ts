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
  const agentsDir = path.join(targetRoot, '.agents');
  if (!options.dryRun) {
    await fs.promises.mkdir(agentsDir, { recursive: true });
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const wouldCreate: string[] = [];

  await copyTemplateTree(templateRoot, agentsDir, created, skipped, wouldCreate, options.dryRun);

  const providersPath = path.join(agentsDir, 'providers.yaml');
  if (options.providers && options.providers.length > 0) {
    if (!options.dryRun) {
      await patchProviders(providersPath, options.providers);
    }
    wouldCreate.push('providers.yaml');
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
  // This file lives at chalkbag/src/commands/scaffold.ts
  // Template root is 3 levels up (to chalkbag/) then templates/.agents
  const chalkbagRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const templatePath = path.join(chalkbagRoot, 'templates', '.agents');

  if (!(await pathExists(templatePath))) {
    throw new ChalkBagError({
      kind: 'io',
      file: templatePath,
      message: 'template directory not found; is chalkbag installed correctly?',
      fix: 'reinstall chalkbag or set CHALKBAG_TEMPLATE_ROOT to the .agents template directory path',
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

function renderAgentsMdStub(repoName: string): string {
  return `# ${repoName}

Briefly describe the repository, the default branch, and the main technology stack.
For chalkbag authoring workflow, see \`.agents/README.md\`; keep this file repo-specific.

## Repo map

- Key directories and their purposes

## Working rules

- Preserve the repo's established file organization.
- Keep thin entrypoints thin; move substantial logic into libraries or focused helper modules.
- When behavior changes, update the nearest spec/plan/docs that explain it.
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
