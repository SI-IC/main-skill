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
- Pick the approach yourself. Announce as **«делаю X вместо Y, потому что Z»** — обязательно назови отвергнутую альтернативу, не только выбранную (ловит пропуск очевидного пути). Execute; user may redirect at any time.

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

### Reproduce-before-done — evidence, not vibes

Любая правка observable behaviour (фронт, API, CLI, job, MCP-плагин, cross-machine) — НЕ done, пока не выполнил flow и не вставил пруфы.

- **Frontend** → **дефолт — headless playwright** (`npx playwright install chromium` + скрипт): открой route → HTTP 2xx документа+bundle, console clean, DOM содержит ожидаемый маркер. Скриншот если визуально. MCP-браузеры (`chrome-devtools-mcp`, `claude-in-chrome`) — опциональный ускоритель; **их недоступность ≠ оправдание сдаться**, ставь playwright. Минимум — `curl localhost:PORT/route` → status + `grep`.
- **API** → `curl` против реального endpoint → status + body.
- **CLI** → re-run, paste output.
- **MCP-плагин / slash-команда Claude Code** → `claude plugin marketplace update && claude -p "/namespace:command" --output-format stream-json` → проверь exit + контент ответа.
- **Cross-machine / multi-process** → `docker-compose up --abort-on-container-exit` (два инстанса + mediator / две стороны pipe) → ассерт по логам или output.

Контейнер / нет GUI — НЕ оправдание; headless ставится `npx playwright install chromium`. Зелёные unit-тесты — НЕ evidence. Фиксишь баг — добавь regression-test.

### Build-your-own-harness

Если верификация требует окружения которого нет (docker-compose, headless browser, fake external API, peers плагина) — **строй harness как часть задачи**. «Сложный e2e» = триггер verify-changes.

- Cross-machine / distributed → `docker-compose.e2e.yml`, `claude -p "/command"` в каждом контейнере, assertion по output.
- Headless frontend → `playwright` + `npx playwright install chromium`.
- External API → заглушка (`msw` / `nock` / локальный http-server).
- Slash-команды плагина → `claude -p --permission-mode bypassPermissions --output-format stream-json` (штатный headless CI, требует `ANTHROPIC_API_KEY`).

Коммить harness в репо (`scripts/e2e.sh`, `docker-compose.e2e.yml`, `tests/e2e/`); следующая правка переиспользует.

### Tiered test strategy

- **После правки** — only affected: `vitest --changed`, `jest --findRelatedTests`, `pytest --testmon`, `cargo test -p <crate>`, `go test ./<pkg>`.
- **Перед «готово»** — full suite модуля. Правил `core/shared/utils` — ещё и reverse-dependencies (`pnpm why`, `cargo tree -i`).
- **Full > 2 мин** — зафиксируй стратегию в проектном `CLAUDE.md` при первой встрече. `> 10 мин` — спроси пользователя, не решай сам.
- Unit-only под предлогом «медленно» не засчитается как верификация — сработает `verify-changes` триггер A.

### Honest disclaimer — только после реальных попыток

Если верификация генуинно невозможна — НЕ говори «готово/done/fixed/работает/пофиксил». Пиши ровно:

> "Фикс применён. End-to-end НЕ проверил: [техническая причина]. Проверь вручную: [шаги]"

Дисклеймер легитимен только если в сессии есть следы попыток разведки (`lsof -i :PORT`, `which playwright`, `npx playwright install`, `curl ...` с ошибкой). Без попыток — ложь под видом честности; Stop-hook блокирует.

### Self-check checklist before claiming done

- [ ] **For any runtime-affecting change:** re-ran the affected flow end-to-end (headless browser / curl / CLI) with evidence (HTTP status + DOM marker / output) — OR explicitly stated the honest-disclaimer phrase above
- [ ] Unit tests — happy path AND edge cases
- [ ] Integration / e2e tests where relevant
- [ ] Regression test for the exact bug
- [ ] Security review (injection, auth bypass, secret leaks)
- [ ] Code review via `superpowers:requesting-code-review`
- [ ] Linters + formatters green
- [ ] Docs updated if behavior/contract changed

If the test suite is slow, persist a run strategy (memory, CLAUDE.md, or repo doc) so it's not forgotten next session.
