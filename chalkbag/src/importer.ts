import fs from 'node:fs';
import path from 'node:path';

import { providerIds, renderProvidersConfig } from './providers/registry.js';

export type ImportAgentsResult = {
  conflicts: string[];
  warnings: string[];
};

export async function importAgentsRepo(repoRoot: string): Promise<ImportAgentsResult> {
  const agentsRoot = path.join(repoRoot, '.chalk');
  const subagentsRoot = path.join(agentsRoot, 'subagents');
  const legacyAgentsRoot = path.join(repoRoot, '.claude', 'agents');

  await fs.promises.mkdir(subagentsRoot, { recursive: true });

  const rootBodies = await readExistingRootBodies(repoRoot);
  const rootBody = rootBodies.filter(Boolean).join('\n\n---\n\n').trim();
  if (rootBody.length > 0) {
    await fs.promises.writeFile(path.join(repoRoot, 'AGENTS.md'), `${rootBody}\n`, 'utf8');
    await ensureClaudeSymlink(repoRoot);
  }

  const claudeAgents = await findMarkdownFiles(legacyAgentsRoot);
  for (const agentPath of claudeAgents) {
    const relativeAgentPath = path.relative(legacyAgentsRoot, agentPath);
    const targetPath = path.join(subagentsRoot, relativeAgentPath);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(agentPath, targetPath);
  }

  const legacyRules = await findMarkdownFiles(path.join(repoRoot, '.claude', 'rules'));
  const legacyCommands = await findMarkdownFiles(path.join(repoRoot, '.claude', 'commands'));

  // Also check for .codex/ and .opencode/ legacy presence
  const codexPresent = await pathExists(path.join(repoRoot, '.codex'));
  const opencodePresent = await pathExists(path.join(repoRoot, '.opencode'));

  const importedProviderContext = {
    repoRoot,
    claudeAgentsCount: claudeAgents.length,
    legacyRulesCount: legacyRules.length,
    legacyCommandsCount: legacyCommands.length,
    codexPresent,
    opencodePresent,
  };
  const enabledByProvider = Object.fromEntries(
    await Promise.all(
      providerIds.map(
        async (providerId) =>
          [providerId, await isImportedProviderEnabled(providerId, importedProviderContext)] as const,
      ),
    ),
  );

  await fs.promises.writeFile(
    path.join(agentsRoot, 'providers.yaml'),
    renderProvidersConfig(enabledByProvider),
    'utf8',
  );

  const conflicts = await findScopedAgents(repoRoot);
  const warnings = [
    ...(legacyRules.length > 0
      ? ['legacy Claude rules require manual migration into tracked AGENTS.md files']
      : []),
    ...(legacyCommands.length > 0
      ? ['legacy Claude commands require manual migration into shared skills']
      : []),
  ];

  if (conflicts.length > 0 || warnings.length > 0) {
    console.log('chalkbag import: completed with notes:');
    for (const warning of warnings) {
      console.log(`  warning: ${warning}`);
    }
    for (const conflict of conflicts) {
      console.log(`  scoped agent found: ${conflict} (review and move to .chalk/subagents/ if needed)`);
    }
  } else {
    console.log('chalkbag import: ok');
  }

  return {
    conflicts,
    warnings,
  };
}

async function isImportedProviderEnabled(
  providerId: (typeof providerIds)[number],
  context: {
    repoRoot: string;
    claudeAgentsCount: number;
    legacyRulesCount: number;
    legacyCommandsCount: number;
    codexPresent: boolean;
    opencodePresent: boolean;
  },
): Promise<boolean> {
  switch (providerId) {
    case 'claude':
      return (
        context.claudeAgentsCount > 0 ||
        context.legacyRulesCount > 0 ||
        context.legacyCommandsCount > 0 ||
        (await pathExists(path.join(context.repoRoot, 'CLAUDE.md')))
      );
    case 'codex':
      return context.codexPresent || (await pathExists(path.join(context.repoRoot, 'AGENTS.md')));
    case 'opencode':
      return (
        context.opencodePresent ||
        (await pathExists(path.join(context.repoRoot, 'opencode.json')))
      );
    default:
      return false;
  }
}

async function readExistingRootBodies(repoRoot: string): Promise<string[]> {
  const files = [path.join(repoRoot, 'AGENTS.md'), path.join(repoRoot, 'CLAUDE.md')];
  const bodies: string[] = [];

  for (const filePath of files) {
    if (!(await pathExists(filePath))) {
      continue;
    }
    bodies.push((await fs.promises.readFile(filePath, 'utf8')).trim());
  }

  return [...new Set(bodies)];
}

async function ensureClaudeSymlink(repoRoot: string): Promise<void> {
  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  try {
    const stat = await fs.promises.lstat(claudePath);
    if (stat.isSymbolicLink()) {
      const target = await fs.promises.readlink(claudePath);
      if (target === 'AGENTS.md') {
        return;
      }
    }
    await fs.promises.rm(claudePath, { force: true });
  } catch {
    // no existing CLAUDE.md
  }

  await fs.promises.symlink('AGENTS.md', claudePath);
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function findScopedAgents(repoRoot: string): Promise<string[]> {
  const files = await scanForScopedAgents(repoRoot, repoRoot);
  return files.map((filePath) => path.relative(repoRoot, filePath).split(path.sep).join('/'));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

const IGNORED_CONFLICT_SCAN_DIRS = new Set([
  '.agents',
  '.chalk',
  '.claude',
  '.codex',
  '.gemini',
  '.git',
  '.opencode',
  'node_modules',
]);

async function scanForScopedAgents(root: string, currentDir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_CONFLICT_SCAN_DIRS.has(entry.name)) {
        continue;
      }

      files.push(...(await scanForScopedAgents(root, fullPath)));
      continue;
    }

    if (
      entry.isFile() &&
      entry.name === 'AGENTS.md' &&
      fullPath !== path.join(root, 'AGENTS.md')
    ) {
      files.push(fullPath);
    }
  }

  return files.sort();
}
