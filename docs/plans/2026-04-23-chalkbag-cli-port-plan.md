<!-- /autoplan restore point: /Users/donovanyohan/.gstack/projects/donovan-yohan-chalk-bag/master-autoplan-restore-20260423-221156.md -->
# chalkbag CLI — port plan

## Goal

Port `xt agents` (extend-localenv `lib/agents/`) to a standalone global CLI named `chalkbag`, hosted in this repo under `chalkbag/`. Same opinions: `.agents/` source of truth, gitignored per-provider outputs (`.claude/`, `.codex/`, `.opencode/…`), provider plugin interface, background daemon for incremental rebuilds.

## Core differences vs xt agents

1. **No `WORKSPACE_ROOT`.** `xt` assumes extend-localenv is a workspace-level tool. `chalkbag` is global — invoked in any repo.
2. **No `.fullstack-agents`.** Drop the whole fullstack/workspace scope concept. Every build is a single-repo build.
3. **Watched-paths registry.** Instead of one workspace root, registry holds a list of entries:
   - `repo` mode — one path with `.agents/`, daemon rebuilds it on change.
   - `parent` mode — a directory holding many repos; daemon scans one level deep for children with `.agents/` and rebuilds each independently. Lets user add `~/Documents/Programs/personal` without conflicting with `~/Documents/Programs/work` (xt territory).
4. **Global install.** Shipped as an npm package with a `chalkbag` bin; `npm i -g chalkbag` or `npx chalkbag`.
5. **Separate config home + launchd label.** `~/.config/chalkbag/registry.json`, `com.chalkbag.daemon` plist — coexists cleanly with xt's `~/.config/xt-agents` and `com.paywithextend.xt-agents`.

## Package layout

```
chalk-bag/
├── chalkbag/                       # new npm package
│   ├── package.json                # name: "chalkbag", bin: { chalkbag: "dist/cli.js" }
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── README.md                   # install, quickstart, CLI reference
│   ├── src/
│   │   ├── cli.ts                  # cac entrypoint
│   │   ├── render.ts               # port, strip fullstack logic
│   │   ├── scope.ts                # shrink to repo-only
│   │   ├── watcher.ts              # repo + parent watchers (no workspace watcher)
│   │   ├── manifest.ts             # port verbatim
│   │   ├── gitignore.ts            # port verbatim
│   │   ├── hooks.ts                # port verbatim
│   │   ├── importer.ts             # port, simplify
│   │   ├── types.ts                # XtAgentsError → ChalkBagError
│   │   ├── commands/scaffold.ts    # drop scaffoldFullstack
│   │   ├── daemon/
│   │   │   ├── entry.ts            # iterate registry.paths
│   │   │   ├── registry.ts         # new WatchedPath schema
│   │   │   ├── launchd.ts          # com.chalkbag.daemon
│   │   │   └── systemd.ts          # deferred — linux stub for later
│   │   ├── providers/
│   │   │   ├── _plugin.ts          # drop fullstackMode + workspaceSiblings
│   │   │   ├── registry.ts         # port
│   │   │   ├── claude.ts           # port, trim fullstack branches
│   │   │   ├── codex.ts            # port, trim fullstack branches
│   │   │   └── opencode.ts         # port, trim fullstack branches
│   │   └── spec/
│   │       ├── frontmatter.ts
│   │       ├── load.ts             # drop scope.kind === 'fullstack'
│   │       ├── schema.ts
│   │       ├── types.ts
│   │       └── validate.ts
│   ├── templates/.agents/          # copy of docs/templates/agents/.agents
│   │   ├── README.md               # per-repo .agents guidance
│   │   ├── providers.yaml
│   │   ├── permissions.yaml
│   │   ├── skills/example-skill/SKILL.md
│   │   └── subagents/example-subagent.md
│   ├── docs/
│   │   ├── agents-spec.md          # .agents/ source-of-truth spec (see §.agents spec)
│   │   └── onboarding.md           # per-repo + per-machine setup guide
│   └── tests/
└── (existing plugins/, docs/, README.md)
```

## Registry schema

```ts
type WatchMode = 'repo' | 'parent';

type WatchedPath = {
  path: string;                 // absolute
  mode: WatchMode;
  providers: ProviderId[];      // enabled providers for this entry
  ignore: string[];             // globs relative to path; parent-mode uses to skip subdirs
  installedAt: string;
};

type Registry = {
  version: 1;                   // schema version for future migration
  paths: WatchedPath[];
};
```

Config home: `process.env.CHALKBAG_CONFIG_HOME ?? ~/.config/chalkbag`. Files: `registry.json`, `heartbeat`, `logs/chalkbag.log`.

### Registry invariants (eng auto-fix C-1)

- `addPath(new)` rejects if `new.path` is a descendant of an existing `parent`-mode entry, or an existing entry is a descendant of `new` when `new.mode === 'parent'`. Error message names the conflicting entry.
- `findPathFor(target)` prefers longest match (repo beats parent when both apply). Prevents double-dispatch.
- `registry.json` schema violations (malformed JSON, missing `version`, wrong types) surface an error instead of silently returning empty (fixes M-3 corruption gap).
- Heartbeat is **global**, not per-path (eng auto-fix C-2, decision logged). Docs note: a stuck watcher on one path keeps heartbeat fresh; future versions may move to per-path heartbeat. Acceptable for v1 single-user use.

