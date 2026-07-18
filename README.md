# chalk-bag

Reusable agent skills for structured software development workflows, plus a standalone CLI for compiling per-provider AI configs.

## Quick start (paste this into your agent)

To onboard a repo to chalkbag, paste the block below into Claude Code or Codex from inside that repo and let the agent run it:

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

For the doctrine behind step 3 and step 5, see [Authoring AGENTS.md files](chalkbag/docs/authoring-agents-md.md).

- **chalkbag** — Standalone CLI: compiles `.chalk/` source trees into per-provider configs (`.claude/`, `.codex/`, `.opencode/`)
- **harness** — Documentation lifecycle management with self-improving review agents
- **pr** — Pull request lifecycle automation

## Standalone CLIs

### chalkbag

A global CLI that compiles a tracked `.chalk/` source tree into gitignored per-provider configs and registers watched paths with a background launchd daemon for incremental rebuilds.

```bash
npm i -g chalkbag
cd ~/your-repo && chalkbag init
```

See [chalkbag/README.md](chalkbag/README.md) for install, quickstart, CLI reference, daemon lifecycle, and the "Why not X?" section.

**Providers:** Claude (`.claude/`), Codex (`.codex/`), opencode (`opencode.json`)

## Plugins

### harness

A 3-tier documentation system with living execution plans, adversarial code review, conversation mining, and self-improving agent evolution.

**Workflow:** `brainstorm -> plan -> orchestrate -> review -> reflect -> evolve -> complete`

| Command | Purpose |
|---------|---------|
| `/harness:init` | Initialize 3-tier documentation structure |
| `/harness:brainstorm` | Design through collaborative dialogue |
| `/harness:bug` | Systematic bug investigation with architecture review |
| `/harness:refactor` | Scope incremental refactoring with strangler fig patterns |
| `/harness:plan` | Create living execution plans from design docs |
| `/harness:orchestrate` | Execute plans with agent teams and micro-reflects |
| `/harness:batch` | Execute plans via worktree-isolated parallel batch |
| `/harness:review` | Multi-agent code review with adversarial production review |
| `/harness:evolve` | Classify learnings, update metrics, propose agent evolution |
| `/harness:reflect` | Full reflection, conversation mining, retrospective |
| `/harness:complete` | Archive plan, prune check, and create PR |
| `/harness:prune` | Audit docs for staleness, broken links, bloat |

**Agents:** harness-pruner, learnings-reviewer, harness-evolver

**Skills:** strangler-fig (incremental refactoring patterns)

### pr

Pull request lifecycle management with multi-perspective automated review.

| Command | Purpose |
|---------|---------|
| `/pr:author` | Create PRs with quality gates |
| `/pr:automate` | Full automated lifecycle: author -> review -> resolve -> merge |
| `/pr:review` | Multi-agent PR review (6 specialized agents) |
| `/pr:resolve` | Analyze and address PR review comments |
| `/pr:update` | Sync PR description with current changes |

## Installation

### Claude Code

Install as a marketplace. From any project directory:

```bash
claude /plugins add https://github.com/donovan-yohan/chalk-bag
```

This registers both plugins. You can also install individual plugins:

```bash
# Install just the harness plugin
claude /plugins add https://github.com/donovan-yohan/chalk-bag/plugins/harness

# Install just the pr plugin
claude /plugins add https://github.com/donovan-yohan/chalk-bag/plugins/pr
```

### Hermes

Hermes can load these skills through its plugin and profile system. See [docs/hermes.md](docs/hermes.md) for integration instructions.

### Other Agents

The command and skill files are standard markdown with YAML frontmatter. Any agent that can load markdown-based instructions can use these skills directly. The key integration points:

1. **Commands** (`plugins/*/commands/*.md`) — Procedural workflows triggered by explicit user commands
2. **Agents** (`plugins/*/agents/*.md`) — System prompts for specialized background agents
3. **Skills** (`plugins/*/skills/*/SKILL.md`) — Pattern-triggered capabilities with frontmatter descriptions
4. **Scripts** (`plugins/harness/scripts/*.sh`) — Shell scripts for persistence and metrics
5. **References** (`plugins/harness/references/*.md`) — Shared reference documents loaded by commands

## Dependencies

The **harness** plugin works standalone. Some commands optionally integrate with:

- [superpowers](https://github.com/obra/superpowers) — Used by brainstorm, plan, orchestrate, review, and complete commands for their core methodologies (brainstorming, writing-plans, subagent-driven-development, etc.)
- [pr-review-toolkit](https://github.com/anthropics/claude-code) — Used by the review command for specialized review agents (code-reviewer, silent-failure-hunter, type-design-analyzer)

The **pr** plugin requires pr-review-toolkit for the review and automate commands.

## Documentation Tiers

The harness plugin manages a 3-tier documentation system:

1. **CLAUDE.md** (60-120 lines) — Map with Documentation Map table
2. **docs/*.md** — Domain summaries (ARCHITECTURE, DESIGN, PLANS, QUALITY)
3. **docs/design-docs/**, **docs/exec-plans/** — Deep docs, versioned plans

## Self-Improvement

The harness plugin tracks review effectiveness across sessions:

- **Metrics** — Review agent accuracy, plan prediction quality, learning efficacy
- **Evolution** — Automatic agent definition updates based on review escapes
- **Adversarial review** — Context-isolated production failure analysis using `claude -p`
- **Learnings** — Persistent project knowledge captured and enforced across sessions

## License

MIT
