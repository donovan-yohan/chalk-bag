# chalkbag agents spec

This document describes the `.agents/` source-of-truth model that chalkbag reads and compiles. It covers how instructions, skills, subagents, and permissions are organized, how they are built, and what each provider receives.

For how to set up a repo or machine, see [onboarding.md](./onboarding.md).

---

## 1. Goals

1. **Make repo instructions native.** Root and scoped `AGENTS.md` files live directly in the repo as committed artifacts. Claude compatibility is handled through committed `CLAUDE.md -> AGENTS.md` symlinks instead of compiled instruction Markdown.
2. **Make skills shared-first.** Skill content lives once under `.agents/skills/` using the standard `SKILL.md` shape. Codex reads those files natively; Claude gets a projected `.claude/skills/` tree.
3. **Keep subagents compiled.** Subagents require vendor-specific output formats, so chalkbag maintains a shared source directory and compiles vendor-native artifacts into gitignored folders.
4. **Keep permissions compiled.** `.agents/permissions.yaml` compiles into provider-native config and stays gitignored.
5. **Remove `commands` as a first-class source concept.** Explicit invocation comes from vendor-native skill surfaces (`/skill` in Claude, `$skill` in Codex), not from a separate command abstraction.

---

## 2. Source-of-truth layout

Everything that feeds chalkbag lives in `.agents/` plus the tracked root files:

```text
<repo>/
├── AGENTS.md                  # tracked, repo-level instruction source of truth
├── CLAUDE.md -> AGENTS.md     # tracked symlink (add when claude is enabled)
├── <scoped-dir>/AGENTS.md     # tracked, optional scoped guidance
├── <scoped-dir>/CLAUDE.md -> AGENTS.md
└── .agents/
    ├── providers.yaml         # required; declares enabled providers
    ├── permissions.yaml       # optional; DSL for per-provider permissions
    ├── config.yaml            # optional; external import declarations
    ├── skills/
    │   └── <skill-name>/
    │       ├── SKILL.md
    │       ├── references/
    │       ├── scripts/
    │       └── examples/
    └── subagents/
        └── <name>.md
```

Key points:

