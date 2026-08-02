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

**Gen-5 models — AgentTool gate.** Модели 5-го поколения получают серверную строку системного промпта «Do not call the AgentTool unless the user requested it» и могут пропускать запуск ревью-сабагентов (делают ревью сами, ссылаясь на гейт). Гейт по собственной формулировке снимается запросом пользователя; SKILL.md, SessionStart-инструкция и reasonJ дублируют эту авторизацию текстом плагина, но самый авторитетный канал — твой собственный `~/.claude/CLAUDE.md`. SessionStart-хук **сам дописывает** туда standing-request строку (идемпотентно, по маркеру `main-skill:agenttool-standing-request`; о факте записи печатает баннер) — на новой машине ничего делать не нужно. Строка действует со второй сессии (CLAUDE.md загружается до хука); первую покрывает SessionStart-инструкция. Не хочешь авто-записи — `MAIN_SKILL_CLAUDEMD_PROVISION=0` (и удали строку с маркером; без opt-out хук допишет её снова). Если `~/.claude/CLAUDE.md` — симлинк dotfiles-менеджера (chezmoi/stow), хук в него не пишет — добавь строку в свой dotfiles-источник сам. Удаляешь плагин — удали и строку с маркером: uninstall-хуков у Claude Code нет, сама она не исчезнет.

## Updates

**Maintainer workflow** (when editing rules in this repo):

1. Edit `SKILL.md` / `CLAUDE.md` / whatever.
2. **Bump `version` in `.claude-plugin/plugin.json`** (patch increment — `1.0.1` → `1.0.2`). Without a version bump, Claude Code will not refresh the cached plugin content on consumer machines.
3. Commit + push.

**Consumer workflow** — nothing to do. The plugin ships a synchronous SessionStart hook (`hooks/session-start.sh`) that does a cheap `git ls-remote` against the marketplace clone on every session start; if remote moved, it runs `claude plugin update` inline. After update, the hook emits a short instruction telling Claude to invoke the `main-skill:workflow-rules` skill — Claude reads the freshest `SKILL.md` from the updated cache. So **the current session sees new rules immediately** — no second restart required. When an update actually lands, the hook also prints a one-liner `main-skill updated to vX.Y.Z` so the upgrade is visible (Claude Code's `/plugin` UI is frozen at process start and won't show the new version until you restart `claude`). 60-second concurrent-run guard prevents thrashing across windows.

Opt out of the update check with `export MAIN_SKILL_AUTO_UPDATE=0`.

## Disabling for a single session

Run **`/main-skill:off`** mid-session (e.g. right after `/clear`) to turn the plugin off for the rest of that session — no restart needed. It drops a sentinel (`~/.claude/plugins/.main-skill-off`) that all hooks (`verify-changes`, `claudemd-guard`, `ignore-glob-guard`, `comment-guard`, `auto-format`) read at runtime and no-op on, and tells Claude to stop applying the workflow rules. **`/main-skill:on`** re-enables it. The sentinel is cleared automatically on the next `startup`/`resume`/`clear`, so a fresh session always starts with the plugin on.

Launch-time equivalent for a whole session: `MAIN_SKILL_OFF=1 claude`. Note the sentinel is user-level, not session-scoped — while active it also silences other open Claude Code windows.

## Auto-format (PostToolUse hook)

`hooks/auto-format.js` runs after every `Edit` / `Write` / `MultiEdit` / `NotebookEdit` and formats the file in-place using the right tool for the language:

| Extensions                                                                                            | Formatter                        | Install (auto-detected)                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `.js .jsx .ts .tsx .mjs .cjs .css .scss .sass .less .html .json .yaml .md .mdx .vue .svelte .graphql` | `prettier`                       | `bun add -d prettier` (bun.lockb) → `pnpm add -D prettier` (pnpm-lock.yaml) → `yarn add -D prettier` (yarn.lock) → `npm install -D prettier` |
| `.py .pyi`                                                                                            | `ruff format` (fallback `black`) | `uv add --dev ruff` (uv.lock) → `poetry add --group dev ruff` (poetry.lock) → `pipenv install --dev ruff` (Pipfile) → `pip install ruff`     |
| `.go`                                                                                                 | `gofmt -w`                       | (ships with Go SDK — install Go)                                                                                                             |
| `.rs`                                                                                                 | `rustfmt`                        | `rustup component add rustfmt`                                                                                                               |
| `.c .cpp .cc .h .hpp .m .mm`                                                                          | `clang-format -i`                | `brew install clang-format` (macOS)                                                                                                          |

