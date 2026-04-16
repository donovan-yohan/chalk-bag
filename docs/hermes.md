# Hermes Integration

This guide describes how to use agent-skills with the [Hermes](https://github.com/anthropics/hermes) agent harness.

## Overview

Hermes uses profiles, plugins, and skills for behavior loading. The agent-skills commands are standard markdown that Hermes can load through its plugin system or as direct skill injections.

## Option 1: Hermes Plugin (Recommended)

Clone the repo and register it as a Hermes plugin:

```bash
# Clone agent-skills
git clone https://github.com/donovan-yohan/agent-skills.git ~/.hermes/plugins/agent-skills

# Or symlink from an existing clone
ln -s /path/to/agent-skills ~/.hermes/plugins/agent-skills
```

Then in your Hermes profile, enable the plugins:

```yaml
# ~/.hermes/profiles/my-project.yaml
plugins:
  - agent-skills/plugins/harness
  - agent-skills/plugins/pr
```

## Option 2: Skill Preloading

Load individual command files as Hermes skills. This is useful when you only need specific commands:

```yaml
# ~/.hermes/profiles/my-project.yaml
skills:
  - path: ~/.hermes/plugins/agent-skills/plugins/harness/commands/brainstorm.md
    name: brainstorm
  - path: ~/.hermes/plugins/agent-skills/plugins/harness/commands/plan.md
    name: plan
  - path: ~/.hermes/plugins/agent-skills/plugins/harness/commands/review.md
    name: review
```

## Option 3: Belayer Integration

When running inside a Belayer session, the agent-skills are automatically available through Belayer's Hermes plugin enablement:

```bash
# Belayer injects these env vars into Hermes
BELAYER_SESSION_ID=...
BELAYER_AGENT_ID=...
BELAYER_SOCKET=...
BELAYER_RUN_DIR=...
```

The harness commands will detect the Belayer environment and coordinate through the Belayer session bus.

## Script Compatibility

The harness scripts (`plugins/harness/scripts/*.sh`) use `${CLAUDE_PLUGIN_ROOT}` to locate themselves. When running under Hermes, set this variable in your profile:

```yaml
# ~/.hermes/profiles/my-project.yaml
env:
  CLAUDE_PLUGIN_ROOT: ~/.hermes/plugins/agent-skills/plugins/harness
```

Or if using Belayer's env injection, Belayer handles this automatically.

## Agent Definitions

The harness agents (`plugins/harness/agents/*.md`) can be loaded as Hermes agent templates:

| Agent | Purpose | Hermes Usage |
|-------|---------|-------------|
| `harness-pruner` | Documentation health auditor | Spawn as specialist during prune |
| `learnings-reviewer` | Learning compliance checker | Spawn during review phase |
| `harness-evolver` | Self-modification proposer | Spawn during evolve phase |

These agents use the same markdown format as Hermes agent definitions. Load them directly:

```yaml
agents:
  - path: ~/.hermes/plugins/agent-skills/plugins/harness/agents/harness-pruner.md
  - path: ~/.hermes/plugins/agent-skills/plugins/harness/agents/learnings-reviewer.md
  - path: ~/.hermes/plugins/agent-skills/plugins/harness/agents/harness-evolver.md
```

## Differences from Claude Code

| Feature | Claude Code | Hermes |
|---------|-------------|--------|
| Command invocation | `/harness:brainstorm` | Profile-loaded skill |
| Plugin discovery | Automatic via plugin.json | Manual profile config |
| `${CLAUDE_PLUGIN_ROOT}` | Set automatically | Set via env config |
| Agent spawning | `Agent(subagent_type=...)` | Hermes spawn mechanism |
| Superpowers integration | `Skill("superpowers:...")` | Depends on superpowers Hermes support |

## Limitations

Some harness commands invoke Claude Code-specific features:

- **`superpowers:*` skill invocations** — Commands like brainstorm, plan, and orchestrate invoke superpowers skills. These work if superpowers is also loaded as a Hermes plugin.
- **`pr-review-toolkit:*` agent types** — The review command spawns pr-review-toolkit agents. These require the pr-review-toolkit to be available in the Hermes agent roster.
- **`claude -p` subprocess** — The adversarial review script shells out to `claude -p` for context isolation. This works if the Claude CLI is available on PATH.

For commands that don't depend on these features (init, prune, reflect, resolve, update), Hermes compatibility is full.
