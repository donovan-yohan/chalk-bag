# Troubleshooting

This document covers the most common chalkbag problems and how to fix them.

For error message reference, see [errors.md](./errors.md).
For setup instructions, see [onboarding.md](./onboarding.md).

---

## Daemon won't start

**Symptoms:** `chalkbag daemon status` reports the daemon is not running. `chalkbag doctor` shows no heartbeat.

**Steps:**

1. Run `chalkbag doctor` for a full health summary including config paths, plist location, and last heartbeat time.

2. Check the daemon log:

   ```bash
   tail -n 50 "$CHALKBAG_CONFIG_HOME/logs/chalkbag.log"
   ```

   If `CHALKBAG_CONFIG_HOME` is not set, the default is `~/.config/chalkbag`:

   ```bash
   tail -n 50 ~/.config/chalkbag/logs/chalkbag.log
   ```

3. Verify the plist was written:

   ```bash
   cat ~/Library/LaunchAgents/com.chalkbag.daemon.plist
   ```

   If the file is missing or malformed, rewrite it:

   ```bash
   chalkbag daemon reload
   ```

4. Load the agent manually to see launchd errors:

   ```bash
   launchctl load ~/Library/LaunchAgents/com.chalkbag.daemon.plist
   launchctl list | grep chalkbag
   ```

5. If the plist references an old binary path (for example after `npm i -g chalkbag` upgraded the version), `chalkbag daemon reload` rewrites the plist with the current binary path.

---

## `.claude/` not updating

**Symptoms:** You edited `.chalk/` but the changes did not appear in `.claude/`, `.codex/`, or other generated directories.

**Steps:**

1. Check whether the daemon is alive:

   ```bash
   chalkbag daemon status
   ```

   Look for the heartbeat timestamp. If it is stale (more than a few minutes old), proceed to step 2.

2. Reload the daemon:

   ```bash
   chalkbag daemon reload
   ```

3. If `chalkbag daemon status` shows the daemon is paused:

   ```bash
   chalkbag daemon resume
   ```

4. Confirm the repo or parent directory containing it is registered:

   ```bash
   chalkbag paths
   ```

   If the repo is not listed, register it:

   ```bash
   chalkbag register ~/your-repo
   ```

5. Trigger a manual build to verify the source is valid:

   ```bash
   cd ~/your-repo && chalkbag build --yes
   ```

**Note on global heartbeat:** chalkbag v1 uses a single global heartbeat. A stuck watcher on one registered path keeps the heartbeat fresh even when other paths are not being rebuilt. If you suspect a specific repo is not rebuilding despite a fresh heartbeat, a manual `chalkbag build --yes` in that repo confirms whether the source is valid.

---

## `CLAUDE.md` symlink broken after Windows clone

**Symptoms:** `CLAUDE.md` appears as a regular file containing the text `AGENTS.md` rather than functioning as a symlink. Claude reads stale or empty instructions.

**Cause:** Git on Windows defaults to `core.symlinks = false`, which stores symlinks as plain text files.

**Fix:**

1. Enable symlink support in git:

   ```bash
   git config core.symlinks true
   ```

2. Re-check out the symlink:

   ```bash
   git checkout HEAD -- CLAUDE.md
   ```

3. If the file is still a regular file, recreate it and commit:

   ```bash
   rm CLAUDE.md
   ln -sf AGENTS.md CLAUDE.md
   git add CLAUDE.md
   git commit -m "fix: restore CLAUDE.md as symlink"
   ```

4. Run `chalkbag build --yes` to ensure all generated outputs are up to date.

**Note:** `CLAUDE.md` is managed by chalkbag as a symlink pointing to `AGENTS.md`. `chalkbag scaffold` creates it on first setup, and `chalkbag build` maintains it as a generated output. If it is missing or broken, run `chalkbag scaffold` or `chalkbag build --yes` to restore it.

---

## `permissions.yaml` seems ignored

**Symptoms:** Changes to `permissions.yaml` do not appear in `.claude/settings.json` or `.codex/config.toml`.

**Steps:**

1. Confirm the file is in the correct location. It must be at:

   ```text
   .chalk/permissions.yaml
   ```

   A `permissions.yaml` anywhere else is not read.

2. Run `chalkbag validate` to surface parse errors:

   ```bash
   cd ~/your-repo && chalkbag validate
   ```

   Validation errors include the file path and line number where available.

3. Check whether the provider supports the field you changed. For example:
   - Codex ignores the `mcp` field.
   - `sandbox` may not be supported by all providers.

   See [agents-spec.md — Permissions](./agents-spec.md#6-permissions) for the per-provider support table.

4. Rebuild after fixing:

   ```bash
   cd ~/your-repo && chalkbag build --yes
   ```

---

## Registry corruption

**Symptoms:** `chalkbag paths` or other registry commands fail with an error like:

```
error: registry.json is corrupt (kind: config, at ~/.config/chalkbag/registry.json)
fix: back up and delete registry.json, then re-register your paths
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#config
```

**Steps:**

1. Back up the corrupt file:

   ```bash
   cp ~/.config/chalkbag/registry.json ~/.config/chalkbag/registry.json.bak
   ```

2. Delete the registry:

   ```bash
   rm ~/.config/chalkbag/registry.json
   ```

3. Re-register your paths:

   ```bash
   chalkbag register ~/your-repo
   chalkbag register --parent ~/Documents/Projects
   ```

4. Verify:

   ```bash
   chalkbag paths
   ```

---

## Lock stale

**Symptoms:** `chalkbag build` fails with an error like:

```
error: timed out waiting for render lock (kind: lock, at ~/your-repo/.chalk/.state.lock)
fix: if no other chalkbag process is running, remove .chalk/.state.lock
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#lock
```

**Cause:** A previous build was interrupted (for example by a force-kill) and left the lock file on disk.

**Fix:** Confirm no other chalkbag process is running, then remove the stale lock:

```bash
cd ~/your-repo && rm .chalk/.state.lock
```

Re-run the build:

```bash
cd ~/your-repo && chalkbag build --yes
```

---

## Overlap rejection

**Symptoms:** `chalkbag register` fails with:

```
error: path is already covered by parent entry (kind: config, at ~/.config/chalkbag/registry.json)
fix: unregister the conflicting parent entry, or add --ignore <child-name> to the parent registration
see: https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#config
```

**Cause:** You are trying to register a repo that is a descendant of a path already registered in `--parent` mode, or vice versa. chalkbag rejects overlapping registrations to prevent double-builds.

**Options:**

1. Unregister the parent entry, register the child directly, then register the parent with an ignore rule:

   ```bash
   chalkbag unregister ~/Documents/Projects
   chalkbag register ~/Documents/Projects/special-repo
   chalkbag register --parent ~/Documents/Projects --ignore special-repo
   ```

2. Or, if the parent should cover the child too, unregister the child and let the parent handle it:

   ```bash
   chalkbag unregister ~/Documents/Projects/special-repo
   ```
