import fs from 'node:fs';
import path from 'node:path';

import { renderAgentsMdStub } from './commands/scaffold.js';
import { readAgentsState, writeAgentsState } from './manifest.js';
import {
  CHALKBAG_MANAGED_MARKERS,
  hasManagedBlock,
  removeManagedBlock,
  upsertManagedBlock,
} from './managed-block.js';
import { buildClaudePermissions } from './providers/claude.js';
import { buildCodexConfig } from './providers/codex.js';
import { renderProvidersConfig } from './providers/registry.js';
import type { ProviderId } from './providers/registry.js';
import type { GeneratedOutput } from './providers/_plugin.js';
import { acquireRenderLock, applyOutputs, renderSharedAgentsMdMirror } from './render.js';
import { getUserHome, resolveGlobalScope } from './scope.js';
import type { AgentsScope } from './scope.js';
import { loadAgentsRepo } from './spec/load.js';
import type { LoadedAgentsRepo } from './spec/load.js';
import { ChalkBagError } from './types.js';

// The managed context file the bridge symlinks point at.
const GLOBAL_CONTEXT_FILE = 'AGENTS.md';

// Bridge symlink locations (relative to the home dir / outputRoot).
const CLAUDE_BRIDGE = ['.claude', 'CLAUDE.md'] as const;
const CODEX_BRIDGE = ['.codex', 'AGENTS.md'] as const;

const CODEX_CONFIG = ['.codex', 'config.toml'] as const;
const CLAUDE_SETTINGS = ['.claude', 'settings.json'] as const;

export type GlobalProviderSelection = { claude: boolean; codex: boolean };

export type GlobalScaffoldResult = {
  home: string;
  agentsRoot: string;
  created: string[];
  skipped: string[];
};

export type GlobalBuildOptions = {
  providers?: ProviderId[];
  persistState?: boolean;
};

export type GlobalBuildResult = {
  scope: AgentsScope;
  warnings: string[];
  linked: string[];
};

export type GlobalCleanResult = {
  home: string;
  removed: string[];
  preserved: string[];
};

// ---------------------------------------------------------------------------
// scaffold
// ---------------------------------------------------------------------------

/**
 * Scaffolds the machine-level `~/.chalk/` source tree: `providers.yaml`
 * (claude + codex), a `skills/` directory, and a map-style `AGENTS.md`
 * context file. Idempotent — existing files are left untouched. Permissions
 * are intentionally opt-in (no `permissions.yaml` is written), so a first
 * `--global` build never rewrites the user's real Claude/Codex config until
 * they add one.
 */
