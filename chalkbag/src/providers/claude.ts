import fs from 'node:fs';
import path from 'node:path';

import type { LoadedAgentsRepo } from '../spec/load.js';
import { ChalkBagError } from '../types.js';
import type { GeneratedOutput, Provider } from './_plugin.js';

const claudeProvider = {
  id: 'claude',
  displayName: 'Claude',
  render(context) {
    if (!context.enabledProviders.includes('claude')) {
      return [];
    }

    const files: GeneratedOutput[] = [];

    for (const skill of context.repo.skills) {
      if (!supportsProvider(skill.entrypoint.frontmatter.targets, 'claude')) {
        continue;
      }

      for (const file of skill.files) {
        const relativeToSkill = path.relative(skill.directoryPath, file.sourcePath).split(path.sep).join('/');
        files.push({
          kind: 'file',
          path: `.claude/skills/${path.basename(skill.directoryPath)}/${relativeToSkill}`,
          content: file.content,
          sourcePath: file.relativePath,
        });
      }
    }

    const permissions = buildClaudePermissions(context.repo);
    if (permissions !== null) {
      files.push({
        kind: 'file',
        path: '.claude/settings.json',
        content: permissions,
        sourcePath: '.chalk/permissions.yaml',
      });
    }

    return files;
  },
} satisfies Provider;

export default claudeProvider;

function supportsProvider(targets: string[] | undefined, providerId: string): boolean {
  return targets === undefined ? true : targets.includes(providerId);
}

/**
 * Options for {@link buildClaudePermissions}.
 *
 * `unionExistingArrays` controls how the `allow`/`deny`/`ask` permission
 * arrays merge with the on-disk settings file:
 *   - repo scope (default `false`): the output is a generated, gitignored file
 *     chalkbag fully owns, so the arrays are *replaced* by the freshly compiled
 *     set — removing a rule from `permissions.yaml` removes it from the output.
 *   - global scope (`true`): the output is the user's real
 *     `~/.claude/settings.json`, so the arrays are *unioned* with whatever the
 *     user already has — chalkbag never drops entries it did not author.
 */
export type BuildClaudePermissionsOptions = { unionExistingArrays?: boolean };

/**
 * Builds the `.claude/settings.json` payload, merging chalkbag's permissions
 * into any existing settings file at `repo.scope.outputRoot/.claude/`. Exported
 * so the global scope can reuse the exact read-then-merge behavior against the
 * user's real `~/.claude/settings.json`. Returns `null` when there is nothing
 * to write.
 */
