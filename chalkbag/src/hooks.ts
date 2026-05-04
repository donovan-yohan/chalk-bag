import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// TODO(Phase 2/3): import { getRepoRegistration, isHeartbeatStale } from './daemon/registry.js';
// TODO(Phase 2): import { buildAgentsRepo } from './render.js';
import { readAgentsState } from './manifest.js';

const HOOK_NAMES = ['pre-commit', 'post-checkout', 'post-merge'] as const;
const MARKER = '# chalkbag hook';

export async function installGitHooks(repoRoot: string): Promise<void> {
  const hooksRoot = await resolveGitHooksRoot(repoRoot);
  if (!hooksRoot) {
    return;
  }

  await fs.promises.mkdir(hooksRoot, { recursive: true });

  for (const hookName of HOOK_NAMES) {
    const hookPath = path.join(hooksRoot, hookName);
    const existing = await readFileIfExists(hookPath);

    if (existing.includes(MARKER)) {
      continue;
    }

    const nextContent = existing.trim().length === 0
      ? buildStandaloneHookBlock()
      : `${existing.replace(/\s*$/u, '\n')}\n${buildAppendedHookBlock()}\n`;

    await fs.promises.writeFile(hookPath, nextContent, { encoding: 'utf8', mode: 0o755 });
  }
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function resolveGitHooksRoot(repoRoot: string): Promise<string | null> {
  try {
    const resolved = execFileSync(
      'git',
      ['-C', repoRoot, 'rev-parse', '--git-path', 'hooks'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();

    if (resolved.length > 0) {
      return path.isAbsolute(resolved) ? resolved : path.resolve(repoRoot, resolved);
    }
  } catch {
  }

  const gitPath = path.join(repoRoot, '.git');

  try {
    const stat = await fs.promises.stat(gitPath);

    if (stat.isDirectory()) {
      return path.join(gitPath, 'hooks');
    }

    const pointer = await fs.promises.readFile(gitPath, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+)\s*$/mu);
    if (!match) {
      return path.join(repoRoot, '.git', 'hooks');
    }

    const gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(repoRoot, match[1]);
    return path.join(gitDir, 'hooks');
  } catch {
    return null;
  }
}

export async function runGitHook(
  repoRoot: string,
): Promise<{ warning?: string }> {
  const state = await readAgentsState(repoRoot);
  if (
    state.lastRenderAt &&
    Date.now() - Date.parse(state.lastRenderAt) < 2_000 &&
    !(await agentsTreeChangedSince(repoRoot, Date.parse(state.lastRenderAt)))
  ) {
    return {};
  }

  // TODO(Phase 3): check daemon heartbeat via getRepoRegistration + isHeartbeatStale
  // TODO(Phase 2): call buildAgentsRepo(repoRoot, { yes: true, force: true })
  // For now, warn that the hook is not yet wired to the build pipeline.
  const warning = 'chalkbag: daemon not yet wired — hook-run is a no-op until Phase 2/3 are complete';
  return { warning };
}

async function agentsTreeChangedSince(repoRoot: string, timestamp: number): Promise<boolean> {
  return directoryChangedSince(path.join(repoRoot, '.chalk'), timestamp);
}

async function directoryChangedSince(directory: string, timestamp: number): Promise<boolean> {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.promises.stat(fullPath);
      if (stat.mtimeMs > timestamp) {
        return true;
      }

      if (entry.isDirectory() && (await directoryChangedSince(fullPath, timestamp))) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function buildStandaloneHookBlock(): string {
  return `#!/bin/bash
set -euo pipefail
${buildHookInvocation()}
`;
}

function buildAppendedHookBlock(): string {
  return buildHookInvocation();
}

function buildHookInvocation(): string {
  // Best-effort: skip silently if binary missing. Wrapped so a chalkbag
  // failure can't mask exit codes from earlier hook steps under set -e.
  return `${MARKER}
if command -v chalkbag >/dev/null 2>&1; then
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
  chalkbag internal hook-run "$repo_root" >/dev/null 2>&1 || true
fi`;
}
