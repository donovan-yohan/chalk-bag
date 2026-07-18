# chalkbag agents spec

This document describes the `.chalk/` source-of-truth model that chalkbag reads and compiles. It covers how instructions, skills, and permissions are organized, how they are built, and what each provider receives.

For how to set up a repo or machine, see [onboarding.md](./onboarding.md).

---

## 1. Goals

1. **Make repo instructions native.** Root and scoped `AGENTS.md` files live directly in the repo as committed artifacts. Claude compatibility is handled through committed `CLAUDE.md -> AGENTS.md` symlinks instead of compiled instruction Markdown.
2. **Make skills shared-first.** Skill content lives once under `.chalk/skills/` using the standard `SKILL.md` shape. Codex reads those files natively; Claude gets a projected `.claude/skills/` tree.
3. **Keep permissions compiled.** `.chalk/permissions.yaml` compiles into provider-native config and stays gitignored.
4. **Remove `commands` as a first-class source concept.** Explicit invocation comes from vendor-native skill surfaces (`/skill` in Claude, `$skill` in Codex), not from a separate command abstraction.

---

## 2. Source-of-truth layout

Everything that feeds chalkbag lives in `.chalk/` plus the tracked root files:

```text
<repo>/
├── AGENTS.md                  # tracked, repo-level instruction source of truth
├── CLAUDE.md -> AGENTS.md     # tracked symlink (add when claude is enabled)
├── <scoped-dir>/AGENTS.md     # tracked, optional scoped guidance
├── <scoped-dir>/CLAUDE.md -> AGENTS.md
└── .chalk/
    ├── providers.yaml         # required; declares enabled providers
    ├── permissions.yaml       # optional; DSL for per-provider permissions
    ├── config.yaml            # optional; external import declarations
    └── skills/
        └── <skill-name>/
            ├── SKILL.md
            ├── references/
            ├── scripts/
            └── examples/
```

Key points:

