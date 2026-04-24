import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import type { LoadedAgentsRepo } from '../spec/load.js';
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

    for (const agent of context.repo.subagents) {
      if (!supportsProvider(agent.frontmatter.targets, 'claude')) {
        continue;
      }

      const relativeOutputPath = stripSubagentSourcePrefix(agent.relativePath);
      files.push({
        kind: 'file',
        path: `.claude/agents/${relativeOutputPath}`,
        content: renderMarkdownDocument(agent.frontmatter, agent.body),
        sourcePath: agent.relativePath,
      });
    }

    const permissions = buildClaudePermissions(context.repo);
    if (permissions !== null) {
      files.push({
        kind: 'file',
        path: '.claude/settings.json',
        content: permissions,
        sourcePath: '.agents/permissions.yaml',
      });
    }

    return files;
  },
} satisfies Provider;

export default claudeProvider;

function supportsProvider(targets: string[] | undefined, providerId: string): boolean {
  return targets === undefined ? true : targets.includes(providerId);
}

function sanitizeFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(frontmatter)
      .filter(([key, value]) => key !== 'targets' && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function renderMarkdownDocument(frontmatter: Record<string, unknown>, body: string): string {
  const sanitized = sanitizeFrontmatter(frontmatter);
  if (Object.keys(sanitized).length === 0) {
    return `${body.trimEnd()}\n`;
  }

  return `---\n${YAML.stringify(sanitized).trimEnd()}\n---\n\n${body.trimEnd()}\n`;
}

function stripSubagentSourcePrefix(relativePath: string): string {
  return relativePath.replace(/^\.agents\/subagents\//u, '');
}

function buildClaudePermissions(
  repo: LoadedAgentsRepo,
): string | null {
  const permissions = repo.permissions;
  const permissionLines: {
    allow: string[];
    deny: string[];
    ask: string[];
    defaultMode?: string;
    sandboxMode?: string;
    networkAccess?: boolean;
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
  }

  if (
    permissionLines.allow.length === 0 &&
    permissionLines.deny.length === 0 &&
    permissionLines.ask.length === 0 &&
    permissionLines.defaultMode === undefined &&
    permissionLines.sandboxMode === undefined
  ) {
    return null;
  }

  const existing = readSettingsJson(repo.scope.outputRoot);
  const mergedPermissions = dedupePermissionLines({
    ...(existing.permissions ?? {}),
    ...permissionLines,
  } as typeof permissionLines);

  const payload = {
    ...existing,
    permissions: mergedPermissions,
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
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

function dedupePermissionLines(
  permissions: {
    allow: string[];
    deny: string[];
    ask: string[];
    [key: string]: unknown;
  },
): {
  allow: string[];
  deny: string[];
  ask: string[];
  [key: string]: unknown;
} {
  const allow = Array.from(new Set(permissions.allow ?? []));
  const deny = Array.from(new Set(permissions.deny ?? []));
  const ask = Array.from(new Set(permissions.ask ?? []));

  return {
    ...permissions,
    allow,
    deny,
    ask,
  };
}

function readSettingsJson(repoRoot: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, '.claude', 'settings.json'), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
