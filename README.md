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

The `SessionStart` hook runs `git pull` in the plugin directory before injecting the skill, so each new session picks up the latest version of the rules automatically (assuming internet access). If offline, the cached version loads.

For a forced manual update:

```bash
claude plugin marketplace update main-skill
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
│   └── hooks.json          # SessionStart hook: git pull + cat SKILL.md + CLAUDE.md
├── CLAUDE.md               # miscellaneous rule additions (auto-loaded alongside SKILL.md)
└── README.md
```

`SKILL.md` holds the structured workflow (triage / align / execute). `CLAUDE.md` is a free-form addendum for rules that don't fit that structure — edit it, commit, push, and it propagates to every session everywhere.