- `AGENTS.md` at the repo root is the canonical instruction file.
- Scoped `AGENTS.md` files apply to subdirectories and are committed normally.
- Every `AGENTS.md` that Claude should see needs a sibling `CLAUDE.md` symlink pointing to it.
- `.chalk/AGENTS.md`, `.chalk/rules/`, `.chalk/commands/`, and `.chalk/subagents/` are not supported — see [section 9](#9-what-is-explicitly-out).

---

## 3. Instructions model

### Tracked `AGENTS.md`

Repo instructions live as a committed `AGENTS.md` at the root and in any directory that needs scoped guidance. Codex and the broader agent ecosystem read `AGENTS.md` natively without any compile step.

Write each `AGENTS.md` as a navigation map rather than documentation, and push knowledge down to the deepest directory it applies to. For the authoring doctrine — map-not-README, size budget, and scoped-file placement — see [authoring-agents-md.md](./authoring-agents-md.md).

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

Skills are defined once under `.chalk/skills/<skill-name>/` using the standard `SKILL.md` shape:

```text
.chalk/skills/<skill-name>/
├── SKILL.md
├── references/
├── scripts/
└── examples/
```

`SKILL.md` is the canonical description and instruction entrypoint. The surrounding bundle (references, scripts, examples) is preserved as-is.

### Vendor behavior

- **AGENTS.md spec readers (Codex hierarchical scan, etc.):** chalkbag mirrors `.chalk/skills/` into a gitignored `.agents/skills/` tree on every build, which the spec's hierarchical discovery picks up natively.
- **Claude:** expects `.claude/skills/`, so `chalkbag build` projects `.chalk/skills/` into `.claude/skills/`. The full bundle is copied, not just `SKILL.md`, so colocated files remain available.
- **OpenCode:** per provider spec in `providers/opencode.ts`.

### Explicit invocation surface

Skills provide explicit invocation where the vendor supports it:

- Claude: `/skill-name`
- Codex: `$skill-name`

chalkbag does not need a separate command definition type for explicit invocation.

---

## 5. Permissions

### Source

```text
.chalk/permissions.yaml
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

## 6. External imports

### Declaring imports

Add a `.chalk/config.yaml` to reference skills from external GitHub sources:

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

Local files in `.chalk/` always win over imported files. Imports fill in what is not defined locally.

### Cache location

Imported files are cached under `~/.cache/chalkbag/imports`. Clear the cache with:

```bash
chalkbag cache clear
```

---

## 7. Build contract

### Tracked (committed to source control)

- Root `AGENTS.md`
- Root `CLAUDE.md` symlink
- Scoped `AGENTS.md` files
- Scoped `CLAUDE.md` symlinks
- `.chalk/providers.yaml`
- `.chalk/permissions.yaml` (optional)
- `.chalk/config.yaml` (optional)
- `.chalk/skills/**`

### Gitignored (generated by chalkbag)

- `.claude/**`
- `.codex/**`
- `.opencode/**`
- `opencode.json`

### What `chalkbag build` does

1. Validates `.chalk/providers.yaml`, `.chalk/permissions.yaml`, `.chalk/skills/**`
2. Resolves and merges any external imports declared in `.chalk/config.yaml`
3. Projects skills into `.claude/skills/**` and the `.agents/skills/**` mirror
4. Compiles permissions into provider-native config
5. Enforces gitignore entries for compiled folders

chalkbag does **not** create or manage tracked `AGENTS.md` content or `CLAUDE.md` symlinks as generated outputs. Those are your responsibility.

### Lock file

`chalkbag build` uses `.chalk/.state.lock` to prevent concurrent renders. If a build is interrupted abnormally, remove the stale lock:

```bash
cd ~/your-repo && rm .chalk/.state.lock
```

See [troubleshooting.md](./troubleshooting.md#lock-stale) for more.

---

## 8. Provider plugin contract

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
  path: string;       // repo-relative output path (e.g. ".claude/skills/foo/SKILL.md"); must not escape the repo root
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

## 9. What is explicitly out

The following concepts are not supported by chalkbag and will cause a validation error if present:

| Path / feature | Why excluded |
|---|---|
| `.chalk/commands/` | Claude's extension surface is skills; commands add abstraction with no benefit |
| `.chalk/rules/` | Rules compiled into `AGENTS.md` are replaced by tracked native `AGENTS.md` files |
| `.chalk/subagents/` | Subagents removed from scope; use provider-native agent definitions |
| `.fullstack-agents/` | Workspace-root special case from xt agents; chalkbag is single-repo only |
| `WORKSPACE_ROOT` env / fullstack mode | No workspace root concept in chalkbag |

If `chalkbag validate` finds these directories, it will report an error pointing here.

---

## 10. Global scope (machine-level `~/.chalk/`)

Everything above describes **repo scope**: a per-repository `.chalk/` tree compiled into per-repo provider configs. chalkbag also supports a machine-level **global scope** that applies the same model to your home directory: a `~/.chalk/` source tree compiled into your user-level Claude and Codex config. Repo scope always overrides global scope for work done inside a repo.

Global scope is opt-in through the `--global` flag on `init`, `build`, `validate`, and `clean`.

### Layout

```text
~/.chalk/
├── providers.yaml         # required; only claude + codex are meaningful globally
├── permissions.yaml       # optional; machine-wide permission rules
├── AGENTS.md              # the machine-level context file (lives INSIDE ~/.chalk/)
└── skills/
    └── <skill-name>/…     # machine-wide skills
```

Unlike repo scope — where the root `AGENTS.md` is a tracked file at the repo root and `.chalk/AGENTS.md` is forbidden — the global context file *is* `~/.chalk/AGENTS.md`. There is no git working tree at `~`, so chalkbag manages the context file placement itself via bridge symlinks.

### Compiled outputs

| Source | Output | Notes |
|---|---|---|
| `~/.chalk/skills/**` | `~/.claude/skills/**` and `~/.agents/skills/**` | `~/.agents/skills/` is the documented Codex / AGENTS.md-spec **user-level** skill dir |
| `~/.chalk/permissions.yaml` | merged `~/.claude/settings.json` | array rules are **unioned** with your existing entries — never dropped |
| `~/.chalk/permissions.yaml` | managed block in `~/.codex/config.toml` | see below |
| `~/.chalk/AGENTS.md` | `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` symlinks | bridging, see below |

> **Warning — the global settings.json union is one-way (no revoke).** Because the `~/.claude/settings.json` merge *unions* rules rather than replacing them, chalkbag never removes a permission from that file. Once a rule has been unioned in, **deleting it from `~/.chalk/permissions.yaml` does not remove it from `~/.claude/settings.json`, and neither does `chalkbag clean --global`.** To actually revoke a global rule, edit `~/.claude/settings.json` by hand and delete the entry. (This one-way behavior is deliberate: global settings.json is your real file, so chalkbag only ever adds, never drops, entries it did not author.)

### Context-file bridging

chalkbag creates two symlinks pointing at `~/.chalk/AGENTS.md`:

- `~/.claude/CLAUDE.md -> ~/.chalk/AGENTS.md`
- `~/.codex/AGENTS.md -> ~/.chalk/AGENTS.md`

If either target already exists as a **regular file with content**, chalkbag refuses to overwrite it and fails the build with an actionable error: merge your existing content into `~/.chalk/AGENTS.md`, remove or rename the conflicting file, then re-run. An empty file is replaced; an already-correct symlink is left alone (idempotent).

### The `~/.codex/config.toml` managed block

`~/.codex/config.toml` is Codex's real primary config file, owned by you. chalkbag never rewrites it wholesale. Instead it owns only the lines between marker comments and preserves everything outside them byte-for-byte:

```toml
# >>> chalkbag managed — do not edit inside >>>
# generated by chalkbag
sandbox_mode = "workspace-write"
approval_policy = "on-request"
…
# <<< chalkbag managed <<<
```

On rebuild the marked region is replaced in place (appended if absent). The repo-only `[projects."<name>"]` trust block is **not** emitted globally (there is no project root to trust).

### What global scope skips vs repo scope

| Repo-only machinery | Why it is skipped globally |
|---|---|
| `.gitignore` enforcement + git hooks | `~` is not a git repo |
| `.codex/config.toml` written wholesale | replaced by the managed-block writer |
| `[projects."<slug>"]` codex trust block + repo-slug `.codex/rules/` file | no project root; bash prefix rules are not emitted (a warning is surfaced) |
| opencode provider | global scope targets claude + codex only |
| root `AGENTS.md` at the source root | the context file lives at `~/.chalk/AGENTS.md` and is bridged, not tracked |

### `clean --global` safety

`chalkbag clean --global` removes only chalkbag-written outputs and never your own config files:

- skill projections (`~/.claude/skills/**`, `~/.agents/skills/**`) that chalkbag wrote are removed via the manifest;
- the codex managed block reverts to absent (the rest of `~/.codex/config.toml` is preserved);
- the bridge symlinks are removed **only if they still point at `~/.chalk/AGENTS.md`**;
- `~/.claude/settings.json` is left untouched — chalkbag merged into it and will not delete it.
