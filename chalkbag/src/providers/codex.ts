import path from 'node:path';

import type { LoadedAgentsRepo } from '../spec/load.js';
import type { GeneratedOutput, Provider } from './_plugin.js';

const codexProvider = {
  id: 'codex',
  displayName: 'Codex',
  render(context) {
    if (!context.enabledProviders.includes('codex')) {
      return [];
    }

    const files: GeneratedOutput[] = [];
    for (const agent of context.repo.subagents) {
      if (!supportsProvider(agent.frontmatter.targets, 'codex')) {
        continue;
      }

      const relativeOutputPath = stripSubagentSourcePrefix(agent.relativePath);
      const parsedRelativePath = path.parse(relativeOutputPath);
      files.push({
        kind: 'file',
        path: path.posix.join('.codex', 'agents', parsedRelativePath.dir, `${toPromptName(parsedRelativePath.name)}.toml`),
        content: renderCodexAgent(agent.frontmatter, agent.body),
        sourcePath: agent.relativePath,
      });
    }

    const rules = buildCodexCommandRules(context.repo, context.reportWarning);
    if (rules.length > 0) {
      files.push({
        kind: 'file',
        path: `.codex/rules/${codexRepoSlug(context.repo.scope.sourceRoot)}.rules`,
        content: `${rules.join('\n')}\n`,
        sourcePath: '.agents/permissions.yaml',
      });
    }

    const config = buildCodexConfig(context.repo);
    if (config.length > 0) {
      files.push({
        kind: 'file',
        path: '.codex/config.toml',
        content: `${config.join('\n')}\n`,
        sourcePath: '.agents/permissions.yaml',
      });
    }

    if (context.repo.permissions?.mcp?.allow || context.repo.permissions?.mcp?.deny) {
      context.reportWarning('codex does not support mcp permission rules; dropped from output');
    }

    return files;
  },
} satisfies Provider;

export default codexProvider;

function supportsProvider(targets: string[] | undefined, providerId: string): boolean {
  return targets === undefined ? true : targets.includes(providerId);
}

function toPromptName(filename: string): string {
  return filename.replace(/\.md$/u, '').replace(/-/gu, '_');
}

function pathToTomlQuoted(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function codexRepoSlug(sourceRoot: string): string {
  return sourceRoot.split(path.sep).pop() ?? 'repo';
}

function renderCodexAgent(frontmatter: Record<string, unknown>, body: string): string {
  const fields = {
    ...sanitizeFrontmatter(frontmatter),
    developer_instructions: body.trimEnd(),
  };

  return `${serializeToml(fields).trimEnd()}\n`;
}

function sanitizeFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frontmatter).filter(([key, value]) => key !== 'targets' && value !== undefined));
}

function serializeToml(value: Record<string, unknown>, parents: string[] = []): string {
  const scalarLines: string[] = [];
  const tableSections: string[] = [];

  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }

    if (isPlainObject(entry)) {
      const tableName = [...parents, key].join('.');
      const sectionBody = serializeToml(entry as Record<string, unknown>, [...parents, key]).trim();
      tableSections.push(`[${tableName}]\n${sectionBody}`);
      continue;
    }

    scalarLines.push(`${key} = ${serializeTomlValue(entry)}`);
  }

  return [...scalarLines, ...tableSections].join('\n\n');
}

function serializeTomlValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.includes('\n') ? multilineTomlString(value) : pathToTomlQuoted(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeTomlValue(item)).join(', ')}]`;
  }

  if (value === null) {
    return '""';
  }

  throw new Error(`unsupported TOML value: ${JSON.stringify(value)}`);
}

function multilineTomlString(value: string): string {
  return `"""\n${value.replace(/"""/gu, '\\"""')}\n"""`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripSubagentSourcePrefix(relativePath: string): string {
  return relativePath.replace(/^\.agents\/subagents\//u, '');
}

function buildCodexCommandRules(
  repo: LoadedAgentsRepo,
  reportWarning: (warning: string) => void,
): string[] {
  const rules: string[] = [];
  const permissions = repo.permissions;

  if (!permissions) {
    return rules;
  }

  appendBashRules(rules, 'allow', permissions.bash?.allow, reportWarning);
  appendBashRules(rules, 'prompt', permissions.bash?.ask, reportWarning);
  appendBashRules(rules, 'forbidden', permissions.bash?.deny, reportWarning);

  return rules;
}

function appendBashRules(
  lines: string[],
  bucket: 'allow' | 'prompt' | 'forbidden',
  patterns: string[] | undefined,
  reportWarning: (warning: string) => void,
): void {
  if (!patterns) {
    return;
  }

  for (const pattern of patterns) {
    const translated = translateCodexPrefix(pattern);
    if (translated === null) {
      reportWarning(`codex could not faithfully translate bash pattern ${JSON.stringify(pattern)}`);
      continue;
    }

    const tokens = translated.split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) {
      reportWarning(`codex could not tokenize bash pattern ${JSON.stringify(pattern)}`);
      continue;
    }
    const tokenList = tokens.map((t) => JSON.stringify(t)).join(', ');
    lines.push(`prefix_rule(pattern = [${tokenList}], decision = "${bucket}")`);
  }
}

function translateCodexPrefix(pattern: string): string | null {
  const trimmed = pattern.trim();
  const wildcardIndex = trimmed.indexOf('*');

  if (wildcardIndex < 0) {
    return trimmed;
  }

  if (wildcardIndex !== trimmed.length - 1) {
    return null;
  }

  return trimmed.slice(0, wildcardIndex).trimEnd();
}

function buildCodexConfig(
  repo: LoadedAgentsRepo,
): string[] {
  const permissions = repo.permissions;
  const sandboxMode = permissions?.sandbox?.mode ?? 'read-only';
  const networkAccess = permissions?.sandbox?.networkAccess ?? true;
  const approvalPolicy = mapApprovalPolicy(permissions?.defaultMode);
  const projectName = path.basename(repo.scope.sourceRoot);

  const configLines: string[] = [];
  configLines.push('# generated by chalkbag');
  configLines.push(`sandbox_mode = ${pathToTomlQuoted(sandboxMode)}`);
  configLines.push(`approval_policy = ${pathToTomlQuoted(approvalPolicy)}`);

  if (sandboxMode === 'workspace-write') {
    configLines.push('');
    configLines.push('[sandbox_workspace_write]');
    configLines.push(`network_access = ${String(networkAccess)}`);
  }

  if (permissions?.read || permissions?.write || permissions?.webfetch || permissions?.mcp) {
    const include = readFilesystemSection(repo.permissions);
    if (include.length > 0) {
      configLines.push('');
      configLines.push(`[permissions.default.filesystem]`);
      configLines.push(...include);
    }
  }

  configLines.push('');
  configLines.push(`[projects.${pathToTomlQuoted(projectName)}]`);
  configLines.push('trust_level = "trusted"');

  return configLines;
}

// Map the Claude-style `defaultMode` enum used by the shared permissions
// schema onto Codex's `approval_policy` enum. Codex only accepts values from
// AskForApproval (untrusted, on-failure, on-request, never); anything else
// makes `~/.codex/config.toml` fail to load with a deserialize error.
function mapApprovalPolicy(mode: string | undefined): string {
  switch (mode) {
    case 'plan':
      return 'untrusted';
    case 'auto':
    case 'dontAsk':
      return 'never';
    case 'acceptEdits':
    case 'default':
    case undefined:
      return 'on-request';
    default:
      return 'on-request';
  }
}

function readFilesystemSection(permissions: LoadedAgentsRepo['permissions']): string[] {
  const lines: string[] = [];

  const addList = (key: string, values: string[] | undefined): void => {
    if (!values || values.length === 0) {
      return;
    }

    const unique = [...new Set(values)];
    lines.push(`${key} = [${unique.map(pathToTomlQuoted).join(', ')}]`);
  };

  if (permissions?.read?.allow) {
    addList('read', permissions.read.allow);
  }
  if (permissions?.read?.deny) {
    addList('read_deny', permissions.read.deny);
  }
  if (permissions?.write?.allow) {
    addList('write', permissions.write.allow);
  }
  if (permissions?.write?.deny) {
    addList('write_deny', permissions.write.deny);
  }
  if (permissions?.webfetch?.allow) {
    addList('webfetch_allow', permissions.webfetch.allow);
  }
  if (permissions?.webfetch?.deny) {
    addList('webfetch_deny', permissions.webfetch.deny);
  }

  if (lines.length === 0) {
    return [];
  }

  return lines;
}
