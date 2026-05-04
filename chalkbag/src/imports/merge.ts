import fs from 'node:fs';
import path from 'node:path';

import { ChalkBagError } from '../types.js';
import type { LoadedAgentsRepo, LoadedSkill, SourceDocument, SourceFile } from '../spec/load.js';
import type { ImportEntry, PermissionsConfig, SubagentDocument, TargetsFrontmatter } from '../spec/schema.js';
import {
  permissionsConfigSchema,
  skillFrontmatterSchema,
  subagentFrontmatterSchema,
  targetsFrontmatterSchema,
} from '../spec/schema.js';
import { parseFrontmatterDocument, parseYamlDocument } from '../spec/frontmatter.js';
import { validateImportPath } from './resolve.js';

export async function mergeImport(
  repo: LoadedAgentsRepo,
  entry: ImportEntry,
  cachedRepoPath: string,
  importSeen?: Set<string>,
): Promise<LoadedAgentsRepo> {
  const seen = importSeen ?? new Set<string>();

  // Security check (eng auto-fix H-4): validate entry.path before using it to
  // resolve subpaths within the cloned repository.
  if (entry.path !== undefined) {
    validateImportPath(entry.path, entry.source);
  }

  const importRoot = entry.path
    ? path.join(cachedRepoPath, entry.path)
    : path.join(cachedRepoPath, '.chalk');

  if (!(await pathExists(importRoot))) {
    throw new ChalkBagError({
      kind: 'config',
      file: entry.source,
      message: `import path does not exist: ${importRoot}`,
      fix: 'verify the path exists in the referenced repository at the specified ref',
    });
  }

  const localSeen = buildLocalCollisionSet(repo);

  // Merge AGENTS.md → root
  const agentsMdPath = path.join(importRoot, 'AGENTS.md');
  if (await pathExists(agentsMdPath)) {
    if (!localSeen.has('AGENTS.md') && !seen.has('AGENTS.md')) {
      const doc = await loadMarkdownDocument(cachedRepoPath, agentsMdPath, targetsFrontmatterSchema);
      repo.root = { ...doc, relativePath: `imports:${entry.source}/AGENTS.md` };
      seen.add('AGENTS.md');
    }
  }

  // Merge permissions.yaml
  const permissionsPath = path.join(importRoot, 'permissions.yaml');
  if (await pathExists(permissionsPath)) {
    if (!localSeen.has('permissions.yaml') && !seen.has('permissions.yaml')) {
      const raw = await fs.promises.readFile(permissionsPath, 'utf8');
      const data = parseYamlDocument(raw, permissionsPath);
      try {
        repo.permissions = permissionsConfigSchema.parse(data);
      } catch (error) {
        throw new ChalkBagError({
          kind: 'config',
          file: permissionsPath,
          message: error instanceof Error ? error.message : 'permissions schema failed',
          cause: error,
          fix: 'check the permissions.yaml against the schema documented in chalkbag/docs/agents-spec.md',
        });
      }
      seen.add('permissions.yaml');
    }
  }

  // Merge skills/
  const skillsDir = path.join(importRoot, 'skills');
  if (await pathExists(skillsDir)) {
    const importedSkills = await loadSkillDirectory(cachedRepoPath, skillsDir, entry.source);
    for (const skill of importedSkills) {
      if (localSeen.has(skill.directoryRelativePath)) continue;
      assertNoImportCollision(seen, skill.directoryRelativePath, entry.source);
      for (const file of skill.files) {
        if (localSeen.has(file.relativePath)) continue;
        assertNoImportCollision(seen, file.relativePath, entry.source);
      }
      repo.skills.push(skill);
    }
  }

  // Merge subagents/
  const subagentsDir = path.join(importRoot, 'subagents');
  if (await pathExists(subagentsDir)) {
    const importedSubagents = await loadSubagentDirectory(cachedRepoPath, subagentsDir, entry.source);
    for (const subagent of importedSubagents) {
      if (localSeen.has(subagent.relativePath)) continue;
      assertNoImportCollision(seen, subagent.relativePath, entry.source);
      repo.subagents.push(subagent);
    }
  }

  return repo;
}

function buildLocalCollisionSet(repo: LoadedAgentsRepo): Set<string> {
  const seen = new Set<string>();
  if (repo.root) seen.add('AGENTS.md');
  if (repo.permissions) seen.add('permissions.yaml');
  for (const skill of repo.skills) {
    seen.add(skill.directoryRelativePath);
    for (const file of skill.files) seen.add(file.relativePath);
  }
  for (const subagent of repo.subagents) seen.add(subagent.relativePath);
  return seen;
}

function assertNoImportCollision(seen: Set<string>, relativePath: string, source: string): void {
  if (seen.has(relativePath)) {
    throw new ChalkBagError({
      kind: 'config',
      file: source,
      message: `import collision: ${relativePath} is already defined by another import`,
      fix: 'rename one of the conflicting skills or subagents so their paths are unique across all imports',
    });
  }
  seen.add(relativePath);
}

async function loadSkillDirectory(
  repoRoot: string,
  directory: string,
  _source: string,
): Promise<LoadedSkill[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const skills: LoadedSkill[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(directory, entry.name);
    const entrypointPath = path.join(skillDir, 'SKILL.md');
    if (!(await pathExists(entrypointPath))) {
      throw new ChalkBagError({
        kind: 'config',
        file: skillDir,
        message: `imported skill directory must contain SKILL.md: ${skillDir}`,
        fix: 'add a SKILL.md with required `name` and `description` frontmatter fields to the skill directory',
      });
    }

    const files = await findAllFiles(skillDir);
    skills.push({
      directoryPath: skillDir,
      directoryRelativePath: toRepoRelative(repoRoot, skillDir),
      entrypoint: await loadMarkdownDocument(repoRoot, entrypointPath, skillFrontmatterSchema),
      files: await Promise.all(
        files.map(async (filePath) => ({
          sourcePath: filePath,
          relativePath: toRepoRelative(repoRoot, filePath),
          content: await fs.promises.readFile(filePath, 'utf8'),
        })),
      ),
    });
  }

  return skills;
}

async function loadSubagentDirectory(
  repoRoot: string,
  directory: string,
  _source: string,
): Promise<Array<SourceDocument<SubagentDocument>>> {
  const files = await findMarkdownFiles(directory);
  const docs = await Promise.all(
    files.map((file) => loadMarkdownDocument(repoRoot, file, subagentFrontmatterSchema)),
  );
  return docs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function findAllFiles(root: string): Promise<string[]> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findAllFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function loadMarkdownDocument<TFrontmatter>(
  repoRoot: string,
  filePath: string,
  schema: { parse: (input: unknown) => TFrontmatter },
): Promise<SourceDocument<TFrontmatter>> {
  const content = await fs.promises.readFile(filePath, 'utf8');
  const parsed = parseFrontmatterDocument(content, filePath);

  try {
    return {
      sourcePath: filePath,
      relativePath: toRepoRelative(repoRoot, filePath),
      body: parsed.body.trimEnd(),
      frontmatter: schema.parse(parsed.data),
    };
  } catch (error) {
    throw new ChalkBagError({
      kind: 'config',
      file: filePath,
      message: error instanceof Error ? error.message : 'schema validation failed',
      cause: error,
      fix: 'check that all required frontmatter fields (name, description) are present and correctly typed',
    });
  }
}

function toRepoRelative(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
