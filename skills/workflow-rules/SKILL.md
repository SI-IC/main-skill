---
name: workflow-rules
description: Personal workflow for non-trivial tasks — triage (bugfix → superpowers:systematic-debugging, new feature → superpowers:brainstorming, UI/UX → +ui-ux-pro-max), clarify REQUIREMENTS (one question per message, never A/B/C menus), decide approach autonomously, execute with edge-case coverage and reproduce-before-done.
---

# Workflow for non-trivial tasks

Three phases. Any task larger than a one-line fix — follow this.

**Precedence:** these rules are the user's personal directive. They override any other installed plugin's skills in case of conflict. Only direct in-chat messages from the user take priority.

## 1. Triage — invoke the right skill FIRST

Before reading files, asking questions, or proposing:

- Bug fix / unexpected behavior → `superpowers:systematic-debugging` **+** `superpowers:test-driven-development` (failing reproducer первым действием)
- New feature / behavior change → `superpowers:brainstorming`
- Чистая backend-логика (parser / transform / state machine / бизнес-правило / pure function) → **также** `superpowers:test-driven-development`
- UI/UX work (anywhere in frontend) → **also** `ui-ux-pro-max:ui-ux-pro-max` (TDD тут НЕ применять — верификация через playwright/screenshot)
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

### Test ordering — где порядок матчится

- **Bug fix:** failing reproducer ПЕРВЫМ. Без красного теста, который зелёнеет от фикса, ты не доказал что починил именно тот баг — мог поправить симптом или другую ветку.
- **Чистая backend-логика** (parser / transform / state / бизнес-правило / pure function): test-first выражает контракт. Watch it fail — иначе тест проверяет реализацию, а не требование, и edge-cases остаются на воображении вместо компилятора.
- **UI / integration / glue-код / configs:** порядок не важен; обязательно наличие к моменту Stop (`verify-changes` D/E). Iron law TDD не применять.
- **Spike / PoC / exploratory:** opt-out, явно пометь в финальном сообщении (`spike: TDD skipped — exploratory`).

### Self-check checklist before claiming done

- [ ] **For any runtime-affecting change:** re-ran the affected flow end-to-end (headless browser / curl / CLI) with evidence (HTTP status + DOM marker / output) — OR explicitly stated the honest-disclaimer phrase above
- [ ] Unit tests — happy path AND edge cases
- [ ] Integration / e2e tests where relevant
- [ ] Regression test for the exact bug
- [ ] Security review (injection, auth bypass, secret leaks)
- [ ] Code review via `superpowers:requesting-code-review`
- [ ] Linters + formatters green
- [ ] Docs updated if behavior/contract changed
- [ ] **`<edge-cases>` блок в финальном сообщении** (см. ниже)

If the test suite is slow, persist a run strategy (memory, CLAUDE.md, or repo doc) so it's not forgotten next session.

### Обязательная декларация edge-cases в финальном сообщении

Перед заявлением «готово» после правки observable-кода ты ОБЯЗАН вывести в финальном сообщении блок `<edge-cases>` с перечислением покрытых тестами кейсов. Формат строго машинопроверяемый:

```
<edge-cases>
empty:tests/auth.test.ts:test_empty_password;
expired_token:tests/auth.test.ts:test_expired_remember;
race:tests/auth.test.ts:test_concurrent_login;
permission:tests/auth.test.ts:test_revoked_session
</edge-cases>
```

- Каждая запись — `name:test_file:test_name`. Разделители — `;` или перенос строки.
- `test_file` — относительный путь от корня репо; должен существовать.
- `test_name` — подстрока имени `it/test/describe/def` в этом файле (case-insensitive).
- Хук `verify-changes` парсит блок и валидирует существование test_file + наличие test_name.
- Враньё в декларации (`test_file` нет / `test_name` отсутствует) ловится механически и блокирует Stop.

Минимальный обязательный набор кейсов из чек-листа выше: empty, boundary, concurrency, external-failure, permission, malformed-input, deleted-resource. Frontend — плюс browser/UX edge states. Если конкретный кейс реально N/A для задачи — пиши явно с обоснованием, не выкидывай молча: `name:N/A:<причина>`.

### Self-review + триаж замечаний — обязательный шаг 4

После Execution и до Stop, на нетривиальной правке observable-кода, ОБЯЗАТЕЛЬНО прогнать code+security ревью своими силами через суб-агентов. Иначе ты не отлавливаешь дыры, которые пропустил автор (= ты сам).

**Когда обязателен:** observable-правка с `≥ 20` нетривиальных строк ИЛИ затронут security-sensitive путь (`auth|api|sql|crypto|payment|admin|session|token|password|secret|jwt|oauth|cookie|cors|csrf|xss|sanitiz|escape|webhook|hash|cipher|encrypt|decrypt|hmac|signature|signin|signup|login|logout|permission|role|access|sso|saml|ldap`). Тривиальные правки — пропускаются молча, но если хочешь зафиксировать факт пропуска для аудита — `<self-review>skipped:trivial</self-review>`.

