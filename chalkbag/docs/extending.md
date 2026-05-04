# Extending chalkbag with a new provider

This document explains how to add a provider to chalkbag today, and describes the v2 dynamic loader that is planned but not yet implemented.

For the provider interface reference, see the [Provider interface section](#provider-interface-reference) below.

---

## Today: add a first-party provider via fork + PR

The provider registry is statically compiled into chalkbag. Adding a provider requires forking the repo, implementing the provider module, registering it, and opening a PR.

### Step 1. Fork chalk-bag

Fork `https://github.com/donovan-yohan/chalk-bag` and clone your fork.

### Step 2. Add a provider module

Create a new file at `chalkbag/src/providers/<id>.ts`. The file must export a default `Provider` object:

```ts
import type { Provider } from './_plugin.js';

const myProvider: Provider = {
  id: 'myprovider',
  displayName: 'My Provider',
  render(context) {
    const outputs = [];

    // Use context.repo to access the loaded agents spec.
    // Call context.reportWarning('...') to surface non-fatal issues.
    // Return GeneratedOutput[] — files and symlinks to write.

    outputs.push({
      kind: 'file',
      path: `.myprovider/AGENTS.md`,
      content: context.repo.root?.body ?? '',
      sourcePath: `.chalk/AGENTS.md`,
    });

    return outputs;
  },
};

export default myProvider;
```

The `id` field must be a valid identifier and must not collide with `claude`, `codex`, or `opencode`.

### Step 3. Register the provider

Open `chalkbag/src/providers/registry.ts` and add your provider to `firstPartyProviderDefinitions`:

```ts
import myProvider from './myprovider.js';

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
  // Add here:
  {
    provider: myProvider,
    generatedArtifactEntries: ['/.myprovider/'],
  },
] as const;
```

`generatedArtifactEntries` lists the gitignored output paths that this provider owns. chalkbag uses these entries to enforce gitignore and to report what was rendered.

You also need to add your provider's id to the `providerIds` tuple:

```ts
export const providerIds = ['claude', 'codex', 'opencode', 'myprovider'] as const;
```

### Step 4. Build and test

```bash
cd chalkbag
npm install
npm run build
node dist/cli.js build --provider myprovider --yes
```

Add a test in `chalkbag/tests/` to cover the new provider's render output. See the existing provider tests for patterns.

### Step 5. Open a PR

Open a pull request against `donovan-yohan/chalk-bag`. Include:

- the new `src/providers/<id>.ts` module
- the updated `src/providers/registry.ts`
- at least one test
- a short description of what the provider does and what it outputs

---

## Tomorrow (v2 roadmap): dynamic loader

In v2, chalkbag will support a dynamic provider loader. Users will be able to declare a third-party provider in `.chalk/config.yaml` without forking the repo:

```yaml
# planned shape — not yet implemented
providers:
  - package: chalkbag-provider-cursor
    version: "^1.0.0"
    id: cursor
```

The package would export a `Provider` object matching the same interface as first-party providers. chalkbag would resolve and load it at build time.

This is not yet implemented. Until the v2 dynamic loader ships, the fork + PR workflow above is the only way to add a provider.

---

## Provider interface reference

The types below are defined in `chalkbag/src/providers/_plugin.ts`.

### `Provider`

```ts
export type Provider = {
  id: ProviderId;
  displayName: string;
  render: (context: ProviderRenderContext) => GeneratedOutput[];
};
```

- `id`: must match an entry in `providerIds` in `registry.ts`.
- `displayName`: human-readable name shown in build output and `chalkbag paths`.
- `render`: called once per build. Must be synchronous. Must not throw on recoverable issues — use `context.reportWarning` instead.

### `ProviderRenderContext`

```ts
export type ProviderRenderContext = {
  repo: LoadedAgentsRepo;
  enabledProviders: ProviderId[];
  reportWarning: (warning: string) => void;
};
```

- `repo`: the fully loaded and validated agents spec for the target repo. Contains the resolved `AGENTS.md` content, skills, subagents, permissions, and config.
- `enabledProviders`: the list of provider ids that were requested for this build. Use this to skip rendering features that depend on another provider being present.
- `reportWarning`: call this instead of throwing for non-fatal issues. Warnings are printed to stderr and recorded in the build summary.

### `GeneratedOutput`

`render` returns a list of `GeneratedOutput` items. Each item is either a file or a symlink:

```ts
export type GeneratedFile = {
  kind: 'file';
  path: string;       // repo-relative output path (e.g. ".myprovider/foo.md"); must not escape the repo root
  content: string;
  sourcePath: string; // source file that produced this output (for attribution)
};

export type GeneratedSymlink = {
  kind: 'symlink';
  path: string;       // repo-relative output path
  target: string;     // symlink target (relative path recommended)
  sourcePath: string;
};

export type GeneratedOutput = GeneratedFile | GeneratedSymlink;
```

All output paths are validated before writing. A path that resolves outside the repo root will cause a `config` error and abort the build. See [errors.md — config](./errors.md#config).
