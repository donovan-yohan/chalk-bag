import type { LoadedAgentsRepo } from '../spec/load.js';
import type { ProviderId } from './registry.js';

export type GeneratedFile = {
  kind: 'file';
  path: string;
  content: string;
  sourcePath: string;
};

export type GeneratedSymlink = {
  kind: 'symlink';
  path: string;
  target: string;
  sourcePath: string;
};

export type GeneratedOutput = GeneratedFile | GeneratedSymlink;

export type ProviderRenderContext = {
  repo: LoadedAgentsRepo;
  enabledProviders: ProviderId[];
  reportWarning: (warning: string) => void;
};

export type Provider = {
  id: ProviderId;
  displayName: string;
  render: (context: ProviderRenderContext) => GeneratedOutput[];
};
