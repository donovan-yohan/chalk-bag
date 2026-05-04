import fs from 'node:fs';
import path from 'node:path';

import { ZodError } from 'zod';

import type { AgentsConfig, PermissionsConfig, ProvidersConfig, SkillDocument, SubagentDocument, TargetsFrontmatter } from './types.js';
import {
  agentsConfigSchema,
  permissionsConfigSchema,
  providersConfigSchema,
  skillFrontmatterSchema,
  subagentFrontmatterSchema,
  targetsFrontmatterSchema,
} from './schema.js';
import { ChalkBagError } from '../types.js';
import { getGitHubToken, parseGitHubSource, resolveRef, ensureCached, mergeImport } from '../imports/index.js';
import { parseFrontmatterDocument, parseYamlDocument } from './frontmatter.js';
import type { AgentsScope } from '../scope.js';

export type SourceDocument<TFrontmatter> = {
  sourcePath: string;
  relativePath: string;
  body: string;
  frontmatter: TFrontmatter;
};

export type SourceFile = {
  sourcePath: string;
  relativePath: string;
  content: string;
};

export type LoadedSkill = {
  directoryPath: string;
  directoryRelativePath: string;
  entrypoint: SourceDocument<SkillDocument>;
  files: SourceFile[];
};

export type LoadedAgentsRepo = {
  scope: AgentsScope;
  repoRoot: string;
  root: SourceDocument<TargetsFrontmatter> | null;
  providers: ProvidersConfig;
  skills: LoadedSkill[];
  subagents: SourceDocument<SubagentDocument>[];
  permissions: PermissionsConfig | null;
};

export async function loadAgentsRepo(scope: AgentsScope): Promise<LoadedAgentsRepo> {
  const agentsRoot = scope.agentsRoot;
  const repoRoot = scope.sourceRoot;
  const rootPath = path.join(agentsRoot, 'AGENTS.md');
  const providersPath = path.join(agentsRoot, 'providers.yaml');
  const permissionsPath = path.join(agentsRoot, 'permissions.yaml');
  const legacyPaths = [
    path.join(agentsRoot, 'rules'),
    path.join(agentsRoot, 'commands'),
    path.join(agentsRoot, 'agents'),
  ];

  await assertFileExists(providersPath, 'root .chalk/providers.yaml is required');

  // Root AGENTS.md is loaded from the repo root (tracked file), not from .chalk/
  const repoRootAgentsMd = path.join(repoRoot, 'AGENTS.md');
  const root = (await pathExists(repoRootAgentsMd))
    ? await loadMarkdownDocument(repoRoot, repoRootAgentsMd, targetsFrontmatterSchema)
    : null;

  for (const legacyPath of legacyPaths) {
    await assertPathMissing(legacyPath, 'unsupported chalkbag directory; use tracked AGENTS.md, .chalk/skills/, and .chalk/subagents/');
  }
  await assertPathMissing(rootPath, 'root AGENTS.md must be tracked directly in the repo root, not inside .chalk/');

  const providers = parseWithSchema(
    providersConfigSchema,
    parseYamlDocument(await readUtf8File(providersPath), providersPath),
    providersPath,
  );
  const permissions = await maybeLoadPermissions(permissionsPath);

  const skills = await loadSkillDirectory(repoRoot, path.join(agentsRoot, 'skills'));
  const subagents = await loadDocumentDirectory(repoRoot, path.join(agentsRoot, 'subagents'), subagentFrontmatterSchema);

  let repo: LoadedAgentsRepo = {
    scope,
    repoRoot,
    root,
    providers,
    permissions,
    skills,
    subagents,
  };

  const configPath = path.join(agentsRoot, 'config.yaml');
  const config = await maybeLoadConfig(configPath);
  if (config?.imports && config.imports.length > 0) {
    const token = await getGitHubToken();
    for (const entry of config.imports) {
      const { owner, repo: repoName } = parseGitHubSource(entry.source);
      const sha = await resolveRef(owner, repoName, entry.ref, token);
      const cachedPath = await ensureCached(owner, repoName, sha, token);
      repo = await mergeImport(repo, entry, cachedPath);
    }
  }

  assertNoCaseInsensitiveCollisions(
    [
      ...(repo.root ? ['AGENTS.md'] : []),
      ...(repo.permissions ? ['permissions.yaml'] : []),
      ...repo.skills.map((skill) => skill.directoryRelativePath),
      ...repo.skills.flatMap((skill) => skill.files.map((file) => file.relativePath)),
      ...repo.subagents.map((agent) => agent.relativePath),
    ],
    agentsRoot,
  );

  repo.skills.sort((a, b) => a.directoryRelativePath.localeCompare(b.directoryRelativePath));
  repo.subagents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return repo;
}

