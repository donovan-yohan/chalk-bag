import fs from 'node:fs';
import path from 'node:path';

import { providerGeneratedArtifactEntries } from './providers/registry.js';

const REQUIRED_GITIGNORE_BLOCK = [
  '# chalkbag — generated artifacts',
  ...providerGeneratedArtifactEntries,
  '!/AGENTS.md',
  '!/CLAUDE.md',
  '',
  '# chalkbag — state',
  '/.agents/.state.json',
  '/.agents/.state.lock',
  '/.agents-tmp/',
];

export async function ensureGitignoreEntries(repoRoot: string): Promise<boolean> {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const existing = await readFileIfExists(gitignorePath);

  if (REQUIRED_GITIGNORE_BLOCK.every((line) => existing.includes(line))) {
    return false;
  }

  const separator = existing.trim().length === 0 ? '' : '\n';
  const nextContent = `${existing.trimEnd()}${separator}\n${REQUIRED_GITIGNORE_BLOCK.join('\n')}\n`;

  await fs.promises.writeFile(gitignorePath, nextContent, 'utf8');
  return true;
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}