Search order: project-local (`node_modules/.bin/`, `.venv/bin/`, `venv/bin/`) → global PATH. If the formatter is missing, the hook returns `additionalContext` to Claude with the exact install command for the detected package manager — Claude installs and re-applies the edit. Lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`, etc.), `*.min.js/css`, and files inside `node_modules`/`dist`/`build`/`.next`/`target`/`vendor`/`.git` are skipped.

No env opt-out — formatting is unconditional. Per-project formatter config (`.prettierrc`, `pyproject.toml`, `rustfmt.toml`, `.clang-format`) is honored automatically by each tool.

## Stop-hook tuning (per-project)

The `verify-changes.js` Stop hook blocks "done" claims until tests are paired, docs are updated, lint is green, edge-cases are declared, a premortem block precedes non-trivial changes (trigger N: ≥3 specific "what breaks in prod" hypotheses — `input → observable failure → fix`, each with a concrete number / error code / identifier), and self-review is performed (three parallel reviewers: code, security, premortem lens). It auto-detects test pairs across stacks (pnpm/yarn/cargo/go monorepos; Jest/Vitest/RSpec/PHPUnit/JUnit/Swift conventions) and skips files that aren't unit-testable (migrations, seeders, fixtures, locales, `*.d.ts`, `*.generated.*`, framework configs, type-only TS, `@generated`-headed files).

If the hook still flags files that legitimately don't need unit tests in your project, add a per-project ignore via env var (POSIX globs, `:`-separated). **Use the narrowest glob — a specific file or a name/extension pattern, never a whole folder.** A broad `dir/**` also silences must-test logic living in that folder, so the `ignore-glob-guard` PreToolUse hook rejects broad ignore-globs Claude tries to write (opt out with `MAIN_SKILL_IGNORE_GLOB_CHECK=0`):

```bash
export MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/*.gen.ts:src/generated/schema.ts"
```

A repo with centralized tests (all tests under `tests/`, spec names by feature rather than by source file) usually needs no ignore at all: trigger D falls back to an import scan — a spec in the package's `tests/` / `test/` / `spec/` / `specs/` / `__tests__/` that imports the edited file (incl. `#aliases` and relative paths) counts as its paired test. Specs are read most-relevant-first (source name/dir in the spec path), with a read budget of `MAIN_SKILL_IMPORT_SCAN_MAX_FILES` (default 200, cap 10000); if the budget runs out before the list is exhausted, the block reason says so explicitly and suggests a `grep` check instead of claiming "no test". Only if specs don't import sources at all (pure HTTP-flow tests) set `MAIN_SKILL_VERIFY_CHANGES=0` — never ignore the whole source dir.

To audit ignore-globs already configured in a project (e.g. broad ones set before the guard existed), run **`/main-skill:check-ignore-globs`**. It scans the project's carrier files (`.env*`, `.claude/settings*.json`, `.mcp.json`, `*.sh`), home-level configs (`~/.claude/settings.json`, shell rc) and the environment, flags any broad `dir/**` / `**/*.ext` glob via the same `isBroadIgnoreGlob` the guard uses, and helps you narrow each one. Standalone (no Claude): `node hooks/lib/audit-ignore-globs.js <dir>`.

## Comments and CLAUDE.md (PreToolUse guards)

Two guards keep prose out of places where it rots. Both deny the pending edit and ask Claude to re-issue it — nothing is written behind your back.

`comment-guard.js` rejects code comments Claude adds. A comment survives only where its absence risks a regression on the next edit, and then it must start with **`Не менять, потому что …`** (`Do not change because …` also accepted) — the rest belongs in the code itself: a function name instead of a section header, a named constant instead of a note about a magic number. Not treated as comments: functional directives (`eslint-disable`, `# type: ignore`, `# noqa`, shebang), license / `@generated` headers, and JSDoc blocks carrying tags (`@param`, `@returns`, …). Only comments the edit _adds_ count — re-quoting an existing one in `old_string` is free. Opt out with `MAIN_SKILL_COMMENT_CHECK=0`.

`claudemd-guard.js` keeps CLAUDE.md small: it denies an edit that appends ≥ `MAIN_SKILL_CLAUDEMD_MAXADD` net lines (default 20), and — regardless of the increment, creation included — any edit leaving the file above `MAIN_SKILL_CLAUDEMD_MAXBYTES` (default 40960, measured in UTF-8 bytes, so non-Latin docs are counted honestly). The block reason names the criterion: keep only what is derivable from neither code, nor tests, nor hooks; anything a test could assert or a hook could enforce belongs there instead. Opt out with `MAIN_SKILL_CLAUDEMD_CHECK=0`.

Hard opt-outs:

