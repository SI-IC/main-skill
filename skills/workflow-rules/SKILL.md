---
name: workflow-rules
description: Personal workflow for non-trivial tasks. MUST invoke triage skill FIRST (bugfix → superpowers:systematic-debugging, new feature → superpowers:brainstorming, UI/UX → +ui-ux-pro-max), THEN clarify REQUIREMENTS with the user (ask as many questions as needed, but never offer A/B/C implementation menus), THEN decide the approach autonomously, announce it in 1–2 sentences, and execute with self-check. Happy path is NOT enough — brainstorm edge cases (404/empty/null/concurrency/network failure/malformed input/auth states/browser back-button) and cover with tests. Skipping any phase = user frustrated.
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

### Self-check checklist before claiming done

- [ ] Unit tests written/updated — happy path AND edge cases
- [ ] Integration tests where relevant
- [ ] e2e tests where relevant
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

**Skipping any phase is the failure mode.** Jumping straight to code, ignoring skill triage, testing only the happy path — all produce the "ой я это не предусмотрел" outcome the user is actively trying to avoid.
