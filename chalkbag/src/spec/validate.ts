import { resolveAgentsScope } from '../scope.js';
import { loadAgentsRepo } from './load.js';

export async function validateAgentsRepo(rootPath: string): Promise<void> {
  const scope = await resolveAgentsScope(rootPath);
  await loadAgentsRepo(scope);
}
