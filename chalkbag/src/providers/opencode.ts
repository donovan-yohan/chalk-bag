import fs from 'node:fs';
import path from 'node:path';

import type { LoadedAgentsRepo } from '../spec/load.js';
import type { PermissionsConfig } from '../spec/schema.js';
import type { GeneratedOutput, Provider } from './_plugin.js';

const opencodeProvider = {
  id: 'opencode',
  displayName: 'OpenCode',
  render(context) {
    if (!context.enabledProviders.includes('opencode')) {
      return [];
    }

    const files: GeneratedOutput[] = [];

    const permissionConfig = buildOpencodePermissionConfig(context.repo);
    const existingPermission = readExistingPermission(context.repo.scope.outputRoot);
    const merged = mergePermissions(existingPermission, permissionConfig);

    files.push({
      kind: 'file',
      path: 'opencode.json',
      content: `${JSON.stringify({ permission: merged }, null, 2)}\n`,
      sourcePath: '.chalk/permissions.yaml',
    });

    return files;
  },
} satisfies Provider;

export default opencodeProvider;

function translateDefaultMode(mode?: PermissionsConfig['defaultMode']): 'allow' | 'deny' | 'ask' | undefined {
  if (!mode) return undefined;
  switch (mode) {
    case 'acceptEdits':
    case 'auto':
    case 'dontAsk':
      return 'allow';
    case 'plan':
    case 'default':
      return 'ask';
    default:
      return undefined;
  }
}

function buildOpencodePermissionConfig(
  repo: LoadedAgentsRepo,
): Record<string, unknown> {
  const permissions = repo.permissions;
  const output: Record<string, unknown> = {};

  const translatedMode = translateDefaultMode(permissions?.defaultMode);
  if (translatedMode !== undefined) {
    setMode(output, '*', translatedMode);
  }
  if (!permissions) {
    return output;
  }

  setPermissionGroup(output, 'bash', permissions.bash);
  setPermissionGroup(output, 'read', permissions.read);
  setPermissionGroup(output, 'edit', permissions.write);
  setPermissionGroup(output, 'webfetch', permissions.webfetch);

  if (permissions.mcp) {
    const mergedMcp: Record<string, string> = {};
    appendPermissionPairs(mergedMcp, permissions.mcp.allow, 'allow');
    appendPermissionPairs(mergedMcp, permissions.mcp.deny, 'deny');
    for (const [pattern, mode] of Object.entries(mergedMcp)) {
      output[pattern] = mode;
    }
  }

  return output;
}

type PermissionRuleBlock = { allow?: string[]; deny?: string[]; ask?: string[] };

function setPermissionGroup(
  permissionConfig: Record<string, unknown>,
  key: 'bash' | 'read' | 'edit' | 'webfetch' | string,
  rules: PermissionRuleBlock | undefined,
): void {
  if (!rules) {
    return;
  }

  const group: Record<string, string> = {};
  appendPermissionPairs(group, rules.allow, 'allow');
  appendPermissionPairs(group, rules.ask, 'ask');
  appendPermissionPairs(group, rules.deny, 'deny');

  if (Object.keys(group).length > 0) {
    permissionConfig[key] = sortPermissionGroup(group);
  }
}

function appendPermissionPairs(group: Record<string, string>, patterns: string[] | undefined, mode: 'allow' | 'deny' | 'ask'): void {
  if (!patterns || patterns.length === 0) {
    return;
  }

  const sortedPatterns = [...new Set(patterns)].sort(sortPatternsForLastMatchWins);
  for (const pattern of sortedPatterns) {
    group[pattern] = mode;
  }
}

function setMode(permissionConfig: Record<string, unknown>, key: string, value: string | undefined): void {
  if (!value) {
    return;
  }
  permissionConfig[key] = value;
}

function readExistingPermission(repoRoot: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'opencode.json'), 'utf8');
    const parsed = JSON.parse(raw) as { permission?: unknown };
    return typeof parsed.permission === 'object' && parsed.permission !== null ? (parsed.permission as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergePermissions(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };

  for (const [key, value] of Object.entries(generated)) {
    const existingValue = merged[key];
    // Deep-merge when both sides are plain objects (e.g. bash, edit, read, webfetch tool keys)
    if (isPlainObject(existingValue) && isPlainObject(value)) {
      merged[key] = { ...existingValue, ...value };
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function sortPermissionGroup(permissionGroup: Record<string, string>): Record<string, string> {
  const sortedEntries = Object.entries(permissionGroup).sort(([left], [right]) => {
    const order = patternOrderComparator(left, right);
    if (order !== 0) {
      return order;
    }
    return left.localeCompare(right);
  });

  return Object.fromEntries(sortedEntries);
}

function sortPatternsForLastMatchWins(left: string, right: string): number {
  return patternOrderComparator(left, right);
}

function patternOrderComparator(left: string, right: string): number {
  const leftHasWildcard = left.includes('*');
  const rightHasWildcard = right.includes('*');
  if (leftHasWildcard !== rightHasWildcard) {
    return leftHasWildcard ? -1 : 1;
  }

  const leftSegments = left.split('/').filter(Boolean).length;
  const rightSegments = right.split('/').filter(Boolean).length;
  if (leftSegments !== rightSegments) {
    return leftSegments - rightSegments;
  }

  return left.length - right.length;
}
