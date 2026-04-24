# Error reference

chalkbag throws structured `ChalkBagError` instances. Every error prints a 4-line block:

```
error: <message> (kind: <kind>, at <file>)
cause: <cause message, if present>
fix: <fix hint>
see: <docs url>
```

The `kind` field routes you to the right section below. The `at` field names the file (or registry path) where the problem was detected. The `fix` line is a one-line action. If there is a root cause, it appears on the `cause` line.

For setup and workflow guidance, see [onboarding.md](./onboarding.md) and [troubleshooting.md](./troubleshooting.md).

---

## `cli`

The `cli` kind covers invalid command-line usage: unrecognized flags, missing required arguments, and mutually exclusive options.

These errors are usually caused by a typo or a misremembered flag name. Run `chalkbag --help` or `chalkbag <command> --help` to see the correct syntax.

**Examples:**

```
error: unknown flag --providers (kind: cli, at cli.ts)
fix: use --provider <ids>, for example --provider claude,codex
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#cli
```

This happens when you type `--providers` instead of `--provider`.

```
error: register requires a path argument (kind: cli, at cli.ts)
fix: run chalkbag register <path>, or chalkbag register . to register the current directory
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#cli
```

This happens when you run `chalkbag register` without specifying a path.

```
error: --parent and --provider are required when using --ignore (kind: cli, at cli.ts)
fix: pass --parent and at least one --provider when specifying --ignore
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#cli
```

This happens when flags are combined in an unsupported way.

---

## `config`

The `config` kind covers configuration parsing failures: malformed YAML, missing required fields, unknown provider IDs, invalid registry JSON, and overlap rejection.

These errors point at the file that failed to parse or the registry entry that caused the conflict.

**Examples:**

```
error: providers.yaml: unknown provider id "cline" (kind: config, at ~/your-repo/.agents/providers.yaml)
fix: valid provider ids are: claude, codex, opencode
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#config
```

This happens when `providers.yaml` lists a provider that chalkbag does not recognize.

```
error: registry.json is corrupt — missing version field (kind: config, at ~/.config/chalkbag/registry.json)
fix: back up and delete registry.json, then re-register your paths
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#config
```

This happens when the registry file is malformed or was written by an incompatible version. See [troubleshooting.md — Registry corruption](./troubleshooting.md#registry-corruption).

```
error: path is already covered by parent entry ~/Documents/Projects (kind: config, at ~/.config/chalkbag/registry.json)
fix: unregister the conflicting parent entry, or add --ignore <child-name> to the parent registration
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#config
```

This happens when you register a repo that overlaps with an existing parent-mode entry. See [troubleshooting.md — Overlap rejection](./troubleshooting.md#overlap-rejection).

---

## `io`

The `io` kind covers filesystem access failures: file not found, permission denied, unreadable YAML, and output path escape attempts.

These errors usually mean a file that chalkbag expects is missing or unreadable, or that a generated output path resolves outside the repo root.

**Examples:**

```
error: could not read .agents/providers.yaml — ENOENT (kind: io, at ~/your-repo/.agents/providers.yaml)
cause: ENOENT: no such file or directory, open '~/your-repo/.agents/providers.yaml'
fix: run chalkbag scaffold to create the missing .agents/ structure
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#io
```

This happens when `providers.yaml` is missing. Run `chalkbag scaffold` to recreate it.

```
error: subagent source file is not readable (kind: io, at ~/your-repo/.agents/subagents/code-reviewer.md)
cause: EACCES: permission denied, open '...'
fix: check file permissions; the file must be readable by the current user
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#io
```

This happens when a source file exists but cannot be read.

```
error: resolved output path escapes repo root (kind: config, at ~/your-repo/.agents/subagents/escape.md)
fix: output paths must resolve inside the repo root; check for .. or absolute path segments in the source file
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#config
```

This is a security guard that rejects output paths that would write outside the repo tree.

---

## `daemon`

The `daemon` kind covers daemon lifecycle failures: plist write errors, launchd load failures, invalid config home paths, and heartbeat write errors.

These errors appear when you run `chalkbag daemon install`, `chalkbag daemon reload`, or when the daemon itself encounters a startup problem.

**Examples:**

```
error: could not write plist to ~/Library/LaunchAgents/com.chalkbag.daemon.plist (kind: daemon, at ~/Library/LaunchAgents/com.chalkbag.daemon.plist)
cause: EACCES: permission denied, open '...'
fix: check that ~/Library/LaunchAgents exists and is writable
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#daemon
```

This happens when the LaunchAgents directory is not writable.

```
error: CHALKBAG_CONFIG_HOME is not an absolute path (kind: daemon, at env:CHALKBAG_CONFIG_HOME)
fix: set CHALKBAG_CONFIG_HOME to an absolute path, e.g. /Users/you/.config/chalkbag
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#daemon
```

This happens when `CHALKBAG_CONFIG_HOME` is set to a relative path or contains control characters.

```
error: daemon install: platform unsupported (kind: daemon, at daemon/launchd.ts)
fix: on Linux, use chalkbag watch as an inline watcher instead of the daemon
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#daemon
```

This happens on Linux where launchd is not available. Use `chalkbag watch` instead.

---

## `lock`

The `lock` kind covers render lock contention: a build timed out waiting to acquire `.agents/.state.lock`, or the lock file could not be written.

**Examples:**

```
error: timed out waiting for render lock (kind: lock, at ~/your-repo/.agents/.state.lock)
fix: if no other chalkbag process is running, remove .agents/.state.lock and retry
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#lock
```

This is the most common `lock` error. It means a previous build was interrupted without releasing the lock. See [troubleshooting.md — Lock stale](./troubleshooting.md#lock-stale).

```
error: could not write render lock (kind: lock, at ~/your-repo/.agents/.state.lock)
cause: EACCES: permission denied, open '...'
fix: check that .agents/ is writable by the current user
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#lock
```

This happens when `.agents/` is not writable, for example after a permissions change.

---

## `provider`

The `provider` kind covers failures within a provider's render function: a provider-specific output could not be generated, a required field is missing in a subagent source, or a skill bundle failed to copy.

These errors name the provider and the source file that triggered the failure.

**Examples:**

```
error: claude provider: subagent "code-reviewer" is missing required field "description" (kind: provider, at ~/your-repo/.agents/subagents/code-reviewer.md)
fix: add a description field to the subagent frontmatter
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#provider
```

This happens when a subagent source file omits a field that the provider requires. Open the file and add the missing frontmatter key.

```
error: codex provider: could not emit agent file for "deploy-bot" (kind: provider, at ~/your-repo/.agents/subagents/deploy-bot.md)
cause: ENOSPC: no space left on device
fix: free up disk space and retry
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#provider
```

This happens when the filesystem is full during output writing.

```
error: claude provider: skill bundle copy failed for "oncall" (kind: provider, at ~/your-repo/.agents/skills/oncall)
cause: ENOENT: no such file or directory, lstat '...'
fix: verify that the skill directory exists and contains a SKILL.md file
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#provider
```

This happens when a skill directory is declared but the files are missing or the import failed to resolve.
