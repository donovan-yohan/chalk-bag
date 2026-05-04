import fs from 'node:fs';
import path from 'node:path';

import { getRegistrationForRepo, isHeartbeatStale } from './daemon/registry.js';
import { ensureGitignoreEntries } from './gitignore.js';
import { installGitHooks } from './hooks.js';
import { hashContent, readAgentsState, writeAgentsState } from './manifest.js';
import { firstPartyProviderRegistry, getFirstPartyProvider, providerIds } from './providers/registry.js';
import { resolveAgentsScope } from './scope.js';
import { loadAgentsRepo } from './spec/load.js';
import type { AgentsScope } from './scope.js';
import type { ProviderId } from './spec/types.js';
import type { GeneratedOutput } from './providers/_plugin.js';
import { ChalkBagError } from './types.js';

export type BuildAgentsOptions = {
  force?: boolean;
  providers?: ProviderId[];
  yes?: boolean;
  persistState?: boolean;
};

export type BuildAgentsResult = {
  warnings: string[];
  wroteGitignore: boolean;
};

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 50;

export async function buildAgentsRepo(
  scopeOrRoot: AgentsScope | string,
  options: BuildAgentsOptions = {},
): Promise<BuildAgentsResult> {
  // ENOENT log-and-drop: if sourceRoot doesn't exist, return gracefully (eng H-2)
  if (typeof scopeOrRoot === 'string') {
    try {
      await fs.promises.access(scopeOrRoot);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return {
          warnings: [`chalkbag: source root ${scopeOrRoot} no longer exists; skipping build`],
          wroteGitignore: false,
        };
      }
    }
  }

  const scope = await normalizeScope(scopeOrRoot);

  const releaseLock = await acquireRenderLock(scope.sourceRoot, '.chalk');

  try {
    const repo = await loadAgentsRepo(scope);
    const previousState = await readAgentsState(scope.sourceRoot, { stateDirectory: '.chalk' });
    const enabledProviders = determineProviders(previousState.lastFlags, options.providers);
    await assertBuildAllowed(scope, Boolean(options.force));
    const wroteGitignore = options.yes ? await ensureGitignoreEntries(scope.sourceRoot) : false;
    if (options.yes) {
      await installGitHooks(scope.sourceRoot);
    }

    const warnings: string[] = [];
    const outputs = renderOutputs(repo, enabledProviders, {
      onWarning: (message) => warnings.push(message),
    });
    const applyResult = await applyOutputs(scope.outputRoot, outputs, previousState.manifest);
    warnings.push(...applyResult.warnings);

    if (options.persistState !== false) {
      await writeAgentsState(
        scope.sourceRoot,
        {
          lastFlags: enabledProviders,
          manifest: applyResult.manifest,
          lastRenderAt: new Date().toISOString(),
          lastBuildAt: new Date().toISOString(),
          daemonVersion: 'phase-2',
        },
        { stateDirectory: '.chalk' },
      );
    }

    return {
      warnings,
      wroteGitignore,
    };
  } finally {
    await releaseLock();
  }
}

async function normalizeScope(scopeOrRoot: AgentsScope | string): Promise<AgentsScope> {
  if (typeof scopeOrRoot === 'string') {
    return resolveAgentsScope(scopeOrRoot);
  }

  return scopeOrRoot;
}

async function assertBuildAllowed(scope: AgentsScope, force: boolean): Promise<void> {
  if (force) {
    return;
  }

  const registration = await getRegistrationForRepo(scope.sourceRoot);
  if (!registration) {
    // No registry entry — skip heartbeat check
    return;
  }

  if (await isHeartbeatStale()) {
    throw new ChalkBagError({
      kind: 'daemon',
      file: scope.sourceRoot,
      message: 'daemon heartbeat stale; the daemon may have stopped',
      fix: 'run `chalkbag daemon reload` or rerun with --force',
    });
  }
}

function determineProviders(
  lastFlags: ProviderId[],
  explicit: ProviderId[] | undefined,
): ProviderId[] {
  if (explicit && explicit.length > 0) {
    return [...new Set(explicit)].sort();
  }

  if (lastFlags.length > 0) {
    return [...new Set(lastFlags)].sort();
  }

  return [...providerIds];
}

