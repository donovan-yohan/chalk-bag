# chalkbag

Compiles a tracked `.agents/` source tree into gitignored per-provider configs (`.claude/`, `.codex/`, `.opencode/`). Registers watched paths with a background launchd daemon for incremental rebuilds.

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

## Quickstart

**Time to first working config: under 5 minutes.**

```bash
cd ~/your-repo
chalkbag init
```

`init` scaffolds `.agents/` from the built-in template and immediately runs a first render. On success you will see something like:

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
| `chalkbag init [path]` | Scaffold `.agents/` + run first render (daemon NOT installed by default) |
| `chalkbag scaffold [path]` | Bootstrap `.agents/` from template only (idempotent) |
| `chalkbag build [path]` | One-shot render of `.agents/` → provider outputs |
| `chalkbag watch [path]` | Inline watcher — rebuild on every file change (no daemon required) |
| `chalkbag validate [path]` | Validate `.agents/` source tree without writing outputs |
| `chalkbag register [path]` | Register a path in the daemon registry (`--parent` flag for parent-dir mode) |
| `chalkbag register-group [path]` | Alias for `register --parent` — register a directory of repos |
| `chalkbag unregister [path]` | Remove a path from the daemon registry |
| `chalkbag paths` | Print a JSON summary of all registered paths and their providers |
| `chalkbag doctor` | Heartbeat + daemon status + config paths + registry health check |
| `chalkbag import [path]` | Legacy provider-file importer |
| `chalkbag clean [path]` | Remove generated `.claude/`, `.codex/`, `.opencode/`, `opencode.json` |
| `chalkbag cache clear` | Clear the import cache (`~/.cache/chalkbag/`) |
| `chalkbag daemon install` | Install the launchd plist and start the daemon |
| `chalkbag daemon status` | Print daemon heartbeat status and registered paths |
| `chalkbag daemon reload` | Rewrite the plist and restart the daemon |
| `chalkbag daemon uninstall` | Stop and remove the launchd plist |
| `chalkbag daemon pause` | Write a pause flag; daemon stops triggering builds until resumed |
| `chalkbag daemon resume` | Remove the pause flag; daemon resumes normal operation |
| `chalkbag --version` | Print the installed version |
| `chalkbag internal hook-run [path]` | Git hook entry (hidden from `--help`) |

---

## Daemon Lifecycle

The daemon watches registered paths and triggers incremental rebuilds on file changes. It is managed via launchd on macOS.

**Install:**

```bash
cd ~/your-repo
chalkbag register .
chalkbag daemon install
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

Instead of registering each repo individually, register a parent directory and the daemon will discover any child repo that has a `.agents/` directory:

```bash
chalkbag register-group ~/Documents/Programs/personal
```

This is equivalent to:

```bash
chalkbag register --parent ~/Documents/Programs/personal
```

The daemon watches at `depth: 2` — so `~/Documents/Programs/personal/<child>/.agents/` is reachable, but deeper structures are not traversed. This caps file-descriptor usage on large directories.

You can register different parent directories independently without overlap:

```bash
chalkbag register-group ~/Documents/Programs/personal
chalkbag register-group ~/Documents/Programs/work
```

Attempting to register a path that is a descendant of an existing parent-mode entry will be rejected with a clear error.

---

## Provider Extension

chalkbag ships with three first-party providers: `claude`, `codex`, and `opencode`. To add a custom provider, see [docs/extending.md](docs/extending.md).

---

## Why Not X?

### vs hand-editing `.claude/settings.json`, `opencode.json`, etc.

Hand-edited provider configs drift. When you update one, the others fall out of sync. chalkbag uses `.agents/` as a single source of truth: one `permissions.yaml`, one set of skills, one set of subagents — compiled to all providers on every build.

The `CLAUDE.md` file is a committed symlink to `AGENTS.md`. You never have to remember which file is canonical.

### vs running chokidar yourself

Writing your own file watcher means writing your own debounce, your own concurrency cap, your own node_modules exclusion, your own symlink-loop guard, and your own launchd plist. chalkbag ships all of this pre-wired: `depth: 2` cap, `pLimit(2)` concurrency, realpath escape guard, and daemon auto-restart via `KeepAlive`.

`chalkbag daemon install` is one command. A hand-rolled chokidar watcher is 200 lines of glue you maintain forever.

### vs symlinks

Symlinking one file into multiple provider directories solves the drift problem for a single file but does not compose. chalkbag handles multi-file compilation: skills are projected into `.claude/skills/` and `.codex/` separately, subagents are compiled to both `.claude/agents/*.md` and `.codex/agents/*.toml`, and permissions flow through a DSL that emits correct JSON/TOML/JSON for each provider.

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
