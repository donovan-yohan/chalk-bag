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
        sourcePath: '.chalk/permissions.yaml',
      });
    }

    const config = buildCodexConfig(context.repo, context.reportWarning);
    if (config.length > 0) {
      files.push({
        kind: 'file',
        path: '.codex/config.toml',
        content: `${config.join('\n')}\n`,
        sourcePath: '.chalk/permissions.yaml',
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
  return relativePath.replace(/^\.chalk\/subagents\//u, '');
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
  reportWarning: (warning: string) => void,
): string[] {
  const permissions = repo.permissions;
  const sandboxMode = permissions?.sandbox?.mode ?? 'read-only';
  const networkAccess = permissions?.sandbox?.networkAccess ?? true;
  const approvalPolicy = mapApprovalPolicy(permissions?.defaultMode);
  const projectName = path.basename(repo.scope.sourceRoot);
  const additionalRoots = permissions?.additionalRoots ?? [];

  if (additionalRoots.length > 0 && sandboxMode !== 'workspace-write') {
    reportWarning(
      'codex ignores `additionalRoots` unless `sandbox.mode = "workspace-write"`; writable_roots not emitted',
    );
  }

  const configLines: string[] = [];
  configLines.push('# generated by chalkbag');
  configLines.push(`sandbox_mode = ${pathToTomlQuoted(sandboxMode)}`);
  configLines.push(`approval_policy = ${pathToTomlQuoted(approvalPolicy)}`);

  const permsBlock = buildCodexPermissionsBlock(permissions, reportWarning);

  // [sandbox_workspace_write] is only meaningful when sandbox_mode is
  // workspace-write. With a custom profile the built-in :workspace network
  // toggle becomes dead weight (custom profile owns network), so
  // network_access is omitted there. writable_roots, however, governs
  // sibling-dir write access and stays relevant alongside the custom
  // profile.
  const sandboxWriteLines: string[] = [];
  if (sandboxMode === 'workspace-write' && permsBlock.lines.length === 0) {
    sandboxWriteLines.push(`network_access = ${String(networkAccess)}`);
  }
  if (sandboxMode === 'workspace-write' && additionalRoots.length > 0) {
    const dedupedRoots = Array.from(new Set(additionalRoots));
    const serialized = dedupedRoots.map((root) => pathToTomlQuoted(root)).join(', ');
    sandboxWriteLines.push(`writable_roots = [${serialized}]`);
  }

  if (permsBlock.lines.length > 0) {
    configLines.push('default_permissions = "default"');
    configLines.push('');
    configLines.push(...permsBlock.lines);
  }

  if (sandboxWriteLines.length > 0) {
    configLines.push('');
    configLines.push('[sandbox_workspace_write]');
    configLines.push(...sandboxWriteLines);
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

// Translate the shared permissions schema into a codex custom profile
// (`[permissions.default]`). Returns an empty list when the user hasn't
// configured anything beyond sandbox_mode/approval_policy.
//
// Strategy (validated against codex schema + runtime guards):
//   - filesystem rules live under `[permissions.default.filesystem.":project_roots"]`
//   - workspace write is granted via the special `"." = "write"` key which
//     compiles to `:project_roots` (subpath=None) and sets
//     `workspace_root_writable = true` — the only form that survives the
//     runtime guard at codex-rs/protocol/src/permissions.rs:1068
//   - deny globs (read.deny ∪ write.deny) emit as `"<glob>" = "none"` —
//     scoped tables only accept `none` for glob patterns
//   - read.allow is dropped (codex has no glob read-allow concept; sandboxed
//     write already implies read across the project)
//   - auto-protect `.git`, `.codex`, `.chalk`, `.agents` since the custom
//     profile loses the built-in `:workspace` profile's automatic
//     protections (`.chalk` is the source-of-truth tree; `.agents` is the
//     gitignored AGENTS.md-spec mirror chalkbag manages itself)
//   - network rules under `[permissions.default.network]` with explicit
//     `enabled = true` — required to activate the domain table
//   - mcp rules drop with a warning (no codex equivalent)
function buildCodexPermissionsBlock(
  permissions: LoadedAgentsRepo['permissions'],
  reportWarning: (warning: string) => void,
): { lines: string[] } {
  if (!permissions) {
    return { lines: [] };
  }

  const lines: string[] = [];

  const fsLines = buildCodexFilesystemSection(permissions, reportWarning);
  const networkLines = buildCodexNetworkSection(permissions, reportWarning);

  if (fsLines.length === 0 && networkLines.length === 0) {
    return { lines: [] };
  }

  if (fsLines.length > 0) {
    lines.push(...fsLines);
  }
  if (networkLines.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(...networkLines);
  }

  return { lines };
}

const CODEX_AUTO_PROTECT_PATHS = ['.git', '.codex', '.chalk', '.agents'];

function buildCodexFilesystemSection(
  permissions: LoadedAgentsRepo['permissions'],
  reportWarning: (warning: string) => void,
): string[] {
  const writeAllow = permissions?.write?.allow ?? [];
  const readAllow = permissions?.read?.allow ?? [];
  const denyEntries: string[] = [];
  const seenDeny = new Set<string>();

  const normalizeDeny = (raw: string): string | null => {
    let p = raw.trim();
    if (p.startsWith('./')) p = p.slice(2);
    return p.length === 0 ? null : p;
  };

  for (const raw of [...(permissions?.read?.deny ?? []), ...(permissions?.write?.deny ?? [])]) {
    const p = normalizeDeny(raw);
    if (p !== null && !seenDeny.has(p)) {
      seenDeny.add(p);
      denyEntries.push(p);
    }
  }

  const hasAnyFs =
    writeAllow.length > 0 || readAllow.length > 0 || denyEntries.length > 0;
  if (!hasAnyFs) {
    return [];
  }

  if (readAllow.length > 0) {
    reportWarning(
      'read.allow globs are not translated to codex; sandboxed writes already grant read across :project_roots',
    );
  }

  const lines: string[] = [];
  lines.push('[permissions.default.filesystem.":project_roots"]');

  // Workspace write — uses the `"." = "write"` shorthand which the codex
  // config compiler treats as bare :project_roots (subpath=None).
  if (writeAllow.length > 0) {
    lines.push('"." = "write"');
  }

  // Auto-protect well-known sensitive dirs since the custom profile
  // loses the built-in `:workspace` protections.
  for (const p of CODEX_AUTO_PROTECT_PATHS) {
    if (!seenDeny.has(p)) {
      lines.push(`${pathToTomlQuoted(p)} = "none"`);
    }
  }

  for (const p of denyEntries) {
    lines.push(`${pathToTomlQuoted(p)} = "none"`);
  }

  return lines;
}

function buildCodexNetworkSection(
  permissions: LoadedAgentsRepo['permissions'],
  reportWarning: (warning: string) => void,
): string[] {
  const stripDomainPrefix = (raw: string): string =>
    raw.startsWith('domain:') ? raw.slice('domain:'.length) : raw;

  const isCodexValidHostPattern = (host: string): boolean => {
    // Codex accepts exact hosts (`github.com`) or scoped wildcards
    // (`*.example.com`, `**.example.com`). Bare `*` is rejected.
    if (host === '*' || host.length === 0) return false;
    if (host.startsWith('*.') || host.startsWith('**.')) {
      return host.slice(host.indexOf('.') + 1).length > 0;
    }
    return !host.includes('*');
  };

  const domains = new Map<string, 'allow' | 'deny'>();
  const collect = (rawList: string[] | undefined, mode: 'allow' | 'deny'): void => {
    for (const raw of rawList ?? []) {
      const host = stripDomainPrefix(raw.trim());
      if (!isCodexValidHostPattern(host)) {
        reportWarning(
          `webfetch ${mode} pattern ${JSON.stringify(raw)} not translated to codex; expected exact host or scoped wildcard (e.g. *.example.com). With network.enabled = true, unlisted hosts are denied by default.`,
        );
        continue;
      }
      domains.set(host, mode);
    }
  };
  collect(permissions?.webfetch?.allow, 'allow');
  collect(permissions?.webfetch?.deny, 'deny');

  if (domains.size === 0) {
    return [];
  }

  const lines: string[] = [];
  lines.push('[permissions.default.network]');
  // `enabled = true` is required for the domain table to actually
  // restrict outbound network on a custom profile. With it, hosts not
  // listed in the domains table are denied by default.
  lines.push('enabled = true');
  lines.push('');
  lines.push('[permissions.default.network.domains]');
  for (const [host, mode] of domains) {
    lines.push(`${pathToTomlQuoted(host)} = "${mode}"`);
  }
  return lines;
}