function renderOutputs(
  repo: Awaited<ReturnType<typeof loadAgentsRepo>>,
  enabledProviders: ProviderId[],
  options: {
    onWarning: (warning: string) => void;
  },
): GeneratedOutput[] {
  const rendered = new Map<string, GeneratedOutput>();
  const enabledProviderSet = new Set(enabledProviders);
  const missingProviders = enabledProviders.filter((providerId) => getFirstPartyProvider(providerId) === undefined);

  if (missingProviders.length > 0) {
    throw new ChalkBagError({
      kind: 'provider',
      file: missingProviders[0],
      message: `no registered implementation for enabled provider(s): ${missingProviders.join(', ')}. Valid providers: ${providerIds.join(', ')}`,
      fix: 'check the provider IDs in .chalk/providers.yaml — valid values are: ' + providerIds.join(', '),
    });
  }

  // Only emit root AGENTS.md/CLAUDE.md when the root came from an import.
  // If root is a local tracked file, it is already correct on disk — writing
  // a generated banner back to it would make every build modify the source-of-truth.
  if (repo.root && repo.root.relativePath.startsWith('imports:')) {
    rendered.set('AGENTS.md', {
      kind: 'file',
      path: 'AGENTS.md',
      content: renderInstructionMarkdown(repo.root.body, repo.root.relativePath),
      sourcePath: repo.root.relativePath,
    });

    if (enabledProviders.includes('claude')) {
      rendered.set('CLAUDE.md', {
        kind: 'symlink',
        path: 'CLAUDE.md',
        target: 'AGENTS.md',
        sourcePath: repo.root.relativePath,
      });
    }
  }

  // Always-on .agents/ output for AGENTS.md-spec readers that auto-discover
  // skills via hierarchical scan (Codex CLI today; future Cursor/Gemini/etc.
  // adopting the spec land here too). Independent of which providers are
  // enabled — the spec's discovery is its own contract, not Codex-specific.
  // Reference: https://developers.openai.com/codex/skills#where-to-save-skills
  for (const output of renderSharedAgentsMdMirror(repo)) {
    rendered.set(output.path, output);
  }

  for (const provider of firstPartyProviderRegistry) {
    if (!enabledProviderSet.has(provider.id)) {
      continue;
    }

    const files = provider.render({
      repo,
      enabledProviders,
      reportWarning: (warning) => options.onWarning(`${provider.id}: ${warning}`),
    });

    for (const file of files) {
      const normalized = {
        ...file,
        ...(file.kind === 'file' ? { content: normalizeContent(file.content) } : {}),
      };

      const existing = rendered.get(normalized.path);
      if (existing && !generatedOutputsEqual(existing, normalized)) {
        throw new ChalkBagError({
          kind: 'provider',
          file: normalized.path,
          message: `conflicting output for ${normalized.path}`,
          fix: 'check that multiple providers are not emitting the same output path',
        });
      }
      rendered.set(normalized.path, normalized);
    }
  }

  return [...rendered.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function applyOutputs(
  outputRoot: string,
  outputs: GeneratedOutput[],
  previousManifest: Record<string, { hash: string; sourcePath: string }>,
): Promise<{ manifest: Record<string, { hash: string; sourcePath: string }>; warnings: string[] }> {
  const warnings: string[] = [];
  const outputMap = new Map(outputs.map((output) => [output.path, output]));
  const tempRoot = path.join(outputRoot, '.chalk-tmp', `${process.pid}`);

  await fs.promises.rm(tempRoot, { recursive: true, force: true });

  for (const output of outputs) {
    const destinationPath = resolveOutputPath(outputRoot, output.path);
    const destinationDir = path.dirname(destinationPath);
    const tempPath = path.join(tempRoot, ...output.path.split('/'));

    const onDisk = await readOutputIfExists(destinationPath, output.path);
    const previous = previousManifest[output.path];
    if (
      previous &&
      onDisk !== null &&
      hashRenderedOutput(onDisk) !== previous.hash &&
      hashRenderedOutput(onDisk) !== hashRenderedOutput(output)
    ) {
      warnings.push(`chalkbag: ${output.path} was edited outside .chalk — overwriting.`);
    }

    await fs.promises.mkdir(destinationDir, { recursive: true });
    await fs.promises.rm(destinationPath, { force: true, recursive: true });

    if (output.kind === 'file') {
      await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
      await fs.promises.writeFile(tempPath, output.content, 'utf8');
      await fs.promises.rename(tempPath, destinationPath);
    } else {
      await fs.promises.symlink(output.target, destinationPath);
    }
  }

  for (const relativePath of Object.keys(previousManifest)) {
    if (outputMap.has(relativePath)) {
      continue;
    }

    await fs.promises.rm(resolveOutputPath(outputRoot, relativePath), { force: true, recursive: true });
    delete previousManifest[relativePath];
  }

  await fs.promises.rm(tempRoot, { recursive: true, force: true });

  return {
    manifest: Object.fromEntries(outputs.map((output) => [output.path, { hash: hashRenderedOutput(output), sourcePath: output.sourcePath }])),
    warnings,
  };
}

async function acquireRenderLock(repoRoot: string, stateDirectory: string): Promise<() => Promise<void>> {
  const lockPath = path.join(repoRoot, stateDirectory, '.state.lock');
  const startedAt = Date.now();

  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await fs.promises.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!isLockContentionError(error)) {
        throw new ChalkBagError({
          kind: 'io',
          file: lockPath,
          message: 'failed to acquire render lock',
          cause: error,
          fix: 'ensure no other chalkbag process is holding the lock, or delete .chalk/.state.lock manually',
        });
      }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new ChalkBagError({
          kind: 'lock',
          file: lockPath,
          message: `timed out waiting for render lock after ${LOCK_TIMEOUT_MS}ms`,
          cause: error,
          fix: 'another process may be stuck; delete .chalk/.state.lock manually and retry',
        });
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

function normalizeContent(content: string): string {
  return `${content.replace(/\r\n/g, '\n').replace(/\n*$/u, '')}\n`;
}

// Mirror merged skills into .agents/skills/<name>/ so AGENTS.md-spec readers
// (Codex hierarchical scan and any other tool following the spec) discover
// them without per-provider rendering. The shape mirrors the source skill
// folder verbatim — SKILL.md plus any bundled references/, scripts/, assets/.
function renderSharedAgentsMdMirror(
  repo: Awaited<ReturnType<typeof loadAgentsRepo>>,
): GeneratedOutput[] {
  const outputs: GeneratedOutput[] = [];

  for (const skill of repo.skills) {
    const skillName = path.basename(skill.directoryPath);
    for (const file of skill.files) {
      const relativeToSkill = path.relative(skill.directoryPath, file.sourcePath).split(path.sep).join('/');
      outputs.push({
        kind: 'file',
        path: `.agents/skills/${skillName}/${relativeToSkill}`,
        content: file.content,
        sourcePath: file.relativePath,
      });
    }
  }

  return outputs;
}

function renderInstructionMarkdown(body: string, sourcePath: string): string {
  const banner = `> Do not edit inline. Edit \`${sourcePath}\` to persist changes.`;
  const normalizedBody = body.replace(/\r\n/g, '\n').trim();
  return `${banner}\n\n${normalizedBody}\n`;
}

function resolveOutputPath(repoRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new ChalkBagError({
      kind: 'config',
      file: relativePath,
      message: `generated path ${relativePath} points outside the repo root`,
      fix: 'provider output paths must be relative — check the provider configuration',
    });
  }

  const resolvedPath = path.resolve(repoRoot, ...relativePath.split('/'));
  const relativeToRoot = path.relative(repoRoot, resolvedPath);

  if (relativeToRoot === '' || relativeToRoot === '.' || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new ChalkBagError({
      kind: 'config',
      file: relativePath,
      message: `generated path ${relativePath} points outside the repo root`,
      fix: 'provider output paths must stay within the repo root — check for path traversal in provider output',
    });
  }

  return resolvedPath;
}

async function readOutputIfExists(filePath: string, relativePath: string): Promise<GeneratedOutput | null> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (stat.isSymbolicLink()) {
      return {
        kind: 'symlink',
        path: relativePath,
        target: await fs.promises.readlink(filePath),
        sourcePath: relativePath,
      };
    }

    return {
      kind: 'file',
      path: relativePath,
      content: await fs.promises.readFile(filePath, 'utf8'),
      sourcePath: relativePath,
    };
  } catch {
    return null;
  }
}

function hashRenderedOutput(output: GeneratedOutput): string {
  return output.kind === 'file'
    ? hashContent(output.content)
    : hashContent(`symlink:${output.target}`);
}

function generatedOutputsEqual(left: GeneratedOutput, right: GeneratedOutput): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === 'file' && right.kind === 'file') {
    return left.content === right.content;
  }

  return left.kind === 'symlink' && right.kind === 'symlink' && left.target === right.target;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isLockContentionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
