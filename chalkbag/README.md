# chalkbag

Compiles a tracked `.chalk/` source tree into gitignored per-provider configs (`.claude/`, `.codex/`, `.opencode/`) plus an `.agents/` mirror for AGENTS.md-spec readers (Codex hierarchical scan and any other tool following the spec). Registers watched paths with a background daemon (launchd on macOS, systemd on Linux) for incremental rebuilds.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org) [![npm](https://img.shields.io/npm/v/chalkbag)](https://www.npmjs.com/package/chalkbag)

---

## Install

```bash
npm i -g chalkbag
```

To pin a major version:

```bash
npm i -g chalkbag@1
```

Verify the install:

```bash
chalkbag --version
```

---

## Quick start (paste this into your agent)

To onboard a repo, paste the block below into Claude Code or Codex from inside that repo and let the agent run it. It is the same canonical prompt as the [repo README](https://github.com/donovan-yohan/chalk-bag#quick-start-paste-this-into-your-agent).

```text
Onboard this repository to chalkbag, a CLI that compiles a tracked `.chalk/`
source tree plus tracked AGENTS.md files into per-provider agent configs.
Project: https://github.com/donovan-yohan/chalk-bag

First, fetch and follow the onboarding guide — it is the authoritative reference:
https://github.com/donovan-yohan/chalk-bag/blob/master/chalkbag/docs/onboarding.md

Then execute this checklist in order, from the repo root:

1. Install the CLI: `npm i -g chalkbag`, then verify with `chalkbag --version`.
2. Run `chalkbag init` to scaffold `.chalk/` and render the first build.
3. Author the root `AGENTS.md` as a MAP, not a README: one-line repo purpose, a
   directory map (path -> what lives there -> when to read it), the exact
   build/test/lint commands, and working rules an agent cannot infer from code.
   Link real docs instead of duplicating them; keep it ~60-120 lines.
4. Verify the committed Claude bridge symlink exists — step 2 created it. Run
   `ls -l CLAUDE.md`; it should show `CLAUDE.md -> AGENTS.md`. If missing, run
   `ln -sf AGENTS.md CLAUDE.md`.
5. Add scoped `AGENTS.md` files in major subdirectories (packages/*, services/*,
   large src areas), each with a sibling `ln -sf AGENTS.md CLAUDE.md` symlink,
   following the authoring guide:
   https://github.com/donovan-yohan/chalk-bag/blob/master/chalkbag/docs/authoring-agents-md.md
6. Verify `.gitignore` ignores the generated outputs — step 2 added them. It
   should list `.claude/`, `.codex/`, `.opencode/`, and `opencode.json`. If any
   are missing, append them.
7. Review `.chalk/permissions.yaml` and `.chalk/providers.yaml`: enable only the
   providers this repo uses and scope permissions to what agents actually need.
8. Run `chalkbag validate && chalkbag build --yes`.
9. Run `chalkbag doctor` and resolve anything it flags.
10. Commit the tracked files (AGENTS.md, CLAUDE.md symlinks, `.chalk/`,
    `.gitignore`); the generated `.claude/`, `.codex/`, `.opencode/`, and
    `opencode.json` stay ignored.
```

For the doctrine behind steps 3 and 5, see [Authoring AGENTS.md files](docs/authoring-agents-md.md).

---

## Quickstart

**Time to first working config: under 5 minutes.**

```bash
cd ~/your-repo
chalkbag init
```

`init` scaffolds `.chalk/` from the built-in template and immediately runs a first render. On success you will see something like:

```
rendered 3 providers in .claude/, .codex/, opencode.json
```

Then edit your `AGENTS.md` (created at the repo root):

```bash
# open in your editor of choice
vim ~/your-repo/AGENTS.md
```

Rebuild at any time:

```bash
cd ~/your-repo && chalkbag build
```

To watch for changes without the daemon:

```bash
cd ~/your-repo && chalkbag watch
```

To install the background daemon so rebuilds happen automatically on every file change:

```bash
chalkbag daemon install
```

---

## CLI Reference

| Command | Purpose |
|---|---|
| `chalkbag init [path]` | Scaffold `.chalk/` + run first render (daemon NOT installed by default). `--global` scaffolds machine-level `~/.chalk/` |
| `chalkbag scaffold [path]` | Bootstrap `.chalk/` from template only (idempotent) |
| `chalkbag build [path]` | One-shot render of `.chalk/` → provider outputs. `--global` builds machine-level `~/.chalk/` |
| `chalkbag watch [path]` | Inline watcher — rebuild on every file change (no daemon required) |
| `chalkbag validate [path]` | Validate `.chalk/` source tree without writing outputs. `--global` validates `~/.chalk/` |
| `chalkbag register [path]` | Register a path in the daemon registry (`--parent` flag for parent-dir mode) |
| `chalkbag register-group [path]` | Alias for `register --parent` — register a directory of repos |
| `chalkbag unregister [path]` | Remove a path from the daemon registry |
| `chalkbag paths` | Print a JSON summary of all registered paths and their providers |
| `chalkbag doctor` | Heartbeat + daemon status + config paths + registry health check |
| `chalkbag import [path]` | Legacy provider-file importer |
| `chalkbag clean [path]` | Remove generated `.claude/`, `.codex/`, `.opencode/`, `opencode.json`. `--global` cleans machine-level outputs (never your config files) |
| `chalkbag cache clear` | Clear the import cache (`~/.cache/chalkbag/`) |
| `chalkbag daemon install` | Install and start the background daemon (launchd on macOS, systemd user unit on Linux) |
| `chalkbag daemon status` | Print the service-manager state (`is-active`/`launchctl`) merged with heartbeat freshness |
| `chalkbag daemon reload` | Rewrite the unit/plist and restart the daemon |
| `chalkbag daemon uninstall` | Stop and remove the daemon unit/plist |
| `chalkbag daemon pause` | Write a pause flag; daemon stops triggering builds until resumed |
| `chalkbag daemon resume` | Remove the pause flag; daemon resumes normal operation |
| `chalkbag --version` | Print the installed version |
| `chalkbag internal hook-run [path]` | Git hook entry (hidden from `--help`) |

---

## Daemon Lifecycle

The daemon watches registered paths and triggers incremental rebuilds on file changes. It is managed by the platform's service manager:

- **macOS** — a launchd user agent at `~/Library/LaunchAgents/com.chalkbag.daemon.plist`.
- **Linux** — a systemd user unit at `~/.config/systemd/user/chalkbag.service` (respects `XDG_CONFIG_HOME`), with logs on the journal (`journalctl --user -u chalkbag.service`).

On any other platform, daemon management is unsupported — use the foreground watcher `chalkbag watch` instead. All `chalkbag daemon` subcommands below dispatch to the right service manager automatically.

**Install:**

```bash
cd ~/your-repo
chalkbag register .
chalkbag daemon install
```

On a headless Linux box, the systemd user session only survives logout if lingering is enabled. If `chalkbag daemon install` reports the user session bus is unavailable, run:

```bash
loginctl enable-linger "$USER"
```

**Check status:**

```bash
chalkbag daemon status
# or for full health report:
chalkbag doctor
```

**Pause and resume** (useful when manually editing generated files):

```bash
chalkbag daemon pause
# edit .claude/settings.json or other outputs as needed
chalkbag daemon resume
```

**Reload** (after upgrading chalkbag or changing the registered path list):

```bash
chalkbag daemon reload
```

**Uninstall:**

```bash
chalkbag daemon uninstall
```

The daemon writes a heartbeat file every 30 seconds to `~/.config/chalkbag/heartbeat`. `chalkbag doctor` reports whether the heartbeat is stale (indicating the daemon may have stopped).

---

## Registering Parent Directories

Instead of registering each repo individually, register a parent directory and the daemon will discover any child repo that has a `.chalk/` directory:

```bash
chalkbag register-group ~/Documents/Programs/personal
```

This is equivalent to:

```bash
chalkbag register --parent ~/Documents/Programs/personal
```

The daemon watches at `depth: 2` — so `~/Documents/Programs/personal/<child>/.chalk/` is reachable, but deeper structures are not traversed. This caps file-descriptor usage on large directories.

You can register different parent directories independently without overlap:

```bash
chalkbag register-group ~/Documents/Programs/personal
chalkbag register-group ~/Documents/Programs/work
```

Attempting to register a path that is a descendant of an existing parent-mode entry will be rejected with a clear error.

---

## Global scope

Alongside per-repo `.chalk/`, chalkbag can manage a machine-level **global scope**: a `~/.chalk/` source tree compiled into your user-level Claude and Codex config. Repo scope always overrides global scope inside a repo.

```bash
chalkbag init --global
```

This scaffolds `~/.chalk/` (providers, skills, and a machine-level `AGENTS.md`), registers a `global` daemon entry, and runs the first build. It:

- projects `~/.chalk/skills/` into `~/.claude/skills/` and `~/.agents/skills/` (the Codex / AGENTS.md-spec user-level skill dir);
- bridges the context file with `~/.claude/CLAUDE.md -> ~/.chalk/AGENTS.md` and `~/.codex/AGENTS.md -> ~/.chalk/AGENTS.md` (refusing to clobber an existing regular file with content);
- merges an optional `~/.chalk/permissions.yaml` into `~/.claude/settings.json` (your entries are never dropped) and into a **managed block** in `~/.codex/config.toml` — everything outside the markers is preserved byte-for-byte.

`chalkbag build --global`, `chalkbag validate --global`, and `chalkbag clean --global` operate on the global scope. `clean --global` removes only chalkbag-written outputs and never your own config files. See [docs/agents-spec.md — Global scope](docs/agents-spec.md#10-global-scope-machine-level-chalk) and [docs/onboarding.md](docs/onboarding.md#machine-level-onboarding-run-once-per-machine) for the full contract.

---

## Provider Extension

chalkbag ships with three first-party providers: `claude`, `codex`, and `opencode`. To add a custom provider, see [docs/extending.md](docs/extending.md).

---

## Why Not X?

### vs hand-editing `.claude/settings.json`, `opencode.json`, etc.

Hand-edited provider configs drift. When you update one, the others fall out of sync. chalkbag uses `.chalk/` as a single source of truth: one `permissions.yaml` and one set of skills — compiled to all providers on every build.

The `CLAUDE.md` file is a committed symlink to `AGENTS.md`. You never have to remember which file is canonical.

### vs running chokidar yourself

Writing your own file watcher means writing your own debounce, your own concurrency cap, your own node_modules exclusion, your own symlink-loop guard, and your own service-manager integration — a launchd plist on macOS, a systemd user unit on Linux. chalkbag ships all of this pre-wired: `depth: 2` cap, `pLimit(2)` concurrency, realpath escape guard, and daemon auto-restart (launchd `KeepAlive` / systemd `Restart=always`).

`chalkbag daemon install` is one command on both macOS and Linux. A hand-rolled chokidar watcher is 200 lines of glue you maintain forever.

### vs symlinks

Symlinking one file into multiple provider directories solves the drift problem for a single file but does not compose. chalkbag handles multi-file compilation: skills are projected into `.claude/skills/` and the `.agents/skills/` mirror separately, and permissions flow through a DSL that emits correct JSON/TOML/JSON for each provider.

Symlinks also break on Windows and on machines that clone with `core.symlinks=false`. chalkbag generates real files from tracked source; the gitignored outputs are throwaway artifacts.

---

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for:

- Daemon won't start
- `.claude/` not updating after file changes
- `CLAUDE.md` symlink broken on Windows clone
- `permissions.yaml` entries being silently ignored
- Registry corruption recovery

---

## License

MIT — see [LICENSE](../LICENSE).
