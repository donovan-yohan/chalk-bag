# Claude Code Installation

## Quick Start

Install the full marketplace (both plugins):

```bash
claude /plugins add https://github.com/donovan-yohan/chalk-bag
```

## Individual Plugins

Install plugins separately if you only need one:

```bash
# Documentation lifecycle management
claude /plugins add https://github.com/donovan-yohan/chalk-bag/plugins/harness

# PR automation
claude /plugins add https://github.com/donovan-yohan/chalk-bag/plugins/pr
```

## Verification

After installation, verify the plugins are loaded:

```bash
# Check available commands
claude /help
```

You should see `/harness:*` and/or `/pr:*` commands in the list.

## Recommended Companion Plugins

The harness and pr plugins integrate with these optional plugins:

| Plugin | Used By | Purpose |
|--------|---------|---------|
| [superpowers](https://github.com/obra/superpowers) | harness:brainstorm, plan, orchestrate, review, complete | Core development methodologies |
| pr-review-toolkit (built-in) | harness:review, pr:review, pr:automate | Specialized review agents |

## Global CLAUDE.md Integration

After running `/harness:init` on your first project, the harness plugin adds routing instructions to `~/.claude/CLAUDE.md` so Claude Code knows when to use harness commands. If you need to add this manually:

```markdown
# Harness Documentation System

**IMPORTANT**: For projects with a Documentation Map in their CLAUDE.md:
- New features/creative work -> use `/harness:brainstorm`
- Create implementation plan -> use `/harness:plan`
- Execute the plan -> use `/harness:orchestrate`
- Work complete -> use `/harness:complete`
- Quick doc check -> use `/harness:reflect`
- Docs feel stale/bloated -> use `/harness:prune`
- Adding project knowledge -> update the appropriate `docs/*.md` file, NOT CLAUDE.md
- CLAUDE.md is a **map**, not a manual -- keep under 120 lines
```

## Updating

To update to the latest version, remove and re-add:

```bash
claude /plugins remove harness
claude /plugins add https://github.com/donovan-yohan/chalk-bag/plugins/harness
```
