# main-skill

Personal Claude Code workflow rules — auto-injected into every session via a SessionStart hook.

## What it does

Makes Claude Code follow a consistent workflow on every non-trivial task:

1. **Triage** — invokes the right skill first (debug for bugs, brainstorming for features, ui-ux for UI work).
2. **Alignment** — discusses logic with the user before touching code; surfaces edge cases upfront.
3. **Execution** — implements autonomously, then self-verifies (tests including edge cases, security, code review, linters, docs).

Full rules: [`skills/workflow-rules/SKILL.md`](skills/workflow-rules/SKILL.md).

## Install

On any machine with Claude Code:

```bash
claude plugin marketplace add SI-IC/main-skill
claude plugin install main-skill@main-skill
```

First command registers this repo as a Claude Code marketplace; second installs the `main-skill` plugin from it. The plugin's `SessionStart` hook fires on every new session — cats `SKILL.md` and `CLAUDE.md` into Claude's context automatically. No per-project config needed.

## Updates

**Maintainer workflow** (when editing rules in this repo):

1. Edit `SKILL.md` / `CLAUDE.md` / whatever.
2. **Bump `version` in `.claude-plugin/plugin.json`** (patch increment — `1.0.1` → `1.0.2`). Without a version bump, Claude Code will not refresh the cached plugin content on consumer machines.
3. Commit + push.

**Consumer workflow** (on each machine that installed the plugin):

```bash
claude plugin marketplace update main-skill   # refresh marketplace metadata
claude plugin update main-skill@main-skill    # fetch the new version into the cache
```

Then restart Claude Code. The next session loads the fresh rules.

If `plugin update` doesn't exist on your version of Claude Code, fall back to:

```bash
claude plugin uninstall main-skill@main-skill
claude plugin install main-skill@main-skill
```

## Editing the rules

Edit [`skills/workflow-rules/SKILL.md`](skills/workflow-rules/SKILL.md), commit, push. All installed instances pick up the change on their next session start.

## Structure

```
main-skill/
├── .claude-plugin/
│   ├── plugin.json         # plugin manifest
│   └── marketplace.json    # marketplace manifest (makes the repo installable)
├── skills/
│   └── workflow-rules/
│       └── SKILL.md        # the core three-phase workflow rules
├── hooks/
│   └── hooks.json          # SessionStart hook: cat SKILL.md + CLAUDE.md into context
├── CLAUDE.md               # miscellaneous rule additions (auto-loaded alongside SKILL.md)
└── README.md
```

`SKILL.md` holds the structured workflow (triage / align / execute). `CLAUDE.md` is a free-form addendum for rules that don't fit that structure — edit it, commit, push, and it propagates to every session everywhere.