async function loadDocumentDirectory<TFrontmatter>(
  repoRoot: string,
  directory: string,
  schema: { parse: (input: unknown) => TFrontmatter },
): Promise<Array<SourceDocument<TFrontmatter>>> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const files = await findMarkdownFiles(directory);
  const documents = await Promise.all(files.map((file) => loadMarkdownDocument(repoRoot, file, schema)));
  return documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function loadMarkdownDocument<TFrontmatter>(
  repoRoot: string,
  filePath: string,
  schema: { parse: (input: unknown) => TFrontmatter },
): Promise<SourceDocument<TFrontmatter>> {
  const content = await readUtf8File(filePath);
  const parsed = parseFrontmatterDocument(content, filePath);

  try {
    return {
      sourcePath: filePath,
      relativePath: toRepoRelative(repoRoot, filePath),
      body: parsed.body.trimEnd(),
      frontmatter: parseWithSchema(schema, parsed.data, filePath),
    };
  } catch (error) {
    if (error instanceof ChalkBagError) {
      throw error;
    }

    throw new ChalkBagError({
      kind: 'config',
      file: filePath,
      message: error instanceof Error ? error.message : 'schema validation failed',
      cause: error,
    });
  }
}

async function assertFileExists(filePath: string, message: string): Promise<void> {
  if (!(await pathExists(filePath))) {
    throw new ChalkBagError({
      kind: 'config',
      file: filePath,
      message,
      fix: 'ensure the file exists and the .chalk/ directory is properly scaffolded',
    });
  }
}

async function assertPathMissing(targetPath: string, message: string): Promise<void> {
  if (await pathExists(targetPath)) {
    throw new ChalkBagError({
      kind: 'config',
      file: targetPath,
      message,
      fix: 'remove the unsupported path or migrate its contents to the correct location',
    });
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    return true;
  }
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readDirectory(root);
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

async function loadSkillDirectory(repoRoot: string, directory: string): Promise<LoadedSkill[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const entries = await readDirectory(directory);
  const skills: LoadedSkill[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDirectoryPath = path.join(directory, entry.name);
    const entrypointPath = path.join(skillDirectoryPath, 'SKILL.md');
    await assertFileExists(entrypointPath, 'skill directory must contain SKILL.md');

    const files = await findAllFiles(skillDirectoryPath);
    skills.push({
      directoryPath: skillDirectoryPath,
      directoryRelativePath: toRepoRelative(repoRoot, skillDirectoryPath),
      entrypoint: await loadMarkdownDocument(repoRoot, entrypointPath, skillFrontmatterSchema),
      files: await Promise.all(
        files.map(async (filePath) => ({
          sourcePath: filePath,
          relativePath: toRepoRelative(repoRoot, filePath),
          content: await readUtf8File(filePath),
        })),
      ),
    });
  }

  return skills;
}

async function findAllFiles(root: string): Promise<string[]> {
  const entries = await readDirectory(root);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findAllFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function readUtf8File(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    throw new ChalkBagError({
      kind: 'io',
      file: filePath,
      message: 'failed to read .chalk file',
      cause: error,
      fix: 'ensure the file is readable and not corrupted',
    });
  }
}

async function readDirectory(directory: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new ChalkBagError({
      kind: 'io',
      file: directory,
      message: 'failed to scan .chalk markdown files',
      cause: error,
      fix: 'ensure the directory exists and is readable',
    });
  }
}

function assertNoCaseInsensitiveCollisions(paths: string[], agentsRoot: string): void {
  const seen = new Map<string, string>();

  for (const relativePath of paths) {
    const key = relativePath.toLowerCase();
    const existing = seen.get(key);
    if (existing && existing !== relativePath) {
      throw new ChalkBagError({
        kind: 'config',
        file: agentsRoot,
        message: `case-insensitive filename collision: ${existing} vs ${relativePath}`,
        fix: 'rename one of the colliding files to have a unique name',
      });
    }
    seen.set(key, relativePath);
  }
}

function toRepoRelative(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

async function maybeLoadPermissions(permissionsPath: string): Promise<PermissionsConfig | null> {
  try {
    if (!(await pathExists(permissionsPath))) {
      return null;
    }
  } catch {
    return null;
  }

  const raw = await readUtf8File(permissionsPath);
  return parseWithSchema(permissionsConfigSchema, parseYamlDocument(raw, permissionsPath), permissionsPath);
}

async function maybeLoadConfig(configPath: string): Promise<AgentsConfig | null> {
  try {
    if (!(await pathExists(configPath))) {
      return null;
    }
  } catch {
    return null;
  }

  const raw = await readUtf8File(configPath);
  return parseWithSchema(agentsConfigSchema, parseYamlDocument(raw, configPath), configPath);
}

function parseWithSchema<T>(schema: { parse: (input: unknown) => T }, input: unknown, filePath: string): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const hint = issue?.path[0] === 'paths' ? ' (use block list syntax: paths: then one - entry per glob)' : '';
      throw new ChalkBagError({
        kind: 'config',
        file: filePath,
        message: `${issue?.message ?? 'schema validation failed'}${hint}`,
        cause: error,
        fix: 'check the schema documentation and correct the invalid fields',
      });
    }

    throw error;
  }
}