- `MAIN_SKILL_VERIFY_CHANGES=0` — disable all hook triggers.
- `MAIN_SKILL_VERIFY_LINT=0` — keep test/docs checks but skip auto-lint.
- `MAIN_SKILL_VERIFY_REVIEW=0` — disable J/K (self-review + review-triage).
- `MAIN_SKILL_VERIFY_REVIEW=code` — require only code-review section.
- `MAIN_SKILL_VERIFY_REVIEW=security` — require only security-review section.
- `MAIN_SKILL_VERIFY_PREMORTEM=0` — disable N (premortem block) and the `edge:` section requirement in self-review.
- `MAIN_SKILL_VERIFY_RENDER=0` — disable M (render-verification of frontend edits).
- `MAIN_SKILL_VERIFY_DEPS=0` — disable L (dep version-lookup enforcement). Useful for projects with a frozen lockfile where dep upgrades are batched manually.
- `MAIN_SKILL_VERIFY_TAIL_WAIT_MS=<ms>` — how long the Stop hook waits for Claude Code to finish appending the turn's final message to the transcript (default 2000, capped at 10000, polled every 100 ms). Without the wait the hook reads a tail that has no final message yet and silently lets the Stop through. Set `0` to restore the old no-wait behaviour.
- `MAIN_SKILL_VERIFY_TRACE=<path>` (or `=1` for `~/.claude/main-skill-verify-trace.jsonl`) — append one JSONL record per Stop-hook run with the exit point (`no-last-text`, `anti-loop`, `no-trigger`, `block`, …). Claude Code keeps neither stdout nor stderr of Stop hooks, so a silent pass is otherwise indistinguishable from "nothing to report". Off by default; the file stops growing past 5 MB.
- `MAIN_SKILL_IMPORT_SCAN_MAX_FILES=<n>` — raise trigger D's import-scan read budget (default 200, cap 10000) for monorepos with hundreds of centralized specs per package.
- `MAIN_SKILL_IGNORE_GLOB_CHECK=0` — disable the `ignore-glob-guard` PreToolUse hook (allow writing broad `dir/**` ignore-globs).
- `MAIN_SKILL_COMMENT_CHECK=0` — disable the `comment-guard` PreToolUse hook (projects whose convention mandates code comments).
- `MAIN_SKILL_CLAUDEMD_CHECK=0` / `MAIN_SKILL_CLAUDEMD_MAXADD=<n>` / `MAIN_SKILL_CLAUDEMD_MAXBYTES=<bytes>` — `claudemd-guard`: disable entirely / net added-lines threshold (default 20) / hard file-size cap (default 40960).

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
│   ├── hooks.json          # SessionStart + PreToolUse + PostToolUse + Stop hook registration
│   ├── session-start.sh    # remote-SHA check + plugin update + skill-invocation prompt
│   ├── ignore-glob-guard.js     # PreToolUse hook: deny writing broad MAIN_SKILL_VERIFY_IGNORE_GLOBS (dir/**)
│   ├── ignore-glob-guard.test.js # unit tests for ignore-glob-guard.js
│   ├── comment-guard.js    # PreToolUse hook: deny code comments other than "Не менять, потому что …"
│   ├── comment-guard.test.js # unit tests for comment-guard.js
│   ├── claudemd-guard.js   # PreToolUse hook: deny CLAUDE.md bloat (net added lines + 40 KB cap)
│   ├── claudemd-guard.test.js # unit tests for claudemd-guard.js
│   ├── auto-format.js      # PostToolUse hook: formats edited file via prettier / ruff / gofmt / rustfmt / clang-format
│   ├── auto-format.test.js # unit tests for auto-format.js
│   ├── verify-changes.js   # Stop hook: blocks "done" until tests, docs, lint, edge-cases declaration are in place
│   ├── verify-changes.test.js  # integration tests for verify-changes.js
│   └── lib/
│       ├── checks.js       # helpers: src↔test mapping, e2e detection, edge-cases parsing, auto-lint
│       ├── checks.test.js  # unit tests for checks.js
│       ├── audit-ignore-globs.js     # CLI behind /main-skill:check-ignore-globs — audit MAIN_SKILL_VERIFY_IGNORE_GLOBS
│       └── audit-ignore-globs.test.js # unit tests for audit-ignore-globs.js
├── CLAUDE.md               # dev-facing notes for plugin maintainers (auto-loaded as project-memory inside this repo only)
└── README.md
```

All user-facing workflow rules live in `SKILL.md`. `references/*.md` hold reference material that's verbose, hook-driven, or self-contained (linked from SKILL.md). `CLAUDE.md` in the repo root is for plugin-maintenance notes — it's auto-loaded only when editing this repo, not in consumer sessions.
