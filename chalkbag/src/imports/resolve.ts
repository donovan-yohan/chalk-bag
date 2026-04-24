import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ChalkBagError } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Validate that an import path entry is safe to use as a subpath within a
 * cloned GitHub repository. Rejects paths that could escape the repository
 * root via directory traversal or other filesystem tricks.
 *
 * Rules (eng auto-fix H-4):
 *  - No `..` path segments (e.g. "../etc/passwd", "foo/../bar")
 *  - Must not start with `/` (absolute paths)
 *  - Must not contain control characters (0x00–0x1F)
 */
export function validateImportPath(importPath: string, source: string): void {
  // Reject control characters (0x00–0x1F)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F]/.test(importPath)) {
    throw new ChalkBagError({
      kind: 'config',
      file: source,
      message: 'import path contains unsafe segments',
      fix: 'use a relative path without ".." or absolute roots',
    });
  }

  // Reject absolute paths
  if (importPath.startsWith('/')) {
    throw new ChalkBagError({
      kind: 'config',
      file: source,
      message: 'import path contains unsafe segments',
      fix: 'use a relative path without ".." or absolute roots',
    });
  }

  // Reject any `..` segment (split on both / and \ to catch mixed separators)
  const segments = importPath.split(/[/\\]/);
  if (segments.some((seg) => seg === '..')) {
    throw new ChalkBagError({
      kind: 'config',
      file: source,
      message: 'import path contains unsafe segments',
      fix: 'use a relative path without ".." or absolute roots',
    });
  }
}

export function parseGitHubSource(source: string): { owner: string; repo: string } {
  const prefix = 'github:';
  if (!source.startsWith(prefix)) {
    throw new ChalkBagError({
      kind: 'config',
      file: source,
      message: `import source must start with "github:": ${source}`,
      fix: 'format the source as github:<owner>/<repo>',
    });
  }

  const rest = source.slice(prefix.length);
  const parts = rest.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ChalkBagError({
      kind: 'config',
      file: source,
      message: `import source must be "github:<owner>/<repo>": ${source}`,
      fix: 'format the source as github:<owner>/<repo> with exactly one slash after github:',
    });
  }

  return { owner: parts[0], repo: parts[1] };
}

export async function resolveRef(
  owner: string,
  repo: string,
  ref: string,
  token: string | null,
): Promise<string> {
  const url = token
    ? `https://${token}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-remote', url, ref],
      { timeout: 30000 },
    );

    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      throw new ChalkBagError({
        kind: 'config',
        file: `${owner}/${repo}`,
        message: `ref not found: ${ref}`,
        fix: `verify that the ref "${ref}" exists in ${owner}/${repo}`,
      });
    }

    // If multiple refs match (e.g. branch and tag), prefer exact match,
    // otherwise return the first SHA.
    const exact = lines.find((line) => line.endsWith(`\trefs/heads/${ref}`) || line.endsWith(`\trefs/tags/${ref}`));
    const sha = (exact ?? lines[0]).split('\t')[0];

    if (!sha || sha.length !== 40) {
      throw new ChalkBagError({
        kind: 'config',
        file: `${owner}/${repo}`,
        message: `unexpected ls-remote output for ref ${ref}`,
        fix: 'check that the ref is a valid branch, tag, or full SHA',
      });
    }

    return sha;
  } catch (error) {
    if (error instanceof ChalkBagError) throw error;

    const message = error instanceof Error ? error.message : String(error);
    throw new ChalkBagError({
      kind: 'io',
      file: `${owner}/${repo}`,
      message: `failed to resolve ref ${ref}: ${message}`,
      cause: error,
      fix: 'check your network connection and that you have access to the repository',
    });
  }
}
