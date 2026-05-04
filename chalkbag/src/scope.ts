import fs from 'node:fs';
import path from 'node:path';

import picomatch from 'picomatch';

import { ChalkBagError } from './types.js';

export type AgentsScope = {
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
      sourceRoot: parent,
      outputRoot: parent,
      agentsRoot: current,
    };
  }

  while (true) {
    const agentsRoot = path.join(current, '.chalk');
    if (await pathExists(agentsRoot)) {
      return {
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
