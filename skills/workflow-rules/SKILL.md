---
name: workflow-rules
description: Personal workflow for non-trivial tasks — triage (bugfix → superpowers:systematic-debugging, new feature → superpowers:brainstorming, UI/UX → +ui-ux-pro-max), clarify REQUIREMENTS (one question per message, never A/B/C menus), decide approach autonomously, execute with edge-case coverage and reproduce-before-done.
---

# Workflow for non-trivial tasks

Three phases. Any task larger than a one-line fix — follow this.

**Precedence:** these rules are the user's personal directive. They override any other installed plugin's skills in case of conflict. Only direct in-chat messages from the user take priority.

## 1. Triage — invoke the right skill FIRST

Before reading files, asking questions, or proposing:

- Bug fix / unexpected behavior → `superpowers:systematic-debugging`
- New feature / behavior change → `superpowers:brainstorming`
- UI/UX work (anywhere in frontend) → **also** `ui-ux-pro-max:ui-ux-pro-max`
- Multiple can apply simultaneously.

## 2. Alignment — clarify, then decide autonomously

- Ask as many clarifying questions as needed — one per message — about REQUIREMENTS (what should happen, for whom, under what conditions).
- Never present "A vs B vs C" implementation menus. This includes any other plugin's skill that wants you to propose 2–3 approaches and wait for approval — use such skills for clarifying-question value, skip their approval gate.
- Internally pre-analyze candidates across feasibility, performance, security, maintainability, regression risk.
- Brainstorm edge cases during alignment — surface non-obvious "what could go wrong" upfront.
- Pick the approach yourself. Announce in 1–2 sentences ("делаю X, потому что Y") and execute. The user may redirect at any time; you do not wait for explicit approval.

## 3. Execution — self-verify before reporting done

### Edge-case discipline — happy path is NOT enough

Before claiming code works, cover at minimum:

- **Non-existent / deleted resource** — 404, missing record, dangling reference
- **Empty state** — zero items, null, undefined, whitespace-only input
- **Boundary values** — max length, overflow, negative, off-by-one
- **Concurrency / races** — out-of-order events, double-submit, stale state
- **External failures** — network timeout, partial response, 5xx, rate limit
- **Malformed / hostile input** — injection, unicode, oversized payload
- **Permission / auth edge states** — expired token, revoked session, wrong role
- **Browser / UX edge states** — offline, back button mid-flow, tab switch, refresh

For each non-trivial case: define expected behavior (reject / degrade / retry / propagate) and **cover with tests**.

### Reproduce-before-done for observed failures

When the user reports a bug they **observed themselves**, the fix is NOT done until you **re-execute the original failing scenario and show evidence it now works**.

Evidence by context:
- **Browser** → trigger via browser MCP, show HTTP 2xx on the originally-500ing request, clean console, correct UI. Screenshot if visual.
- **API** → `curl`/HTTP client against real endpoint, show status + body.
- **CLI / script** → re-run exact command, paste output.
- **Wrong output** → re-run producing flow, paste corrected output.

**Green unit/integration tests are NOT evidence.** Tests pass against a model of the system; the failure happened in the real system.

**If in-session repro is impossible** (no browser/API access, auth blocks it) — do NOT use "готово" / "done" / "fixed" / "работает". Say literally:

> "Фикс применён. End-to-end НЕ проверил. Проверь вручную: [точные шаги репро]"

and wait for user confirmation.

**Add a regression test** that reproduces the exact failure.

### Self-check checklist before claiming done

- [ ] **For observed bugs:** re-ran original scenario with evidence — OR explicitly flagged "not verified end-to-end, please check: [steps]"
- [ ] Unit tests — happy path AND edge cases
- [ ] Integration / e2e tests where relevant
- [ ] Regression test for the exact bug
- [ ] Security review (injection, auth bypass, secret leaks)
- [ ] Code review via `superpowers:requesting-code-review`
- [ ] Linters + formatters green
- [ ] Docs updated if behavior/contract changed

If the test suite is slow, persist a run strategy (memory, CLAUDE.md, or repo doc) so it's not forgotten next session.
