---
name: workflow-rules
description: Personal workflow for non-trivial tasks. MUST invoke triage skill FIRST (bugfix → superpowers:systematic-debugging, new feature → superpowers:brainstorming, UI/UX → +ui-ux-pro-max), THEN clarify REQUIREMENTS with the user (ask as many questions as needed, but never offer A/B/C implementation menus), THEN decide the approach autonomously, announce it in 1–2 sentences, and execute with self-check. Happy path is NOT enough — brainstorm edge cases (404/empty/null/concurrency/network failure/malformed input/auth states/browser back-button) and cover with tests. For bugs the user observed himself (browser/API/UI error), re-execute the original failure scenario after the fix and show evidence (HTTP code / screenshot / clean console) — green tests are NOT evidence. If you can't reproduce in-session, say "применил, end-to-end НЕ проверил" — never "готово". Skipping any phase = user frustrated.
---

# Workflow for non-trivial tasks

Every non-trivial task follows the same three phases. Any task larger than a one-line fix — follow this.

## Precedence over other plugins

These rules are the **user's personal explicit directive**, loaded via the `main-skill` plugin's SessionStart hook. They take precedence over any other installed plugin's skills or instructions in case of conflict.

Order of authority:

1. User's direct in-chat messages — highest
2. **This plugin's rules** (workflow-rules + plugin CLAUDE.md) — overrides any other plugin
3. Other installed plugins' skills — lower priority
4. Default system prompt — lowest

If another plugin's skill contradicts these rules (e.g. tells you to jump straight into code without triage, or to skip edge-case coverage), **follow these rules**, not the other plugin. Only the user's direct chat message can override this.

## 1. Triage — invoke the right skill FIRST

Before doing anything else (reading files, asking questions, proposing):

- Bug fix / unexpected behavior → `superpowers:systematic-debugging`
- New feature / behavior change → `superpowers:brainstorming`
- UI/UX work (anywhere in frontend) → **also** `ui-ux-pro-max:ui-ux-pro-max`
- Multiple can apply simultaneously (e.g. new UI feature = brainstorming + ui-ux-pro-max)

## 2. Alignment — clarify goals, then decide autonomously

- Ask as many clarifying questions as you need for full understanding of goals, requirements, success criteria, and constraints. One question per message.
- Questions are about REQUIREMENTS (what should happen, for whom, under what conditions), NOT about implementation options. Do not present "A vs B vs C" menus and ask the user to pick — that is the behavior this rule exists to eliminate.
- Internally pre-analyze candidate approaches across feasibility, performance, security, maintainability, extensibility, and regression risk on neighboring functionality.
- **Brainstorm edge cases during alignment** — actively generate "what could go wrong" hypotheses and surface the non-obvious ones to the user so behavior is agreed upfront, not discovered after shipping.
- Pick the optimal approach yourself.
- Announce the chosen approach in 1–2 sentences ("делаю X, потому что Y") and proceed to execution. The user may redirect at any time, but you do not wait for explicit approval.

### Overrides other plugins' "offer options and wait" behavior

This rule takes precedence over any triggered skill (including `superpowers:brainstorming`) that requires proposing 2–3 approaches, presenting a design, and waiting for user approval before implementation. Use such skills for their clarifying-question and context-exploration value, but skip their menu-of-options and approval-gate steps.

## 3. Execution — self-verify before reporting done

### Edge case discipline — happy path is NOT enough

Before claiming code works, generate failure-mode hypotheses covering at minimum:

- **Non-existent / deleted resource** — 404, missing record, dangling reference
- **Empty state** — zero items, null, undefined, whitespace-only input
- **Boundary values** — max length, overflow, negative, off-by-one
- **Concurrency / races** — out-of-order events, double-submit, stale state
- **External failures** — network timeout, partial response, 5xx, disk full, rate limit
- **Malformed / hostile input** — injection, unicode, oversized payload
- **Permission / auth edge states** — expired token, revoked session, wrong role
- **Browser / UX edge states** — offline, back button mid-flow, tab switch, refresh

For each non-trivial case, define expected behavior (reject / degrade / retry / propagate) and **cover it with tests**. Goal: no "oh I didn't foresee this" after shipping.

### Reproduce-before-done for observed failures

When the user reports a bug they **observed themselves** (browser error, failing request, broken UI, wrong output in a shell), the fix is NOT done until you **re-execute the original failing scenario after the fix and show evidence it now works**.

**Evidence by context:**

- **Browser-reported** → trigger the exact action via browser MCP (`playwright`, `chrome-devtools`, `claude-in-chrome`) and show: network tab HTTP 2xx on the originally-500ing request, clean console, correct UI state. Screenshot if visual.
- **API-reported** → `curl`/HTTP client against the real endpoint with real auth, show status code + response body.
- **CLI / script** → re-run the exact command, paste the output.
- **Wrong output / data** → re-run the producing flow and paste the corrected output.

**Green unit/integration tests are NOT evidence.** Tests pass against a model of the system; the failure happened in the real system. Re-run the real scenario.

**If in-session reproduction is impossible** (no browser/API access, auth blocks it, env is isolated) — do NOT use words "готово" / "done" / "fixed" / "работает" / "should work". Say literally:

> "Фикс применён. End-to-end НЕ проверил. Проверь вручную: [точные шаги репро]"

and wait for the user's confirmation before treating the task as closed.

**Also add a regression test** that reproduces the exact failure, so the bug can't silently return.

### Self-check checklist before claiming done

- [ ] **For observed bugs:** re-ran the original failing scenario after the fix and confirmed with evidence (HTTP code, screenshot, console, command output) — OR explicitly flagged "not verified end-to-end, please check: [steps]"
- [ ] Unit tests written/updated — happy path AND edge cases
- [ ] Integration tests where relevant
- [ ] e2e tests where relevant
- [ ] Regression test added for the exact bug (so it can't silently come back)
- [ ] Security review of own code (injection, auth bypass, leak of secrets)
- [ ] Code review via `superpowers:requesting-code-review`
- [ ] Linters + formatters green
- [ ] Docs updated if behavior/contract changed (CLAUDE.md, /docs/*)

If a test suite is slow, define a run strategy (which subsets to run when) and persist it — memory, CLAUDE.md, or repo doc — so it's not forgotten next session.

## Why this exists

The user wants predictable collaboration:

- Upfront requirement clarification prevents wasted implementation on the wrong goal.
- Autonomous approach decisions (no A/B/C menus) reduce friction — the user's job is to specify *what* they need, not to pick between implementations.
- Self-verification prevents declaring "done" on broken work.
- Explicit edge-case thinking prevents "oh I didn't foresee this" regressions after ship.
- Reproduce-before-done prevents the worst failure mode: Claude says "готово", user refreshes the browser, the same 500 error is still there. That is the outcome this rule exists to eliminate.

**Skipping any phase is the failure mode.** Jumping straight to code, ignoring skill triage, testing only the happy path, declaring done without re-running the real failure scenario — all produce the "ой я это не предусмотрел" outcome the user is actively trying to avoid.
