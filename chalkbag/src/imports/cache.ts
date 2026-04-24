import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ChalkBagError } from '../types.js';

const execFileAsync = promisify(execFile);

export function cacheDir(owner: string, repo: string, sha: string): string {
  return path.join(os.homedir(), '.cache', 'chalkbag', 'imports', owner, repo, sha);
}

export async function ensureCached(
  owner: string,
  repo: string,
  sha: string,
  token: string | null,
): Promise<string> {
  const dir = cacheDir(owner, repo, sha);

  if (await pathExists(path.join(dir, '.git'))) {
    return dir;
  }

  await fs.promises.mkdir(dir, { recursive: true });

  const url = token
    ? `https://${token}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;

  try {
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', '--no-checkout', url, dir],
      { timeout: 60000 },
    );
    await execFileAsync('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', sha], { timeout: 60000 });
    await execFileAsync('git', ['-C', dir, 'checkout', sha], { timeout: 30000 });
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});

    const message = error instanceof Error ? error.message : String(error);
    throw new ChalkBagError({
      kind: 'io',
      file: `${owner}/${repo}`,
      message: `failed to clone ${owner}/${repo}@${sha}: ${message}`,
      cause: error,
      fix: 'check your network connection and that the repository exists and is accessible',
    });
  }

  return dir;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