export async function scaffoldGlobal(homeDir: string = getUserHome()): Promise<GlobalScaffoldResult> {
  const scope = resolveGlobalScope(homeDir);
  const created: string[] = [];
  const skipped: string[] = [];

  await fs.promises.mkdir(scope.agentsRoot, { recursive: true });

  const providersPath = path.join(scope.agentsRoot, 'providers.yaml');
  await writeIfAbsent(
    providersPath,
    renderProvidersConfig({ claude: true, codex: true, opencode: false }),
    'providers.yaml',
    created,
    skipped,
  );

  const skillsDir = path.join(scope.agentsRoot, 'skills');
  if (await pathExists(skillsDir)) {
    skipped.push('skills/');
  } else {
    await fs.promises.mkdir(skillsDir, { recursive: true });
    created.push('skills/');
  }

  const readmePath = path.join(scope.agentsRoot, 'README.md');
  await writeIfAbsent(readmePath, renderGlobalReadme(), 'README.md', created, skipped);

  const agentsMdPath = path.join(scope.agentsRoot, GLOBAL_CONTEXT_FILE);
  await writeIfAbsent(
    agentsMdPath,
    renderAgentsMdStub('Machine-level agent guidance', { global: true }),
    'AGENTS.md',
    created,
    skipped,
  );

  return { home: scope.sourceRoot, agentsRoot: scope.agentsRoot, created, skipped };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

/**
 * Compiles `~/.chalk/` into user-level Claude and Codex config:
 *   - skills → `~/.claude/skills/` (Claude) and `~/.agents/skills/` (the
 *     Codex / AGENTS.md-spec user-level skill dir)
 *   - permissions → merged `~/.claude/settings.json` and a managed block in
 *     `~/.codex/config.toml`
 *   - the context file → bridge symlinks `~/.claude/CLAUDE.md` and
 *     `~/.codex/AGENTS.md` pointing at `~/.chalk/AGENTS.md`
 *
 * Skill outputs are manifest-tracked so only files chalkbag itself wrote are
 * ever overwritten or reaped. The user's real config files are never rewritten
 * wholesale.
 */
export async function buildGlobalScope(options: GlobalBuildOptions = {}): Promise<GlobalBuildResult> {
  const scope = resolveGlobalScope();

  if (!(await pathExists(scope.agentsRoot))) {
    throw new ChalkBagError({
      kind: 'config',
      file: scope.agentsRoot,
      message: 'no machine-level ~/.chalk/ source tree found',
      fix: 'run `chalkbag init --global` to scaffold ~/.chalk/ first',
    });
  }

  const release = await acquireRenderLock(scope.sourceRoot, '.chalk');
  try {
    const repo = await loadAgentsRepo(scope);
    const previousState = await readAgentsState(scope.sourceRoot, { stateDirectory: '.chalk' });

    const selection = determineGlobalProviders(repo, options.providers);
    const warnings: string[] = [...selection.warnings];
    const linked: string[] = [];

    // 1. Skill projection (manifest-tracked, collision-safe).
    const skillOutputs = renderGlobalSkillOutputs(repo, selection.providers);
    const applyResult = await applyOutputs(scope.outputRoot, skillOutputs, previousState.manifest);
    warnings.push(...applyResult.warnings);

    // 2. Permissions — only when the user opted into a global permissions.yaml.
    if (repo.permissions) {
      if (selection.providers.claude) {
        await writeClaudeSettings(scope, repo);
      }
      if (selection.providers.codex) {
        await writeCodexManagedBlock(scope, repo, (w) => warnings.push(`codex: ${w}`));
      }
    }

    // 3. Context-file bridge symlinks.
    const bridge = await bridgeContextFiles(scope, selection.providers);
    linked.push(...bridge.linked);

    // 4. Persist manifest state (tracks skill outputs only).
    if (options.persistState !== false) {
      await writeAgentsState(
        scope.sourceRoot,
        {
          lastFlags: providerFlags(selection.providers),
          manifest: applyResult.manifest,
          lastRenderAt: new Date().toISOString(),
          lastBuildAt: new Date().toISOString(),
          daemonVersion: 'global',
        },
        { stateDirectory: '.chalk' },
      );
    }

    if (bridge.conflicts.length > 0) {
      throw new ChalkBagError({
        kind: 'config',
        file: path.join(scope.agentsRoot, GLOBAL_CONTEXT_FILE),
        message: `cannot bridge context file(s): ${bridge.conflicts.map((c) => c.message).join('; ')}`,
        fix: `merge the existing content into ${path.join(scope.agentsRoot, GLOBAL_CONTEXT_FILE)}, remove or rename the conflicting file, then re-run \`chalkbag build --global\``,
      });
    }

    return { scope, warnings, linked };
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/**
 * Validates the machine-level `~/.chalk/` source tree against the schema
 * without writing any outputs. Throws when `~/.chalk/` is missing or invalid.
 */
export async function validateGlobalScope(homeDir: string = getUserHome()): Promise<void> {
  const scope = resolveGlobalScope(homeDir);
  if (!(await pathExists(scope.agentsRoot))) {
    throw new ChalkBagError({
      kind: 'config',
      file: scope.agentsRoot,
      message: 'no machine-level ~/.chalk/ source tree found',
      fix: 'run `chalkbag init --global` to scaffold ~/.chalk/ first',
    });
  }
  await loadAgentsRepo(scope);
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

/**
 * Removes only chalkbag-written global outputs. The user's own config files
 * are preserved: `~/.claude/settings.json` is left in place, and only the
 * managed block is stripped from `~/.codex/config.toml`. Bridge symlinks are
 * removed only when they still point at `~/.chalk/AGENTS.md`.
 */
export async function cleanGlobalScope(homeDir: string = getUserHome()): Promise<GlobalCleanResult> {
  const scope = resolveGlobalScope(homeDir);
  const removed: string[] = [];
  const preserved: string[] = [];

  const hasAgentsRoot = await pathExists(scope.agentsRoot);
  const release = hasAgentsRoot ? await acquireRenderLock(scope.sourceRoot, '.chalk') : null;

  try {
    // 1. Reap manifest-tracked skill outputs (empty output set removes them all).
    //    Snapshot the keys first — applyOutputs mutates the manifest it is given
    //    (deleting reaped entries), so read them before the call.
    const previousState = await readAgentsState(scope.sourceRoot, { stateDirectory: '.chalk' });
    const trackedOutputs = Object.keys(previousState.manifest);
    if (trackedOutputs.length > 0) {
      await applyOutputs(scope.outputRoot, [], previousState.manifest);
      removed.push(...trackedOutputs);
    }

    // 2. Strip the codex managed block, preserving the rest of the file.
    const codexPath = path.join(scope.outputRoot, ...CODEX_CONFIG);
    const codexExisting = await readFileOrNull(codexPath);
    if (codexExisting !== null && hasManagedBlock(codexExisting, CHALKBAG_MANAGED_MARKERS, codexPath)) {
      const next = removeManagedBlock(codexExisting, CHALKBAG_MANAGED_MARKERS, codexPath);
      if (next.trim().length === 0) {
        await fs.promises.rm(codexPath, { force: true });
      } else {
        await fs.promises.writeFile(codexPath, next, 'utf8');
      }
      removed.push(path.join('.codex', 'config.toml') + ' (managed block)');
    }

    // 3. Remove bridge symlinks only when they still point at ~/.chalk/AGENTS.md.
    const target = path.join(scope.agentsRoot, GLOBAL_CONTEXT_FILE);
    for (const parts of [CLAUDE_BRIDGE, CODEX_BRIDGE]) {
      const linkPath = path.join(scope.outputRoot, ...parts);
      if (await symlinkPointsAt(linkPath, target)) {
        await fs.promises.rm(linkPath, { force: true });
        removed.push(path.join(...parts));
      }
    }

    // 4. Never delete the user's own settings.json.
    const settingsPath = path.join(scope.outputRoot, ...CLAUDE_SETTINGS);
    if (await pathExists(settingsPath)) {
      preserved.push(path.join(...CLAUDE_SETTINGS));
    }

    // 5. Reset the manifest so a subsequent build starts clean.
    if (hasAgentsRoot) {
      await writeAgentsState(
        scope.sourceRoot,
        { lastFlags: previousState.lastFlags, manifest: {}, lastBuildAt: new Date().toISOString(), daemonVersion: 'global' },
        { stateDirectory: '.chalk' },
      );
    }

    return { home: scope.sourceRoot, removed, preserved };
  } finally {
    if (release) {
      await release();
    }
  }
}

// ---------------------------------------------------------------------------
// provider selection
// ---------------------------------------------------------------------------

function determineGlobalProviders(
  repo: LoadedAgentsRepo,
  explicit: ProviderId[] | undefined,
): { providers: GlobalProviderSelection; warnings: string[] } {
  const warnings: string[] = [];

  if (explicit && explicit.length > 0) {
    const set = new Set(explicit);
    if (set.has('opencode')) {
      warnings.push('global scope supports only claude and codex; ignoring requested provider opencode');
    }
    return { providers: { claude: set.has('claude'), codex: set.has('codex') }, warnings };
  }

  const configured = repo.providers.providers;
  if (configured.opencode?.enabled) {
    warnings.push('global scope supports only claude and codex; opencode entry in providers.yaml is ignored');
  }
  return {
    providers: {
      claude: configured.claude?.enabled ?? true,
      codex: configured.codex?.enabled ?? true,
    },
    warnings,
  };
}

function providerFlags(selection: GlobalProviderSelection): ProviderId[] {
  const flags: ProviderId[] = [];
  if (selection.claude) flags.push('claude');
  if (selection.codex) flags.push('codex');
  return flags;
}

// ---------------------------------------------------------------------------
// skill projection
// ---------------------------------------------------------------------------

function renderGlobalSkillOutputs(repo: LoadedAgentsRepo, providers: GlobalProviderSelection): GeneratedOutput[] {
  const outputs: GeneratedOutput[] = [];

  // Codex / AGENTS.md-spec user-level skills: ~/.agents/skills/ (see report
  // for the sourced location decision). Reuses the exact repo-scope mirror.
  if (providers.codex) {
    outputs.push(...renderSharedAgentsMdMirror(repo));
  }

  // Claude user-level skills: ~/.claude/skills/
  if (providers.claude) {
    for (const skill of repo.skills) {
      if (!supportsProvider(skill.entrypoint.frontmatter.targets, 'claude')) {
        continue;
      }
      for (const file of skill.files) {
        const relativeToSkill = path.relative(skill.directoryPath, file.sourcePath).split(path.sep).join('/');
        outputs.push({
          kind: 'file',
          path: `.claude/skills/${path.basename(skill.directoryPath)}/${relativeToSkill}`,
          content: file.content,
          sourcePath: file.relativePath,
        });
      }
    }
  }

  return outputs;
}

function supportsProvider(targets: string[] | undefined, providerId: string): boolean {
  return targets === undefined ? true : targets.includes(providerId);
}

// ---------------------------------------------------------------------------
// permissions writers
// ---------------------------------------------------------------------------

async function writeClaudeSettings(scope: AgentsScope, repo: LoadedAgentsRepo): Promise<boolean> {
  // buildClaudePermissions reads and merges the existing settings.json at
  // scope.outputRoot (~/.claude/settings.json). `unionExistingArrays` keeps the
  // user's own allow/deny/ask entries — global settings.json is the user's real
  // file, so chalkbag must never drop content it did not author.
  const content = buildClaudePermissions(repo, { unionExistingArrays: true });
  if (content === null) {
    return false;
  }
  const destination = path.join(scope.outputRoot, ...CLAUDE_SETTINGS);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.writeFile(destination, content, 'utf8');
  return true;
}

async function writeCodexManagedBlock(
  scope: AgentsScope,
  repo: LoadedAgentsRepo,
  reportWarning: (warning: string) => void,
): Promise<void> {
  const perms = repo.permissions;
  if (perms?.bash?.allow?.length || perms?.bash?.ask?.length || perms?.bash?.deny?.length) {
    reportWarning('bash command rules are not emitted to the global ~/.codex/config.toml managed block');
  }
  if (perms?.mcp?.allow || perms?.mcp?.deny) {
    reportWarning('codex does not support mcp permission rules; dropped from output');
  }

  const body = buildCodexConfig(repo, reportWarning, { includeProjectTrust: false }).join('\n');
  const configPath = path.join(scope.outputRoot, ...CODEX_CONFIG);
  const existing = (await readFileOrNull(configPath)) ?? '';
  const next = upsertManagedBlock(existing, body, CHALKBAG_MANAGED_MARKERS, configPath);

  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, next, 'utf8');
}

// ---------------------------------------------------------------------------
// context-file bridging
// ---------------------------------------------------------------------------

type BridgeConflict = { link: string; message: string };

async function bridgeContextFiles(
  scope: AgentsScope,
  providers: GlobalProviderSelection,
): Promise<{ linked: string[]; conflicts: BridgeConflict[] }> {
  const target = path.join(scope.agentsRoot, GLOBAL_CONTEXT_FILE);
  const linked: string[] = [];
  const conflicts: BridgeConflict[] = [];

  if (!(await pathExists(target))) {
    // No context file to point at — skip bridging rather than create a
    // dangling symlink.
    return { linked, conflicts };
  }

  const links: Array<{ label: string; parts: readonly string[] }> = [];
  if (providers.claude) links.push({ label: '~/.claude/CLAUDE.md', parts: CLAUDE_BRIDGE });
  if (providers.codex) links.push({ label: '~/.codex/AGENTS.md', parts: CODEX_BRIDGE });

  for (const { label, parts } of links) {
    const linkPath = path.join(scope.outputRoot, ...parts);
    const result = await bridgeOne(linkPath, target, label);
    if (result.kind === 'linked') {
      linked.push(path.join(...parts));
    } else if (result.kind === 'conflict') {
      conflicts.push({ link: label, message: result.message });
    }
  }

  return { linked, conflicts };
}

async function bridgeOne(
  linkPath: string,
  target: string,
  label: string,
): Promise<{ kind: 'linked' | 'ok' } | { kind: 'conflict'; message: string }> {
  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });

  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(linkPath);
  } catch (error) {
    if (isEnoent(error)) {
      await fs.promises.symlink(target, linkPath);
      return { kind: 'linked' };
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    const current = await fs.promises.readlink(linkPath);
    const resolved = path.resolve(path.dirname(linkPath), current);
    if (resolved === target) {
      // Already the chalkbag bridge link — idempotent no-op.
      return { kind: 'ok' };
    }
    // A symlink pointing anywhere other than ~/.chalk/AGENTS.md is NOT chalkbag's
    // to silently repoint. It may be a user-managed link into another context
    // file, or a dangling link hiding a typo. Refuse and let the user resolve it.
    if (await pathExists(resolved)) {
      return {
        kind: 'conflict',
        message: `${label} is a symlink already pointing at ${resolved}; merge or remove it yourself, then re-run`,
      };
    }
    return {
      kind: 'conflict',
      message: `${label} is a dangling symlink pointing at ${resolved}; remove or repoint it yourself, then re-run`,
    };
  }

  if (stat.isFile()) {
    const content = await fs.promises.readFile(linkPath, 'utf8');
    if (content.trim().length === 0) {
      await fs.promises.rm(linkPath, { force: true });
      await fs.promises.symlink(target, linkPath);
      return { kind: 'linked' };
    }
    return {
      kind: 'conflict',
      message: `${label} already exists as a regular file with content`,
    };
  }

  return { kind: 'conflict', message: `${label} exists and is not a chalkbag-managed symlink` };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function symlinkPointsAt(linkPath: string, target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    const current = await fs.promises.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), current) === target;
  } catch {
    return false;
  }
}

async function writeIfAbsent(
  filePath: string,
  content: string,
  label: string,
  created: string[],
  skipped: string[],
): Promise<void> {
  if (await pathExists(filePath)) {
    skipped.push(label);
    return;
  }
  await fs.promises.writeFile(filePath, content, 'utf8');
  created.push(label);
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function renderGlobalReadme(): string {
  return `# ~/.chalk (machine-level chalkbag source)

This is the source of truth for your machine-wide agent config. \`chalkbag build --global\`
compiles it into user-level Claude and Codex config:

- \`AGENTS.md\` — machine-level context, bridged to \`~/.claude/CLAUDE.md\` and \`~/.codex/AGENTS.md\`.
- \`skills/\` — machine-wide skills, projected into \`~/.claude/skills/\` and \`~/.agents/skills/\`.
- \`providers.yaml\` — which of claude/codex are enabled globally.
- \`permissions.yaml\` (optional) — merged into \`~/.claude/settings.json\` and a managed block in \`~/.codex/config.toml\`.

Repo-level \`.chalk/\` always overrides this for work inside that repo.
`;
}