export function buildClaudePermissions(
  repo: LoadedAgentsRepo,
  options: BuildClaudePermissionsOptions = {},
): string | null {
  const permissions = repo.permissions;
  const permissionLines: {
    allow: string[];
    deny: string[];
    ask: string[];
    defaultMode?: string;
    sandboxMode?: string;
    networkAccess?: boolean;
    additionalDirectories?: string[];
  } = {
    allow: [],
    deny: [],
    ask: [],
  };

  if (permissions) {
    appendPatterns(permissionLines.allow, permissions.bash?.allow, (pattern) => `Bash(${pattern})`);
    appendPatterns(permissionLines.deny, permissions.bash?.deny, (pattern) => `Bash(${pattern})`);
    appendPatterns(permissionLines.ask, permissions.bash?.ask, (pattern) => `Bash(${pattern})`);

    appendPatterns(permissionLines.allow, permissions.read?.allow, (pattern) => `Read(${pattern})`);
    appendPatterns(permissionLines.deny, permissions.read?.deny, (pattern) => `Read(${pattern})`);

    appendPatterns(permissionLines.allow, permissions.write?.allow, (pattern) => `Edit(${pattern})`);
    appendPatterns(permissionLines.deny, permissions.write?.deny, (pattern) => `Edit(${pattern})`);

    appendPatterns(permissionLines.allow, permissions.webfetch?.allow, (pattern) => `WebFetch(${pattern})`);
    appendPatterns(permissionLines.deny, permissions.webfetch?.deny, (pattern) => `WebFetch(${pattern})`);

    appendPatterns(permissionLines.allow, permissions.mcp?.allow, (pattern) => pattern);
    appendPatterns(permissionLines.deny, permissions.mcp?.deny, (pattern) => pattern);

    if (permissions.defaultMode) {
      permissionLines.defaultMode = permissions.defaultMode;
    }
    if (permissions.sandbox?.mode) {
      permissionLines.sandboxMode = permissions.sandbox.mode;
    }
    if (typeof permissions.sandbox?.networkAccess === 'boolean') {
      permissionLines.networkAccess = Boolean(permissions.sandbox.networkAccess);
    }

    if (permissions.additionalRoots && permissions.additionalRoots.length > 0) {
      permissionLines.additionalDirectories = [
        ...(permissionLines.additionalDirectories ?? []),
        ...permissions.additionalRoots,
      ];
    }
  }

  if (
    permissionLines.allow.length === 0 &&
    permissionLines.deny.length === 0 &&
    permissionLines.ask.length === 0 &&
    permissionLines.defaultMode === undefined &&
    permissionLines.sandboxMode === undefined &&
    (permissionLines.additionalDirectories?.length ?? 0) === 0
  ) {
    return null;
  }

  const existing = readSettingsJson(repo.scope.outputRoot);
  const existingPermissions =
    typeof existing.permissions === 'object' && existing.permissions !== null
      ? (existing.permissions as Record<string, unknown>)
      : {};
  const mergedPermissions = mergePermissionLines(
    existingPermissions,
    permissionLines as unknown as Record<string, unknown>,
    Boolean(options.unionExistingArrays),
  );

  const payload = {
    ...existing,
    permissions: mergedPermissions,
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Merges chalkbag's compiled permission fields into the existing on-disk
 * permissions object.
 *
 * Unrelated keys the user has (e.g. a custom permission bucket) are preserved.
 * Array-valued fields (`allow`/`deny`/`ask`/`additionalDirectories`) are
 * deduplicated; when `unionExistingArrays` is set they are unioned with the
 * user's existing entries rather than replaced, so global scope never drops
 * user-authored permissions.
 */
function mergePermissionLines(
  existingPermissions: Record<string, unknown>,
  generated: Record<string, unknown>,
  unionExistingArrays: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existingPermissions };

  for (const [key, value] of Object.entries(generated)) {
    if (Array.isArray(value)) {
      const previous =
        unionExistingArrays && Array.isArray(result[key]) ? (result[key] as unknown[]) : [];
      result[key] = Array.from(new Set([...(previous as string[]), ...(value as string[])]));
    } else {
      result[key] = value;
    }
  }

  return result;
}

function appendPatterns(
  target: string[],
  source: string[] | undefined,
  map: (value: string) => string,
): void {
  if (!source) {
    return;
  }

  for (const value of source) {
    target.push(map(value));
  }
}

/**
 * Reads the existing `.claude/settings.json` so chalkbag can merge into it.
 *
 * Fails closed: a genuinely absent file (ENOENT) is the only case that returns
 * `{}`. A present-but-unreadable or malformed file throws a {@link ChalkBagError}
 * so the caller aborts rather than treating the file as empty and rewriting it —
 * which, for the user's real `~/.claude/settings.json`, would silently drop every
 * other top-level key.
 */
function readSettingsJson(repoRoot: string): Record<string, unknown> {
  const settingsPath = path.join(repoRoot, '.claude', 'settings.json');

  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return {};
    }
    throw new ChalkBagError({
      kind: 'config',
      file: settingsPath,
      message: 'could not read existing settings.json',
      cause: error,
      fix: 'fix or move the malformed file, then re-run',
    });
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new ChalkBagError({
      kind: 'config',
      file: settingsPath,
      message: 'existing settings.json is not valid JSON',
      cause: error,
      fix: 'fix or move the malformed file, then re-run',
    });
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
