import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import picomatch from 'picomatch';

import { ChalkBagError } from './types.js';

export type ScopeKind = 'repo' | 'global';

export type AgentsScope = {
  /** `repo` = per-repository `.chalk/`; `global` = machine-level `~/.chalk/`. */
  kind: ScopeKind;
  sourceRoot: string;
  outputRoot: string;
  agentsRoot: string;
};

type PathSource = string;

export async function resolveAgentsScope(startPath: string): Promise<AgentsScope> {
  const start = await normalizeStart(startPath);
  let current = start;
  const basename = path.basename(current);

  if (basename === '.chalk' && (await pathExists(current))) {
    const parent = path.dirname(current);
    return {
      kind: 'repo',
      sourceRoot: parent,
      outputRoot: parent,
      agentsRoot: current,
    };
  }

  while (true) {
    const agentsRoot = path.join(current, '.chalk');
    if (await pathExists(agentsRoot)) {
      return {
        kind: 'repo',
        sourceRoot: current,
        outputRoot: current,
        agentsRoot,
      };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new ChalkBagError({
    kind: 'config',
    file: startPath,
    message: 'unable to locate .chalk/ from this path',
    fix: 'run `chalkbag scaffold` or cd into a repo with .chalk/',
  });
}

/**
 * Returns the machine-level home directory chalkbag treats as the global
 * scope root.
 *
 * Reads `CHALKBAG_HOME` when set (the override the tests use so they never
 * touch the real `$HOME`), otherwise falls back to `os.homedir()`. Validates
 * the value is absolute and free of control characters — mirrors the
 * `getConfigHome()` seam in the daemon registry.
 */
export function getUserHome(): string {
  const raw = process.env.CHALKBAG_HOME ?? os.homedir();
  if (!path.isAbsolute(raw)) {
    throw new ChalkBagError({
      kind: 'config',
      file: 'CHALKBAG_HOME',
      message: `CHALKBAG_HOME must be an absolute path (got: ${raw})`,
      fix: 'set CHALKBAG_HOME to an absolute path or unset to use your OS home directory',
    });
  }
  for (const ch of raw) {
    if (ch.charCodeAt(0) < 0x20) {
      throw new ChalkBagError({
        kind: 'config',
        file: 'CHALKBAG_HOME',
        message: 'CHALKBAG_HOME contains control characters',
        fix: 'set CHALKBAG_HOME to a clean absolute path',
      });
    }
  }
  return raw;
}

/**
 * Resolves the machine-level global scope: `~/.chalk/` compiled into
 * user-level Claude and Codex config. Unlike {@link resolveAgentsScope} this
 * never walks the filesystem — the home directory is authoritative.
 *
 * `sourceRoot`/`outputRoot` are the home directory so the same
 * `.claude/…`, `.codex/…`, and `.agents/…` relative output paths the repo
 * scope uses land under `~/` instead of a repo root.
 */
export function resolveGlobalScope(homeDir: string = getUserHome()): AgentsScope {
  const home = path.resolve(homeDir);
  return {
    kind: 'global',
    sourceRoot: home,
    outputRoot: home,
    agentsRoot: path.join(home, '.chalk'),
  };
}

export function isPathIgnored(baseRoot: string, targetPath: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  const relative = path.relative(baseRoot, targetPath).split(path.sep).join('/');
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return true;
  }

  return patterns.some((pattern) => picomatch(pattern)(relative));
}

async function normalizeStart(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  if (await pathIsDirectory(resolved)) {
    return resolved;
  }

  if (path.extname(resolved).length > 0) {
    return path.dirname(resolved);
  }

  return path.dirname(resolved);
}

async function pathExists(targetPath: PathSource): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function pathIsDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}