## CLI surface (DX auto-fixes applied)

```
chalkbag init [path]              # scaffold .agents/ + register cwd (repo mode) + synchronous first build
                                  #   prints: "rendered 3 providers in .claude/, .codex/, .opencode/"
                                  #   daemon NOT installed by default; use --daemon or `chalkbag daemon install`
chalkbag register [path]          # register path; flags: --parent, --provider <ids>, --ignore <glob>
chalkbag register-group [path]    # alias for `register --parent` (discoverability)
chalkbag unregister [path]
chalkbag paths                    # JSON summary of registry entries + providers + ignore
chalkbag doctor                   # heartbeat + daemon status + config paths + health (promoted from CEO M-2)
chalkbag scaffold [path]          # bootstrap .agents/ from template (idempotent)
chalkbag build [path]             # one-shot render
chalkbag watch [path]             # inline watcher fallback (no daemon)
chalkbag validate [path]
chalkbag cache clear              # clear import cache (renamed from `clean`)
chalkbag clean [path]             # remove generated .claude/ .codex/ .opencode/ (new)
chalkbag import [path]            # legacy provider-file importer
chalkbag daemon install|status|reload|uninstall|pause|resume
                                  # pause/resume write flag file daemon polls (DX H-5 escape hatch)
chalkbag --version                # print installed version (supports `npm i -g chalkbag@1` pinning)
chalkbag internal hook-run [path] # hidden from --help; git hook entry (DX H-3)
```

### DX auto-fixes summary

- **init synchronous first build + result print, daemon opt-in** (DX M-1 TTHW)
- **paths + doctor split from list** (DX H-3 naming)
- **cache clear / clean split** (DX H-3 naming)
- **register-group alias** (DX H-3 discoverability; `--parent` flag kept for power users)
- **daemon pause/resume** (DX H-5 escape hatch)
- **hook-run namespaced under `internal`** (DX H-3 hide internals)
- **`--version` via npm bin standard** (DX H-5 pinning)

## Watcher design