- `AGENTS.md` at the repo root is the canonical instruction file.
- Scoped `AGENTS.md` files apply to subdirectories and are committed normally.
- Every `AGENTS.md` that Claude should see needs a sibling `CLAUDE.md` symlink pointing to it.
- `.agents/AGENTS.md`, `.agents/rules/`, and `.agents/commands/` are not supported — see [section 10](#10-what-is-explicitly-out).

---

## 3. Instructions model

### Tracked `AGENTS.md`

Repo instructions live as a committed `AGENTS.md` at the root and in any directory that needs scoped guidance. Codex and the broader agent ecosystem read `AGENTS.md` natively without any compile step.

### `CLAUDE.md` symlink

Claude discovers `CLAUDE.md`, not `AGENTS.md`. A `CLAUDE.md -> AGENTS.md` symlink in the same directory satisfies Claude without duplicating content.

Create the root symlink:

```bash
cd ~/your-repo && ln -sf AGENTS.md CLAUDE.md
```

For a scoped directory:

```bash
cd ~/your-repo/packages/server && ln -sf AGENTS.md CLAUDE.md
```

The `CLAUDE.md` symlink is committed to source control. It is not a chalkbag output — chalkbag does not create or manage it.

### CI / lint expectation

Repos that adopt this model should add a CI step that fails if any `CLAUDE.md` is a regular file rather than a symlink. This catches direct edits to `CLAUDE.md` and drift where Claude instructions no longer match `AGENTS.md`.

```bash
bad_paths="$(find . \
  -path '*/.git' -prune -o \
  -path '*/node_modules' -prune -o \
  -name CLAUDE.md ! -type l -print)"

if [ -n "$bad_paths" ]; then
  echo "Expected every CLAUDE.md to be a symlink to AGENTS.md:"
  echo "$bad_paths"
  exit 1
fi
```

This lint belongs in the target repo CI, not inside chalkbag build output.

---

## 4. Skills model

### Shared source

Skills are defined once under `.agents/skills/<skill-name>/` using the standard `SKILL.md` shape:

```text
.agents/skills/<skill-name>/
├── SKILL.md
├── references/
├── scripts/
└── examples/
```

`SKILL.md` is the canonical description and instruction entrypoint. The surrounding bundle (references, scripts, examples) is preserved as-is.

### Vendor behavior

- **Codex:** reads `.agents/skills/` natively. No compile step needed.
- **Claude:** expects `.claude/skills/`, so `chalkbag build` projects `.agents/skills/` into `.claude/skills/`. The full bundle is copied, not just `SKILL.md`, so colocated files remain available.
- **OpenCode:** per provider spec in `providers/opencode.ts`.

### Explicit invocation surface

Skills provide explicit invocation where the vendor supports it:

- Claude: `/skill-name`
- Codex: `$skill-name`

chalkbag does not need a separate command definition type for explicit invocation.

---

## 5. Subagents model

### Shared source

Subagents live under `.agents/subagents/` as Markdown files:

```text
.agents/subagents/
└── code-reviewer.md
```

The shared source captures the durable intent:

- name
- description
- optional model / tool preferences
- shared prompt body

Frontmatter keys are validated at build time — see `src/spec/schema.ts`.

### Why compile is still needed

Claude and Codex do not consume the same subagent format:

- **Claude:** Markdown files in `.claude/agents/*.md`
- **Codex:** TOML files in `.codex/agents/*.toml`

So subagents remain a real compiler boundary.

### Compiler contract

`chalkbag build` will:

1. Read `.agents/subagents/*.md`
2. Validate the shared frontmatter/body shape
3. Emit Claude-native agents into `.claude/agents/`
4. Emit Codex-native agents into `.codex/agents/`

Never hand-edit the emitted `.claude/agents/*` or `.codex/agents/*` files directly; the next build overwrites them.

---

## 6. Permissions

### Source

```text
.agents/permissions.yaml
```

This is the single source of truth for what the AI agent is allowed to do in this repo.

### DSL fields

| Field | Type | Description |
|---|---|---|
| `bash` | `string[]` | Shell command globs the agent may run |
| `read` | `string[]` | File path globs the agent may read |
| `write` | `string[]` | File path globs the agent may write |
| `webfetch` | `string[]` | URL prefixes the agent may fetch |
| `mcp` | object | MCP server permissions (Claude only; ignored by Codex) |
| `defaultMode` | `string` | Default interaction mode (`normal`, `auto`, etc.) |
| `sandbox` | `boolean` | Whether to enable sandbox mode |

### Compiled outputs (all gitignored)

| Provider | Output path |
|---|---|
| Claude | `.claude/settings.json` |
| Codex | `.codex/config.toml` |
| OpenCode | `opencode.json`, `.opencode/` |

chalkbag does not change the permissions DSL or its provider translation logic. The compiler enforces that these outputs stay gitignored.

### Example `permissions.yaml`

```yaml
bash:
  - "npm run *"
  - "git status"
  - "git diff"
read:
  - "src/**"
  - "package.json"
write:
  - "src/**"
webfetch:
  - "https://docs.example.com"
defaultMode: auto
```

---

## 7. External imports

### Declaring imports

Add a `.agents/config.yaml` to reference skills or subagents from external GitHub sources:

```yaml
imports:
  - source: github:<org>/<repo>
    ref: v1.2.0
    path: skills/oncall
```

Fields:

- `source`: `github:<org>/<repo>` — only GitHub sources are supported in v1.
- `ref`: branch, tag, or commit SHA.
- `path`: path within the remote repo to import. Must not contain `..`, absolute paths, or control characters.

### Merge precedence

Local files in `.agents/` always win over imported files. Imports fill in what is not defined locally.

### Cache location

Imported files are cached under `~/.cache/chalkbag/imports`. Clear the cache with:

```bash
chalkbag cache clear
```

---

## 8. Build contract

### Tracked (committed to source control)

- Root `AGENTS.md`
- Root `CLAUDE.md` symlink
- Scoped `AGENTS.md` files
- Scoped `CLAUDE.md` symlinks
- `.agents/providers.yaml`
- `.agents/permissions.yaml` (optional)
- `.agents/config.yaml` (optional)
- `.agents/skills/**`
- `.agents/subagents/**`

### Gitignored (generated by chalkbag)

- `.claude/**`
- `.codex/**`
- `.opencode/**`
- `opencode.json`

### What `chalkbag build` does

1. Validates `.agents/providers.yaml`, `.agents/permissions.yaml`, `.agents/skills/**`, `.agents/subagents/**`
2. Resolves and merges any external imports declared in `.agents/config.yaml`
3. Projects skills into `.claude/skills/**`
4. Compiles subagents into `.claude/agents/**` and `.codex/agents/**`
5. Compiles permissions into provider-native config
6. Enforces gitignore entries for compiled folders

chalkbag does **not** create or manage tracked `AGENTS.md` content or `CLAUDE.md` symlinks as generated outputs. Those are your responsibility.

### Lock file

`chalkbag build` uses `.agents/.state.lock` to prevent concurrent renders. If a build is interrupted abnormally, remove the stale lock:

```bash
cd ~/your-repo && rm .agents/.state.lock
```

See [troubleshooting.md](./troubleshooting.md#lock-stale) for more.

---

## 9. Provider plugin contract

### Interface

Each provider is a TypeScript module exporting a `Provider` object:

```ts
export type Provider = {
  id: ProviderId;
  displayName: string;
  render: (context: ProviderRenderContext) => GeneratedOutput[];
};
```

`render` receives a `ProviderRenderContext`:

```ts
export type ProviderRenderContext = {
  repo: LoadedAgentsRepo;
  enabledProviders: ProviderId[];
  reportWarning: (warning: string) => void;
};
```

`render` returns a list of `GeneratedOutput` items:

```ts
export type GeneratedFile = {
  kind: 'file';
  path: string;       // repo-relative output path (e.g. ".claude/agents/foo.md"); must not escape the repo root
  content: string;
  sourcePath: string; // source file that produced this output
};

export type GeneratedSymlink = {
  kind: 'symlink';
  path: string;       // repo-relative output path
  target: string;
  sourcePath: string;
};

export type GeneratedOutput = GeneratedFile | GeneratedSymlink;
```

The full type definitions live in `src/providers/_plugin.ts`.

### First-party providers

All first-party providers are registered in `src/providers/registry.ts` under `firstPartyProviderDefinitions`. Each entry declares the provider module and the gitignored artifact paths it owns.

### Adding a provider

See [extending.md](./extending.md) for step-by-step instructions. A dynamic third-party loader is planned for v2 but not yet implemented.

---

## 10. What is explicitly out

The following concepts are not supported by chalkbag and will cause a validation error if present:

| Path / feature | Why excluded |
|---|---|
| `.agents/commands/` | Claude's extension surface is skills; commands add abstraction with no benefit |
| `.agents/rules/` | Rules compiled into `AGENTS.md` are replaced by tracked native `AGENTS.md` files |
| `.fullstack-agents/` | Workspace-root special case from xt agents; chalkbag is single-repo only |
| `WORKSPACE_ROOT` env / fullstack mode | No workspace root concept in chalkbag |

If `chalkbag validate` finds these directories, it will report an error pointing here.
