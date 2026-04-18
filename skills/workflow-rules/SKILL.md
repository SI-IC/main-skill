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

### Reproduce-before-done — evidence, not vibes

For ANY change that affects observable runtime behaviour (frontend page/component, API endpoint, CLI output, background job) — the change is NOT done until you **execute the affected flow end-to-end and paste evidence**. Не только при репорте бага — при любой правке поведения.

Evidence by context:
- **Frontend / browser** → headless browser (`playwright` / `puppeteer` / `chrome-devtools-mcp` / `claude-in-chrome`): открой affected route, проверь HTTP 2xx документа **и** JS bundle, console без ошибок, DOM содержит ожидаемый элемент/текст. Скриншот если визуально. Минимальный fallback: `curl http://localhost:PORT/route` → HTTP status + `grep` ожидаемого маркера в HTML.
- **API / backend** → `curl`/HTTP-клиент против реального endpoint с реалистичным payload → status + body.
- **CLI / script** → re-run exact command, paste output.
- **Wrong output** → re-run producing flow, paste corrected output.

**Контейнер / нет GUI / headless-сервер — НЕ оправдание.** Headless-браузеры работают везде. Нет playwright — поставь (`npx playwright install chromium`). Нет браузера вообще — `curl` + `grep` минимум.

**Зелёные unit/integration тесты — это НЕ evidence.** Тесты проходят против модели системы; падение случилось в реальной системе.

**Add a regression test** when fixing an observed bug.

### Honest disclaimer — только после реальных попыток разведки

Если верификация **генуинно** невозможна — НЕ говори «готово/done/fixed/работает/пофиксил». Используй ровно эту фразу:

> "Фикс применён. End-to-end НЕ проверил, потому что [конкретная техническая причина с цитатой ошибки]. Проверь вручную: [точные шаги репро]"

Но дисклеймер легитимен **только** если в этой же сессии есть следы реальной разведки окружения:
- `lsof -i :PORT` / `ss -tlnp` / `netstat` — есть ли dev-server
- `which playwright` / `command -v chromium` — что вообще доступно
- `npx playwright install chromium` — попытка установить
- `curl -fsS http://localhost:PORT/...` — даже connection refused это инфа
- попытка поднять `npm run dev` / `next dev` / `vite` если процесса нет

**Дисклеймер без единой попытки = ложь под видом честности**. Stop-hook `verify-frontend.js` блокирует оба паттерна:
- **Триггер A**: success-слово + правка фронта + 0 верификаций после правки
- **Триггер B**: дисклеймер «не проверил» + правка фронта + 0 попыток разведки после правки

Опт-аут (используй редко, для оффлайн-задач, скриптов сборки и т.п.): `export MAIN_SKILL_VERIFY_FRONTEND=0`.

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