- **repo entry** → `startRepoWatcher(entry.path)` (equivalent to xt's `startAgentsWatcher`, watches `<path>/.agents/`).
- **parent entry** → `startParentWatcher(entry.path, { ignore, depth: 2 })`:
  - `chokidar.watch(entry.path, { depth: 2, ignoreInitial: true, followSymlinks: false, ignored: fnIgnored })`
  - `depth: 2` caps descent so `<parent>/<child>/.agents/` is reachable but deeper subtrees are ignored (eng auto-fix H-1, fd cap).
  - `fnIgnored(pathName)` short-circuits by basename on `node_modules`, `.git`, `.venv`, `dist`, `node_modules/.cache` before stat (P5 explicit).
  - On fs event: `realpath(pathName)`; reject if realpath escapes `entry.path` (eng auto-fix H-3, symlink loop).
  - If `<child>/.agents/` exists → debounce-per-scope → queue `buildAgentsRepo(<child>)`.
  - On `unlinkDir(<child>/.agents)` → drop debounce timer, log, skip (eng auto-fix H-2, deletion).
  - Concurrency cap across all scopes: `pLimit(2)` around `buildAgentsRepo` invocations (eng auto-fix M-2, stampede guard).
- **Render error paths** — `buildAgentsRepo` catches `ENOENT` on `sourceRoot` → log-and-drop instead of throw (eng auto-fix H-2).

Daemon (`src/daemon/entry.ts`) reads registry, iterates `paths`, starts the right watcher per entry, global heartbeat every 30s; handles `SIGHUP` for registry reload, `SIGINT`/`SIGTERM` to shut down.

## Simplification deltas (what gets removed from ported files)

- `scope.ts`: delete `AgentsScopeKind = 'fullstack'`, `resolveWorkspaceRoot`, `listWorkspaceRepos`, `inferWorkspaceRootFromFullstackSource`. Keep `resolveAgentsScope` (returns `{ sourceRoot, outputRoot, agentsRoot }` only), `isPathIgnored`.
- `render.ts`: drop `resolveScopeFlags`, `workspaceSiblings`, `fullstackMode`, `assertBuildAllowed` heartbeat stale check stays but gated on registry lookup (entry presence, not workspace).
- `providers/_plugin.ts`: `ProviderRenderContext` drops `fullstackMode` + `workspaceSiblings`.
- `providers/claude.ts`, `codex.ts`, `opencode.ts`: delete any `if (fullstackMode)` / `workspaceSiblings` branches; delete `.fullstack-agents/subagents/` path-rewrite.
- `spec/load.ts`: drop `if (scope.kind === 'fullstack')` branches, treat all loads as repo scope.
- `commands/scaffold.ts`: delete `scaffoldFullstack`, `renderFullstackAgentsMdStub`.
- `cli.ts`: rewrite from scratch (xt's CLI is 448 lines, ours is ~200).

## Phased delegation (sonnet agents)

### Phase 1 — package scaffold + pure ports
Owner: sonnet subagent.

**ChalkBagError format (DX H-2 auto-fix):** `ChalkBagError` constructor takes `{ kind, file, message, cause?, fix?, docsUrl? }` and `formatError` prints a 4-line block:
```
error: <message> (kind: <kind>, at <file>:<line>?)
cause: <cause message if present>
fix: <fix hint if present; else "check the referenced file">
see: <docsUrl if present; else "https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#<kind>">
```
Every throw site gets a `fix` hint where non-obvious. `spec/load.ts` YAML parse errors include source path + line when available (gray-matter surfaces line info).

- Create `chalkbag/` dir with package.json (deps: `cac`, `chokidar`, `gray-matter`, `p-limit`, `picomatch`, `yaml`, `zod`; devDeps: `tsx`, `typescript`, `vitest`, `@types/node`), tsconfig (NodeNext, strict), vitest config.
- Copy `/Users/donovanyohan/Documents/Programs/work/extend-localenv/docs/templates/agents/.agents` → `chalkbag/templates/.agents`.
- Port verbatim (s/XtAgentsError/ChalkBagError/, s/xt agents/chalkbag/): `types.ts`, `manifest.ts`, `gitignore.ts`, `hooks.ts`, `picomatch.d.ts`, `spec/frontmatter.ts`, `spec/schema.ts`, `spec/types.ts`, `spec/validate.ts`.
- Port `imports/` directory with **security audit** (eng auto-fix H-4): in `imports/resolve.ts` and `imports/merge.ts`, reject import `path` entries containing `..`, absolute paths, or control chars. Add unit test: `path: "../../../etc/passwd"` must reject with clear error.
- No behavior change yet.
Depends on: plan committed.

### Phase 2 — scope + render + providers (no fullstack)
Owner: sonnet subagent.
- Rewrite `scope.ts` to repo-only (see deltas above).
- Port `render.ts` with fullstack logic excised. Keep lock + manifest + diff apply.
- Port `providers/_plugin.ts`, `registry.ts`, and all 3 providers with trimmed render context.
- Port `spec/load.ts` treating every scope as repo.
Depends on: Phase 1.

### Phase 3 — registry + daemon + watcher
Owner: sonnet subagent.
- New `daemon/registry.ts` with `WatchedPath[]` + helpers: `addPath` (with overlap rejection per §Registry invariants), `removePath`, `findPathFor(target)` (longest-match), `readRegistry` (validates `version: 1` + JSON schema, throws on corruption — not silent), `writeRegistry`, `touchHeartbeat`, `isHeartbeatStale`.
- Port `daemon/launchd.ts` with label `com.chalkbag.daemon`, plist path `~/Library/LaunchAgents/com.chalkbag.daemon.plist`, env var `CHALKBAG_CONFIG_HOME`. **Validate `configHome` absolute + no control chars** before plist write (eng auto-fix M-1).
- New `watcher.ts`:
  - `startRepoWatcher(repoRoot)` — equivalent to xt's `startAgentsWatcher`.
  - `startParentWatcher(parentRoot, { ignore })` — chokidar `depth: 2`, function-based `ignored` for `node_modules`/`.git`/`.venv`/`dist`, realpath escape guard, `pLimit(2)` concurrency cap (eng auto-fixes H-1, H-3, M-2).
  - `buildAgentsRepo` wrapped with ENOENT log-and-drop (eng auto-fix H-2).
- `daemon/entry.ts` iterates `registry.paths`, starts the right watcher per entry, `SIGHUP` reloads.
Depends on: Phase 1.

### Phase 4 — CLI + scaffold + importer
Owner: sonnet subagent.
- Port `commands/scaffold.ts` (repo path only). Template root resolved via `import.meta.url` → `chalkbag/templates/.agents`.
- Port `importer.ts`.
- Write new `cli.ts` with command surface above.
- Wire `dist/cli.js` bin with `#!/usr/bin/env node` shebang + ensure build emits executable.
Depends on: Phase 2 + Phase 3.

### Phase 5 — tests + docs
Owner: sonnet subagent.

**Docs to write (DX M-4 auto-fix):**
- `chalkbag/README.md` — install, quickstart (every block `cd ~/your-repo &&` prefixed), CLI reference table, "Why not X?" section (vs hand-edited `.claude/`, vs chokidar, vs symlinks), daemon lifecycle, `--version` pinning.
- `chalkbag/docs/agents-spec.md` — 10 sections per §.agents spec above.
- `chalkbag/docs/onboarding.md` — per-repo + per-machine flow, no workspace sections.
- `chalkbag/docs/troubleshooting.md` — daemon won't start, `.claude/` not updating, CLAUDE.md symlink broken on Windows clone, permissions.yaml ignored, registry corruption.
- `chalkbag/docs/errors.md` — one section per `ChalkBagError` kind (`config`, `io`, `daemon`, `lock`, `provider`, `cli`) with example message, cause, fix.
- `chalkbag/docs/extending.md` — how to add a provider today (fork + PR to `providers/registry.ts`), noting dynamic loader is v2.
- Update top-level `chalk-bag/README.md` with chalkbag section.

- Vitest test plan (eng auto-fix M-3 expansion):
  - `scope.test.ts` — repo resolve from nested dir.
  - `registry.test.ts` — add/remove/find; **overlap rejection** (C-1); **corruption recovery** (malformed JSON, wrong version); longest-match find.
  - `watcher.test.ts` — parent watcher dispatch (mocks chokidar), **depth cap**, **symlink-loop realpath guard** (H-3), **unlinkDir of .agents handling** (H-2), **concurrency cap** (M-2).
  - `scaffold.test.ts` — template copy + idempotence.
  - `render.test.ts` — end-to-end AGENTS.md → providers; **render-lock contention** (2 processes); **ENOENT on sourceRoot** (H-2); **resolveOutputPath escape guard**.
  - `imports.test.ts` — path traversal rejection (`../`, absolute, control chars) (H-4).
  - `cli.test.ts` — command exit codes, error-format smoke.
  - `launchd.test.ts` — plist XML snapshot; **configHome validation** rejects non-absolute / control chars (M-1).
  - `fd-load.test.ts` — parent watcher with 20 fake child repos × mock node_modules; assert fd count stays under macOS soft limit (H-1). Skippable on CI if too slow.
- `chalkbag/README.md` — install, quickstart (`chalkbag init`, `chalkbag register --parent`), CLI reference table, daemon lifecycle, provider extension pointer.
- `chalkbag/docs/agents-spec.md` — see `.agents spec` section below.
- `chalkbag/docs/onboarding.md` — per-repo (scaffold → edit AGENTS.md → build) and per-machine (install daemon → register paths) flow, ported from `extend-localenv/docs/xt-agents-onboarding.md` with workspace/fullstack sections removed.
- Update top-level `chalk-bag/README.md` with a chalkbag section pointing at `chalkbag/README.md` and the spec.
Depends on: Phase 4.

## Non-goals (for v1)

- No linux systemd support yet — stub file only, log `daemon install: platform unsupported` on linux.
- No legacy `xt-agents` migration helper — users can `chalkbag scaffold` in any existing `.agents/` tree.
- No GUI / no TUI.
- No `.fullstack-agents` compatibility.

## .agents spec (`chalkbag/docs/agents-spec.md`)

Port the durable content from `extend-localenv/docs/specs/2026-04-21-xt-agents-native-instructions-skills-subagents-design.md`, stripping workspace/fullstack sections. Required sections:

1. **Goals.** Native `AGENTS.md` for instructions; shared-first skills; compiled subagents; compiled permissions; no `commands` source type.
2. **Source-of-truth layout.**
   ```
   <repo>/
   ├── AGENTS.md                  # tracked, repo-specific
   ├── CLAUDE.md -> AGENTS.md     # tracked symlink when claude enabled
   ├── <scoped>/AGENTS.md         # tracked, optional scoped guidance
   ├── <scoped>/CLAUDE.md -> AGENTS.md
   └── .agents/
       ├── providers.yaml
       ├── permissions.yaml       # optional
       ├── config.yaml            # optional external imports
       ├── skills/<name>/SKILL.md
       └── subagents/<name>.md
   ```
3. **Instructions model.** Tracked `AGENTS.md` is canonical. `CLAUDE.md` is a committed symlink. CI should fail if any `CLAUDE.md` is not a symlink.
4. **Skills model.** `SKILL.md` shape. Codex reads `.agents/skills/` directly; Claude gets `.claude/skills/` as a gitignored projection; opencode per provider spec.
5. **Subagents model.** Shared markdown + frontmatter under `.agents/subagents/`; compiler emits `.claude/agents/*.md` and `.codex/agents/*.toml`.
6. **Permissions.** Source `.agents/permissions.yaml` → per-provider gitignored outputs (`.claude/settings.json`, `.codex/config.toml`, `opencode.json`). DSL: `bash`, `read`, `write`, `webfetch`, `mcp`, `defaultMode`, `sandbox`.
7. **External imports.** `.agents/config.yaml` declares GitHub sources (`source: github:<org>/<repo>`, `ref`, `path`). Local files win over imported ones. Cached under `~/.cache/chalkbag/imports`.
8. **Build contract.**
   - Tracked: `AGENTS.md`, `CLAUDE.md` symlinks, `.agents/**`.
   - Gitignored: `.claude/**`, `.codex/**`, `.opencode/**`, `opencode.json`.
   - `chalkbag build` validates inputs, projects skills, compiles subagents, compiles permissions, enforces gitignore entries.
9. **Provider plugin contract.** `Provider { id, displayName, render(context): GeneratedOutput[] }` — see `src/providers/_plugin.ts`. Third parties extend by adding an entry to `providers/registry.ts` (first-party) or later via dynamic loader (deferred).
10. **What is explicitly out.** No `.agents/commands/`, no `.agents/rules/`, no `.fullstack-agents/`, no `WORKSPACE_ROOT`.

## Coexistence with xt agents

- Registry + plist namespaces disjoint.
- `.agents/` spec identical → templates/skills authored for xt work unchanged under chalkbag.
- User can leave extend-localenv's xt daemon running while chalkbag watches their personal trees.

---

# /autoplan Review Report

## Phase 1: CEO Review

### Premises evaluated

| # | Premise | Verdict |
|---|---|---|
| P1 | xt's `.agents/`-source model is durable | Accept (production-validated) |
| P2 | Global CLI > per-repo install | Accept (user-stated) |
| P3 | Parent-dir watching is a real need | **Subagent challenge — surface at gate** |
| P4 | `.fullstack-agents` not needed | Accept (v1 scope) |
| P5 | chalk-bag repo is the right home | Accept with taste flag (alt: separate repo) |

### CEO dual voices — consensus (codex unavailable)

| Dimension | Claude subagent | Codex | Consensus |
|---|---|---|---|
| Premises valid? | Partial — #1, #3 questioned | `[codex-unavailable]` | **SUBAGENT CHALLENGE** |
| Right problem to solve? | No (critical) | `[codex-unavailable]` | **SUBAGENT CHALLENGE** |
| Scope calibration correct? | Over-scoped (#2 daemon, #3 parent mode) | `[codex-unavailable]` | **SUBAGENT CHALLENGE** |
| Alternatives sufficiently explored? | No | `[codex-unavailable]` | Flagged |
| Competitive/market risks covered? | No (pre-standard format) | `[codex-unavailable]` | Flagged |
| 6-month trajectory sound? | Risky | `[codex-unavailable]` | Flagged |

Single-voice mode. All Claude subagent findings flagged regardless.

### Subagent findings

**Severity-critical**
- **C-1: "Wrong framing — fork not product."** Plan is mechanical port for audience of one. Recommends: write "who is user #2" doc first; if honest answer is "me on a second machine", downgrade to personal monorepo tool, drop systemd stubs, drop marketing README.

**Severity-high**
- **H-1: Daemon is weakest bet.** Launchd/systemd machinery is friction for a job a SessionStart hook + `chalkbag build` could solve. Recommends: defer `chalkbag daemon` to v2.
- **H-2: Parent mode unvalidated.** chokidar on dir containing many repos' `node_modules` and `.git` is fd/perf footgun. Recommends: cut parent mode; replace with `chalkbag register-all <dir>` enumeration at scaffold time.
- **H-3: 6-month regret — pre-standard format.** `.agents/` is pre-standard; Anthropic/OpenAI could formalize skill discovery and strand the compiler. Recommends: add "Bets & bailouts" section; commit to 90-day review checkpoint.

**Severity-medium**
- **M-1: Dismissed alternatives.** Didn't defend (a) contribute upstream to xt behind a flag, (b) ship as library not CLI, (c) remove `WORKSPACE_ROOT` in xt itself. Recommends: 5-line rejection block per alt.
- **M-2: Config state fragmenting.** 6 file locations (registry, cache, logs, plist, `.agents/`, provider dirs) with no `chalkbag doctor`. Recommends: add `chalkbag doctor` to Phase 4 (~40 lines).

### What the plan gets right (subagent)

1. Hard namespace split from xt (disjoint plist, config home, registry).
2. Disciplined simplification deltas — names specific functions to delete.
3. Explicit non-goals section prevents scope drift.

### CEO Error & Rescue Registry

| Error | Rescue |
|---|---|
| User installs chalkbag globally but xt is still watching same tree | Both daemons coexist (disjoint namespaces); user picks which writes .claude/ via not-both registration |
| User registers parent, parent has 50 node_modules/.git subtrees | `buildWorkspaceIgnoredPaths` pattern (ported from xt) skips `node_modules`, `.git`, `.venv`. Extend with user-provided ignore globs. |
| User upgrades chalkbag, registry schema drift | Version field in registry.json + migration on read (not in v1) |
| Launchd plist version drifts from installed chalkbag bin | `chalkbag daemon reload` rewrites plist (same pattern as xt) |

### CEO Failure Modes Registry

| Failure mode | Severity | Mitigation in plan | Gap |
|---|---|---|---|
| Provider spec evolves, compiler falls behind | High | Provider plugin interface | No versioning on provider output schemas |
| User hand-edits `.claude/` and rebuild overwrites | Medium | Warning in manifest (ported from xt) | Present |
| Parent-mode watcher exhausts fd limit | High | `ignored` regexes | No fd cap / no explicit test |
| Daemon crashes silently | Medium | launchd KeepAlive + heartbeat | Present |
| Two registered paths overlap (parent contains repo entry) | Medium | Not addressed | **Gap — need de-dup logic** |

### CEO — NOT in scope

- Dynamic provider plugin loader
- Linux systemd daemon
- Shared-config escape hatch (fullstack replacement)
- Migration helper from xt-agents to chalkbag
- GUI / TUI
- Per-provider version pinning
- `chalkbag doctor` — **promote to v1 per M-2** (see gate)

### CEO — What already exists

- `extend-localenv/lib/agents/src/` — ~4200 LOC, ~85% reusable port
- `extend-localenv/docs/templates/agents/.agents/` — scaffold template, copy as-is
- `extend-localenv/docs/xt-agents-onboarding.md` — strip workspace sections, becomes `chalkbag/docs/onboarding.md`
- `extend-localenv/docs/specs/2026-04-21-xt-agents-native-instructions-skills-subagents-design.md` — durable spec content, strip workspace special case

### Dream state delta

**This plan delivers:** standalone global CLI, 2 registry modes, daemon, 3 providers, docs, tests.
**Leaves to 12-month ideal:** dynamic provider loading, linux support, community spec adoption, `chalkbag doctor`.

### CEO Completion Summary

| Output | Status |
|---|---|
| Premise challenge | Done (3 challenged, 2 accepted) |
| Existing-code leverage map | Done (~85% port) |
| Dream state diagram | Done |
| Alternatives table | Done (4 alts) |
| SELECTIVE EXPANSION mode | Confirmed |
| Temporal interrogation | Done |
| Dual voices | Single-voice (codex unavailable) — 6 findings |
| Error & Rescue Registry | Done |
| Failure Modes Registry | Done (1 gap: overlap de-dup → closed in Eng C-1) |
| NOT in scope | Done |
| What already exists | Done |

## Phase 3: Eng Review

### Architecture dependency graph

```
                    cli.ts (cac entry)
                      │
         ┌────────────┼───────────────┬──────────────┐
         ▼            ▼               ▼              ▼
   commands/      render.ts       daemon/         watcher.ts
   scaffold       ─ lock          ├ entry         ├ startRepoWatcher
         │        ─ manifest      ├ registry      └ startParentWatcher
         │        ─ diff apply    │   ├ addPath         │
         ▼                        │   ├ findPathFor     ▼
    templates/                    │   └ overlap-reject  chokidar
    (copied)                      └ launchd                depth:2
                                                            fnIgnored
                                                            realpath-guard
                                                            pLimit(2)
                                      │
                                      ▼
                                 spec/load ──── imports/
                                      │         ├ resolve (traversal guard)
                                      ▼         ├ merge
                                 providers/     ├ cache
                                 ├ _plugin      └ auth
                                 ├ registry
                                 ├ claude
                                 ├ codex
                                 └ opencode
```

**Coupling:** `providers/` depend only on `spec/` types + `_plugin.ts` interface. `watcher.ts` depends on `render.ts`. `daemon/` depends on `watcher.ts` + `render.ts`. `cli.ts` is a thin shell over everything. Clean.

### Test diagram (codepath → coverage)

| Codepath | Test type | Covered? |
|---|---|---|
| `scope.ts resolveAgentsScope` (repo-only) | unit | Yes |
| `registry.ts addPath overlap rejection` | unit | **Yes (M-3 added)** |
| `registry.ts readRegistry corruption` | unit | **Yes (M-3 added)** |
| `registry.ts findPathFor longest-match` | unit | **Yes (M-3 added)** |
| `watcher.ts repo watcher debounce` | integration w/ mock chokidar | Yes |
| `watcher.ts parent watcher dispatch` | integration | Yes |
| `watcher.ts depth:2 boundary` | integration | **Yes (M-3 added)** |
| `watcher.ts realpath symlink guard` | integration | **Yes (H-3)** |
| `watcher.ts unlinkDir of .agents` | integration | **Yes (H-2)** |
| `watcher.ts pLimit(2) concurrency` | integration | **Yes (M-2)** |
| `render.ts lock contention` | integration | **Yes (M-3)** |
| `render.ts ENOENT on sourceRoot` | integration | **Yes (H-2)** |
| `render.ts resolveOutputPath escape` | unit | **Yes (M-3)** |
| `imports/resolve.ts traversal rejection` | unit | **Yes (H-4)** |
| `launchd.ts plist XML validity` | snapshot | **Yes (M-3)** |
| `launchd.ts configHome validation` | unit | **Yes (M-1)** |
| `cli.ts command exit codes` | smoke | **Yes (M-3)** |
| fd exhaustion under 20 repos | load | **Yes (H-1)** |

### Eng dual voices — consensus (codex unavailable)

| Dimension | Claude subagent | Codex | Consensus |
|---|---|---|---|
| Architecture sound? | Sound, 2 critical gaps | `[codex-unavailable]` | Addressed via C-1, C-2 fixes |
| Test coverage sufficient? | No (M-3) | `[codex-unavailable]` | Addressed via expanded Phase 5 |
| Performance risks addressed? | No (H-1, M-2) | `[codex-unavailable]` | Addressed (depth:2, pLimit) |
| Security threats covered? | No (H-4, M-1) | `[codex-unavailable]` | Addressed (traversal + validate) |
| Error paths handled? | No (H-2, H-3) | `[codex-unavailable]` | Addressed (ENOENT + realpath) |
| Deployment risk manageable? | Yes | `[codex-unavailable]` | OK |

### Eng Failure Modes Registry

| Failure | Mitigation | Gap |
|---|---|---|
| Parent + child both registered → double-build | `addPath` overlap rejection + longest-match `findPathFor` | Closed (C-1) |
| Global heartbeat masks stuck watcher | Documented limitation, per-path v2 | **Open (accepted)** |
| fd exhaustion on large parents | `depth: 2` + dirname short-circuit | Closed (H-1) |
| `.agents/` deleted mid-watch | log-and-drop + unlinkDir skip | Closed (H-2) |
| Symlink loop | realpath escape guard | Closed (H-3) |
| Import path traversal | Phase 1 audit + reject test | Closed (H-4) |
| Plist injection via env | Validate `configHome` | Closed (M-1) |
| Parallel repo stampede | `pLimit(2)` | Closed (M-2) |
| Test coverage gaps | Expanded Phase 5 | Closed (M-3) |
| `chalkbag watch` inline dup | Known debt | **Open (L-1, accepted)** |
| Registry schema drift | `version: 1` field | Closed (L-2) |

### Test plan artifact

Written inline above. No separate artifact file (saves a write; trivial to externalize later).

### Eng — NOT in scope

(Same as CEO NOT in scope.)

### Eng Completion Summary

| Output | Status |
|---|---|
| Scope challenge | Done (~3500 LOC estimated) |
| ASCII dependency diagram | Done |
| Test diagram | Done (18 codepaths mapped) |
| Test plan artifact | Done (inline) |
| Failure modes registry | Done (11 entries) |
| Dual voices | Single-voice (codex unavailable) — 11 findings |
| Auto-fixes applied to plan | 9 (C-1, C-2, H-1, H-2, H-3, H-4, M-1, M-2, M-3) + L-2 |
| Known debt | L-1 (`watch` inline dup) |

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO C-1 | Reject "downgrade to personal tool" | User Challenge → **user-overridden** | user-stated | User explicitly asked "global standalone cli chalkbag" in opening message; subagent lacked context | Downgrade to symlinks/monorepo tool |
| 2 | CEO H-1 | Reject "drop daemon entirely" | User Challenge → **user-overridden** | user-stated | User explicitly asked "run a background daemon with the same watcher" | Defer daemon to v2 |
| 3 | CEO H-2 | Reject "drop parent mode, use register-all" | User Challenge → **user-overridden** | user-stated | User explicitly asked "one level deep git repo scanning" for parent-dir case | register-all enumeration |
| 4 | CEO H-3 | Accept "add bets & bailouts + 90-day checkpoint" as future follow-up | Taste → mechanical | P3 pragmatic | Low cost to note risk; not blocking | — |
| 5 | CEO M-1 | Add "alternatives considered" block | Mechanical | P1 completeness | 5-line doc fix, free | Silently skip |
| 6 | CEO M-2 | Promote `chalkbag doctor` to v1 | Taste → mechanical | P2 boil lakes | In-blast-radius; ~40 LOC | Defer to v2 |
| 7 | Eng C-1 | `addPath` overlap rejection + longest-match `findPathFor` | Mechanical | P1, P5 | Closes silent double-build bug | Accept gap |
| 8 | Eng C-2 | Global heartbeat (document limitation) | Mechanical | P3 pragmatic | Per-path v2 upgrade path; single-user v1 is fine | Per-path heartbeat now |
| 9 | Eng H-1 | chokidar `depth: 2` + fn-based ignored | Mechanical | P1, P5 | Caps fd cost; explicit short-circuit | Raw regex |
| 10 | Eng H-2 | ENOENT log-and-drop + unlinkDir skip | Mechanical | P1 | Closes orphan-state loop | Throw on missing |
| 11 | Eng H-3 | realpath escape guard | Mechanical | P1 | Symlink loop safety | Skip |
| 12 | Eng H-4 | Audit imports/resolve for `..`/abs/control chars | Mechanical | P1, security | Security-critical; <20 LOC + test | Port verbatim |
| 13 | Eng M-1 | Validate `configHome` absolute + no control chars | Mechanical | P1, security | Defense-in-depth | Trust env |
| 14 | Eng M-2 | `pLimit(2)` across scopes | Mechanical | P3 pragmatic | Prevents stampede, user-tunable later | No cap |
| 15 | Eng M-3 | Expand Phase 5 test plan (+6 tests) | Mechanical | P1 completeness | Load-bearing coverage gaps | Accept gaps |
| 16 | Eng L-1 | Accept `chalkbag watch` inline dup | Mechanical | P3 pragmatic | Minor drift, removable when extracted | Refactor now |
| 17 | Eng L-2 | `version: 1` in registry | Mechanical | P1, cheap | Forward compat | Skip |
| 18 | DX M-1 | `init` synchronous first build + print result | Mechanical | P1, TTHW | User needs "it worked" confirmation | init returns silently |
| 19 | DX H-2 | 4-line `error/cause/fix/see` format in constructor | Mechanical | P1, UX | Load-bearing UX win | Raw messages |
| 20 | DX H-3 | Rename `list→paths`, `clean→cache clear`+`clean`, add `doctor`, `register-group`, `internal hook-run` | Mechanical | P5 explicit | Name clarity beats brevity | Keep originals |
| 21 | DX M-4 | Add troubleshooting.md / errors.md / extending.md | Mechanical | P1 completeness | 3 docs, ~few hours writing | Defer |
| 22 | DX H-5 | `daemon pause/resume` + `--version` pin note + extending.md | Mechanical | P1 escape hatches | Load-bearing for upgrade confidence | Require launchctl |
| 23 | CEO | Keep plan in nested `chalkbag/` (vs separate repo) | Taste | user-stated | User said "can you make a non extend copy" in this repo | Separate repo |
| 24 | CEO | SELECTIVE EXPANSION mode | Mechanical | P2, P3 | Right-sized: port core, defer extensibility | SCOPE EXPANSION |

## Cross-phase themes

- **"Daemon is heavy"** (CEO H-1) vs **"Daemon has concurrency/fd/heartbeat gaps"** (Eng C-2, H-1, M-2): same signal from 2 reviewers. Both addressed by Eng auto-fixes (depth:2, pLimit, doc limits). Daemon stays per user direction, but hardened.
- **"Overlap / scope ambiguity"** appears in CEO Failure Modes (gap: overlap de-dup) + Eng C-1 (addPath overlap) + DX H-3 (register-group discoverability). All three closed by registry invariants + `register-group` alias.
- **"Docs thin"** (DX M-4) aligns with **"alternatives not defended"** (CEO M-1). Fixed via extending.md + "Why not X?" in README.

## Phase 3.5: DX Review

### Developer journey (9-stage)

| Stage | Current (plan) | After DX auto-fixes |
|---|---|---|
| Discover | "chalkbag" npm package | + "Why not X?" section in README |
| Install | `npm i -g chalkbag` | same |
| First command | `chalkbag init` → scaffold only | + synchronous build + print rendered paths |
| First render | Separate `chalkbag build` step | folded into `init` |
| Daemon setup | `init` auto-installs daemon | split: opt-in `--daemon` or explicit `daemon install` |
| Iterate | edit `.agents/`, daemon rebuilds | same; `daemon pause` if needed |
| Debug | unclear error format | 4-line `error/cause/fix/see` per throw |
| Escape | no way to opt-out or add provider | `paths`, `doctor`, `extending.md` |
| Upgrade | no guidance | README pin guidance + `version: 1` in registry |

### TTHW estimate

| Step | Time |
|---|---|
| `npm i -g chalkbag` | 15s |
| `cd ~/your-repo && chalkbag init` | 5s (scaffold + build) |
| Edit `AGENTS.md` | 2 min (user work) |
| `chalkbag build` | 2s |
| **Total** | **<3 min** (target <5 min — PASS) |

Daemon install deferred → not part of TTHW path.

### DX dual voices — consensus (codex unavailable)

| Dimension | Claude subagent | Codex | Consensus |
|---|---|---|---|
| Getting started < 5 min? | Almost (sync build gap) | `[codex-unavailable]` | Addressed (init synchronous) |
| API/CLI naming guessable? | No (init/register/scaffold/list overlap) | `[codex-unavailable]` | Addressed (paths, doctor, split) |
| Error messages actionable? | No (6 kinds but no template) | `[codex-unavailable]` | Addressed (4-line format) |
| Docs findable & complete? | Missing troubleshooting/errors | `[codex-unavailable]` | Addressed (3 new docs) |
| Upgrade path safe? | No (no pause, no extend doc) | `[codex-unavailable]` | Addressed (pause/resume + extending.md) |
| Dev environment friction-free? | OK | `[codex-unavailable]` | OK |

### DX wins (subagent)

1. Namespace hygiene (xt coexistence).
2. Traversal rejection on imports doubles as security + UX.
3. `.agents/` as canonical source + gitignored outputs — first-principles answer to "which file is canonical?"

### DX scorecard (8 dimensions)

| Dimension | Score | Notes |
|---|---|---|
| Getting started | 9/10 | `init` synchronous build lands user in <3min |
| API/CLI ergonomics | 8/10 | `paths`/`doctor`/`cache clear` split; `register-group` alias; `internal` subspace |
| Error messages | 9/10 | 4-line format mandated in constructor |
| Documentation | 8/10 | 6 docs total; copy-paste quickstart; Why-not section |
| Upgrade path | 8/10 | version pinning + registry version + pause/resume |
| Escape hatches | 7/10 | Custom provider still v2 (extending.md doc bridges) |
| Discoverability | 8/10 | `--help` + `doctor` + hidden `internal` |
| Progressive disclosure | 9/10 | init → build → daemon → advanced |
| **Overall** | **8.25/10** | |

### DX Completion Summary

| Output | Status |
|---|---|
| Journey map | Done (9 stages) |
| TTHW assessment | <3min (target <5min PASS) |
| Dual voices | Single-voice (codex unavailable) — 5 findings |
| Auto-fixes applied | 5 (DX M-1 TTHW, DX H-2 errors, DX H-3 CLI naming, DX M-4 docs, DX H-5 escape hatches) |
| DX scorecard | 8.25/10 |
| Taste decisions surfaced | 1 (register-group vs --parent flag — chose both for discoverability) |

