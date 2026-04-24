import type { Provider } from './_plugin.js';
import claudeProvider from './claude.js';
import codexProvider from './codex.js';
import opencodeProvider from './opencode.js';

export const providerIds = ['claude', 'codex', 'opencode'] as const;

export type ProviderId = (typeof providerIds)[number];

const firstPartyProviderDefinitions = [
  {
    provider: claudeProvider,
    generatedArtifactEntries: ['/.claude/'],
  },
  {
    provider: codexProvider,
    generatedArtifactEntries: ['/.codex/'],
  },
  {
    provider: opencodeProvider,
    generatedArtifactEntries: ['/opencode.json', '/.opencode/'],
  },
] as const;

export const firstPartyProviderRegistry = firstPartyProviderDefinitions.map(({ provider }) => provider) as [
  Provider,
  ...Provider[],
];

export const providerGeneratedArtifactEntries = firstPartyProviderDefinitions.flatMap(
  ({ generatedArtifactEntries }) => [...generatedArtifactEntries],
);

const firstPartyProviderRegistryById = new Map<ProviderId, Provider>(
  firstPartyProviderRegistry.map((provider) => [provider.id, provider] as const),
);

export function getFirstPartyProvider(providerId: ProviderId): Provider | undefined {
  return firstPartyProviderRegistryById.get(providerId);
}

export function renderProvidersConfig(
  enabledByProvider: Partial<Record<ProviderId, boolean>> = {},
): string {
  const lines = ['providers:'];

  for (const providerId of providerIds) {
    lines.push(`  ${providerId}:`);
    lines.push(`    enabled: ${String(enabledByProvider[providerId] ?? true)}`);
  }

  return `${lines.join('\n')}\n`;
}
