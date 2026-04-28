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

First command registers this repo as a Claude Code marketplace; second installs the `main-skill` plugin from it. The plugin's `SessionStart` hook fires on every new session and tells Claude to invoke the `main-skill:workflow-rules` skill — full rule content arrives through the skill-tool channel, which is **not** subject to Claude Code's 10KB cap on SessionStart hook stdout. No per-project config needed.

## Updates

**Maintainer workflow** (when editing rules in this repo):

1. Edit `SKILL.md` / `CLAUDE.md` / whatever.
2. **Bump `version` in `.claude-plugin/plugin.json`** (patch increment — `1.0.1` → `1.0.2`). Without a version bump, Claude Code will not refresh the cached plugin content on consumer machines.
3. Commit + push.

**Consumer workflow** — nothing to do. The plugin ships a synchronous SessionStart hook (`hooks/session-start.sh`) that does a cheap `git ls-remote` against the marketplace clone on every session start; if remote moved, it runs `claude plugin update` inline. After update, the hook emits a short instruction telling Claude to invoke the `main-skill:workflow-rules` skill — Claude reads the freshest `SKILL.md` from the updated cache. So **the current session sees new rules immediately** — no second restart required. When an update actually lands, the hook also prints a one-liner `main-skill updated to vX.Y.Z` so the upgrade is visible (Claude Code's `/plugin` UI is frozen at process start and won't show the new version until you restart `claude`). 60-second concurrent-run guard prevents thrashing across windows.

Opt out of the update check with `export MAIN_SKILL_AUTO_UPDATE=0`.

## Stop-hook tuning (per-project)

The `verify-changes.js` Stop hook blocks "done" claims until tests are paired, docs are updated, lint is green, edge-cases are declared, and self-review is performed. It auto-detects test pairs across stacks (pnpm/yarn/cargo/go monorepos; Jest/Vitest/RSpec/PHPUnit/JUnit/Swift conventions) and skips files that aren't unit-testable (migrations, seeders, fixtures, locales, `*.d.ts`, `*.generated.*`, framework configs, type-only TS, `@generated`-headed files).

If the hook still flags files that legitimately don't need unit tests in your project, add a per-project ignore via env var (POSIX globs, `:`-separated):

```bash
export MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/legacy/**:**/scripts/**:packages/proto-gen/**"
```

Hard opt-outs:
- `MAIN_SKILL_VERIFY_CHANGES=0` — disable all hook triggers.
- `MAIN_SKILL_VERIFY_LINT=0` — keep test/docs checks but skip auto-lint.
- `MAIN_SKILL_VERIFY_REVIEW=0` — disable J/K (self-review + review-triage).
- `MAIN_SKILL_VERIFY_REVIEW=code` — require only code-review section.
- `MAIN_SKILL_VERIFY_REVIEW=security` — require only security-review section.

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
│       ├── SKILL.md        # core: 3-phase workflow + universal user-facing rules
│       └── references/
│           └── stop-triggers.md  # full enumeration of verify-changes triggers
├── hooks/
│   ├── hooks.json          # SessionStart + Stop hook registration
│   ├── session-start.sh    # remote-SHA check + plugin update + skill-invocation prompt
│   ├── verify-changes.js   # Stop hook: blocks "done" until tests, docs, lint, edge-cases declaration are in place
│   ├── verify-changes.test.js  # integration tests for the hook
│   └── lib/
│       ├── checks.js       # helpers: src↔test mapping, e2e detection, edge-cases parsing, auto-lint
│       └── checks.test.js  # unit tests for checks.js
├── CLAUDE.md               # dev-facing notes for plugin maintainers (auto-loaded as project-memory inside this repo only)
└── README.md
```

All user-facing workflow rules live in `SKILL.md`. `references/*.md` hold reference material that's verbose, hook-driven, or self-contained (linked from SKILL.md). `CLAUDE.md` in the repo root is for plugin-maintenance notes — it's auto-loaded only when editing this repo, not in consumer sessions.