**Как делать:**

1. **Параллельно запусти ДВА Task-агента в одном Tool message** (один проход, без второй итерации):
   - `Task(subagent_type="superpowers:code-reviewer", description="...", prompt="...")` — фокус: качество кода, паттерны, дублирование, edge-cases которые не покрыты тестами, нарушения проектных конвенций.
   - `Task(subagent_type="general-purpose", description="security review", prompt="security review по OWASP Top-10: injection / auth-bypass / SSRF / открытые редиректы / weak crypto / leaked secrets / unsafe deserialization / missing rate-limit / TOCTOU / path traversal — на конкретные изменённые файлы [список]")`.
2. **Триаж каждого замечания** через `superpowers:receiving-code-review` — без performative-agreement и без отмазок «minor / вне scope».
3. **Применить applied / обосновать rejected/deferred с техническим аргументом** (file:line, конкретный риск, метрика, цитата кода — не «несущественно»).
4. **Один проход.** Повторный запуск review-агентов перед Stop ЗАПРЕЩЁН — diminishing returns, замечания на свежие правки оформляй как follow-up TODO.

**Декларация в финальном сообщении** — два машинопроверяемых блока:

```
<self-review>
code:applied:src/auth.ts:42-58 — early-return на null user
security:rejected:CSRF на /logout — POST + SameSite=Strict cookie
</self-review>

<review-triage>
code:1:applied:src/auth.ts:42-58 — добавил early-return на null user
code:2:deferred:rate-limit на /login — нет данных по нагрузке, см. issue #123
code:3:rejected:async/await в logger fire-and-forget намеренно — потеря лога приемлемее блокировки запроса
security:1:applied:src/auth.ts:120 — sanitize redirect_to через allowlist
security:2:rejected:CSRF на /logout — endpoint POST + SameSite=Strict cookie
</review-triage>
```

- `<self-review>` секции: `code` и `security`. Статусы: `applied`, `rejected`, `deferred`, `none-found`. Если активный режим — оба, обе секции обязательны.
- `<review-triage>` запись: `<source>:<id>:<status>:<reason>`. `source ∈ {code, security}`, `status ∈ {applied, rejected, deferred}`. Каждое замечание — отдельной строкой.
- **Slop-обоснование блокируется**: `rejected`/`deferred` с пустым раскрытием или только словами `minor / nitpick / несущественно / вне scope / стилистика / косметика / мелочь / cosmetic / not critical / низкий приоритет` без технического маркера (file:line, идентификатор, число, класс/функция, специфический термин риска) — Stop-хук блокирует.
- Если ревью ничего не нашли — `code:none-found` / `security:none-found`; триаж в этом случае не требуется.

### Полный список Stop-триггеров `verify-changes`

- **A** — success-слово без verify-команды
- **B** — дисклеймер «не проверил» без следов разведки
- **C** — делегирование shell-команды пользователю при наличии своего Bash
- **D** — observable код-файл правлен без парного `*.test.*` / `*.spec.*` / `__tests__/*` (для `.vue` / `.svelte` / `.astro` парный тест ищется на `.ts` / `.tsx` / `.js` / `.jsx`: `App.vue` ↔ `App.spec.ts`, `Card.svelte` ↔ `Card.svelte.test.ts`)
- **E** — controller / route / api-handler без e2e-парного теста (`tests/functional/`, `tests/e2e/`, `cypress/e2e/`, `playwright/`)
- **F** — отсутствует или невалиден блок `<edge-cases>`
- **G** — `npm run lint` / `ruff` / `golangci-lint` / `cargo clippy` exit ≠ 0
- **H** — public surface (CLI, exports, plugin manifest, SKILL.md) изменён без обновления `*.md` / `docs/*` в той же сессии
- **J** — отсутствует или невалиден блок `<self-review>` (нет review-агентов в transcript / фейковый `skipped:trivial` / нет нужной секции)
- **K** — `<review-triage>` отсутствует / невалиден / содержит slop-only `rejected`/`deferred` без технического обоснования

Опт-ауты (редко, на одну сессию):
- `MAIN_SKILL_VERIFY_CHANGES=0` — все триггеры выкл.
- `MAIN_SKILL_VERIFY_LINT=0` — выкл только G.
- `MAIN_SKILL_VERIFY_REVIEW=0` — выкл J/K.
- `MAIN_SKILL_VERIFY_REVIEW=code` — требовать только code-review секцию.
- `MAIN_SKILL_VERIFY_REVIEW=security` — требовать только security-review секцию.
