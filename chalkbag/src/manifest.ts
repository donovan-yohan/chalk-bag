import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ProviderId } from './spec/types.js';

export type ManifestEntry = {
  hash: string;
  sourcePath: string;
};

export type AgentsState = {
  lastFlags: ProviderId[];
  manifest: Record<string, ManifestEntry>;
  lastRenderAt?: string;
  lastBuildAt?: string;
  daemonVersion?: string;
};

type StateOptions = { stateDirectory?: string };

export async function readAgentsState(repoRoot: string, options: StateOptions = {}): Promise<AgentsState> {
  const statePath = getStatePath(repoRoot, options.stateDirectory);

  try {
    const raw = await fs.promises.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentsState>;
    return {
      lastFlags: parsed.lastFlags ?? [],
      manifest: parsed.manifest ?? {},
      lastBuildAt: parsed.lastBuildAt,
      lastRenderAt: parsed.lastRenderAt,
      daemonVersion: parsed.daemonVersion,
    };
  } catch {
    return {
      lastFlags: [],
      manifest: {},
    };
  }
}

export async function writeAgentsState(
  repoRoot: string,
  state: AgentsState,
  options: StateOptions = {},
): Promise<void> {
  const statePath = getStatePath(repoRoot, options.stateDirectory);
  const tempPath = `${statePath}.tmp`;

  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await fs.promises.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tempPath, statePath);
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function getStatePath(repoRoot: string, stateDirectory = '.agents'): string {
  return path.join(repoRoot, stateDirectory, '.state.json');
}
