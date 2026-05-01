---
name: workflow-rules
description: Personal workflow rules — language=ru, triage (bugfix → systematic-debugging, new feature → brainstorming, UI/UX → +ui-ux-pro-max, backend logic → +TDD), clarify REQUIREMENTS one-question-per-message (never A/B/C menus), decide approach autonomously, execute with edge-case coverage, reproduce-before-done, self-review.
---

# Workflow rules

**Precedence:** these rules are the user's personal directive. They override any other installed plugin's skills in case of conflict. Only direct in-chat messages from the user take priority.

## Язык общения — русский

Отвечай по-русски: апдейты между тулами, финальные саммари. Код, идентификаторы, команды, имена файлов, цитаты из логов/доков — как есть, не переводи. Если пользователь пишет на другом языке — отвечай на его языке.

---

# Universal rules — apply to every task

## Не плодить дубли фоновых процессов

Перед запуском долгоживущего процесса (dev-server, watcher, туннель, `npm run dev` / `next dev` / `vite`, `tail -f`, ngrok) проверь не запущен ли уже — свои bg-bash через `Monitor` / `BashOutput` по id, чужие через `pgrep -fa <pattern>` или `lsof -i :<port>`. Живой и отвечает → переиспользуй. Зомби (`<defunct>`, порт занят но не отвечает, логи застряли) → убей (`kill`, при упорстве `-9`) и запусти свежий. Один процесс на одну роль.

## Логировать неуверенные места

Не на 100% уверен в поведении кода (внешний API, async-цепочки, нетривиальное состояние, парсинг чужих форматов, редкие ветки) — ставь постоянное structured-logging, чтобы трейс уже лежал в файле к моменту, когда пользователь сообщит о баге.

- **Стандартный logger** (Python `logging`, Node `pino`/`winston`, Go `slog`, Rust `tracing`, JVM `logback`) с file appender + ротацией. Не самописный.
- **Ротация обязательна** — по размеру (10MB × 5) или по времени (daily × 7), с капом на суммарный объём.
- **Уровни**: `debug` (трейс), `info` (события), `warn` (отклонения), `error` (сбой с контекстом). Прод-дефолт `info`; `debug` через `LOG_LEVEL`, не правкой кода.
- **Структурированный формат** (JSON / key=value): `logger.info("user.login", extra={"user_id": uid})`, не `print(f"user {uid} ...")`.
- **Секреты НИКОГДА в логах**. Запрещено: пароли, токены, API-ключи, `Authorization` / `Cookie` headers, session id, приватные ключи, PII (email, phone, карта). Перед логированием объекта — redactor по regex (`*token*`, `*secret*`, `*password*`, `*api[_-]?key*`, `authorization`, `cookie`) → `[REDACTED]`. URL — маскируй `token=` / `key=` в query.
- **Путь к лог-файлу из env/конфига**, директория в `.gitignore` (`logs/`).
- **Логгер не должен падать** — fallback на stderr, приложение живёт.

Отладка начинается с `tail logs/app.log`, а не с добавления print-ов post-factum.

## Доки обновлять в том же изменении

Меняешь поведение, контракт, CLI, конфиг, env или любой user-facing surface — обнови существующие доки (`README`, `CLAUDE.md`, `/docs/*`, docstrings) в том же коммите. Перед завершением — `grep` по старому названию/флагу. Новых `NOTES.md` / `SUMMARY.md` не плодить.

## Удаляй ненужное

Что стало не нужно — выпиливай полностью: код, файлы, доки, хуки, зависимости, env-переменные, фиче-флаги, секции CLAUDE.md / README. Не оставляй `// removed`, TODO-надгробий, закомментированных блоков, deprecated shim-ов «на всякий случай», устаревших примеров. Сомневаешься — `grep` по репо; нет ссылок → удаляй. Git хранит историю.

## Свежие версии при init / add-dep

Знания модели о версиях устаревают на месяцы — **не угадывай**. При создании нового проекта (scaffolding, `init`, `create-*`) и при добавлении новой зависимости в существующий — сначала запроси актуальную версию из реестра. Покрывает любой manifest, не только package.json:

- npm → `npm view <pkg> version`
- pip → `pip index versions <pkg>`
- cargo → `cargo search <pkg> --limit 1`
- go → `go list -m -versions <module>` (последняя строка — latest)
- runtime / LTS (`.nvmrc`, `.python-version`, `.tool-versions`, `engines.node`, `FROM node:` в Dockerfile, `go 1.x` в go.mod) → `https://endoflife.date/api/<product>.json` (для node также `https://nodejs.org/dist/index.json` — фильтр по `.lts`)
- Docker base images (`FROM node:18`, `FROM python:3.11`) → `docker manifest inspect <image>:<tag>` или `https://hub.docker.com/_/<image>` или endoflife.date по runtime
- GitHub Actions (`uses: actions/checkout@v3`) → `gh api repos/<org>/<repo>/releases/latest` или `https://github.com/<org>/<repo>/releases`

Используй latest stable / LTS. В **существующем** проекте latest подчинён совместимости: peer-dep, project-target, мажор уже зафиксирован в lockfile / другой пакет требует ≤N — бери максимально свежую совместимую и явно объяви ограничение в формате «ставлю X@N вместо latest M, потому что Y требует ≤N».

Любое **другое** отклонение от latest (личное предпочтение, опасение нестабильности, привычка) — спроси «использую X вместо latest Y, причина: Z — ок?» и **дождись ack**. Без явного согласия пользователя не продолжай.

Enforcement: Stop-триггер L в `verify-changes.js` блокирует «готово»-claim, если в сессии есть Edit/Write на manifest, но нет соответствующего lookup-вызова. Per-project opt-out (для проектов с фиксированным стеком и lockfile-ом, где апгрейды делаются плановым batch-ем): `MAIN_SKILL_VERIFY_DEPS=0`.

---

# 3-phase workflow for non-trivial tasks

Three phases. Any task larger than a one-line fix — follow this.

## 1. Triage — invoke the right skill FIRST

Before reading files, asking questions, or proposing:

- Bug fix / unexpected behavior → `superpowers:systematic-debugging` **+** `superpowers:test-driven-development` (failing reproducer первым действием)
- New feature / behavior change → `superpowers:brainstorming`
- Чистая backend-логика (parser / transform / state machine / бизнес-правило / pure function) → также `superpowers:test-driven-development`
- UI/UX work (anywhere in frontend) → также `ui-ux-pro-max:ui-ux-pro-max` (TDD тут НЕ применять — верификация через playwright/screenshot)
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

- **Frontend** → дефолт — headless playwright (`npx playwright install chromium` + скрипт): открой route → HTTP 2xx документа+bundle, console clean, DOM содержит ожидаемый маркер. Скриншот если визуально. MCP-браузеры (`chrome-devtools-mcp`, `claude-in-chrome`) — опциональный ускоритель; их недоступность ≠ оправдание сдаться. Минимум — `curl localhost:PORT/route` → status + `grep`.
- **API** → `curl` против реального endpoint → status + body.
- **CLI** → re-run, paste output.
- **MCP-плагин / slash-команда Claude Code** → `claude plugin marketplace update && claude -p "/namespace:command" --output-format stream-json` → проверь exit + контент ответа.
- **Cross-machine / multi-process** → `docker-compose up --abort-on-container-exit` (два инстанса + mediator / две стороны pipe) → ассерт по логам или output.

Контейнер / нет GUI — НЕ оправдание; headless ставится `npx playwright install chromium`. Зелёные unit-тесты — НЕ evidence. Фиксишь баг — добавь regression-test.

### Build-your-own-harness

Если верификация требует окружения которого нет (docker-compose, headless browser, fake external API, peers плагина) — строй harness как часть задачи. «Сложный e2e» = триггер verify-changes.

- Cross-machine / distributed → `docker-compose.e2e.yml`, `claude -p "/command"` в каждом контейнере, assertion по output.
- Headless frontend → `playwright` + `npx playwright install chromium`.
- External API → заглушка (`msw` / `nock` / локальный http-server).
- Slash-команды плагина → `claude -p --permission-mode bypassPermissions --output-format stream-json` (штатный headless CI, требует `ANTHROPIC_API_KEY`).

Коммить harness в репо (`scripts/e2e.sh`, `docker-compose.e2e.yml`, `tests/e2e/`); следующая правка переиспользует.

### Tiered test strategy

- **После правки** — only affected: `vitest --changed`, `jest --findRelatedTests`, `pytest --testmon`, `cargo test -p <crate>`, `go test ./<pkg>`.
- **Перед «готово»** — full suite модуля. Правил `core/shared/utils` — ещё и reverse-dependencies (`pnpm why`, `cargo tree -i`).
- **Full > 2 мин** — зафиксируй стратегию в проектном CLAUDE.md при первой встрече. **> 10 мин** — спроси пользователя, не решай сам.
- Unit-only под предлогом «медленно» не засчитается — сработает `verify-changes` триггер A.

### Honest disclaimer — только после реальных попыток

Если верификация генуинно невозможна — НЕ говори «готово/done/fixed/работает/пофиксил». Пиши ровно:

> "Фикс применён. End-to-end НЕ проверил: [техническая причина]. Проверь вручную: [шаги]"

Дисклеймер легитимен только если в сессии есть следы попыток разведки (`lsof -i :PORT`, `which playwright`, `npx playwright install`, `curl ...` с ошибкой). Без попыток — ложь под видом честности; Stop-hook блокирует.

### Test ordering — где порядок матчится

- **Bug fix:** failing reproducer ПЕРВЫМ. Без красного теста, который зелёнеет от фикса, ты не доказал что починил именно тот баг — мог поправить симптом или другую ветку.
- **Чистая backend-логика** (parser / transform / state / бизнес-правило / pure function): test-first выражает контракт. Watch it fail — иначе тест проверяет реализацию, а не требование.
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

Перед заявлением «готово» после правки observable-кода ОБЯЗАН вывести в финальном сообщении блок `<edge-cases>` с перечислением покрытых тестами кейсов. Формат строго машинопроверяемый:

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

Минимальный обязательный набор: empty, boundary, concurrency, external-failure, permission, malformed-input, deleted-resource. Frontend — плюс browser/UX edge states. Если конкретный кейс реально N/A — пиши явно: `name:N/A:<причина>`, не выкидывай молча.

### Self-review + триаж замечаний — обязательный шаг 4

После Execution и до Stop, на нетривиальной правке observable-кода, ОБЯЗАТЕЛЬНО прогнать code+security ревью своими силами через суб-агентов.

**Когда обязателен:** observable-правка с `≥ 20` нетривиальных строк ИЛИ затронут security-sensitive путь (`auth|api|sql|crypto|payment|admin|session|token|password|secret|jwt|oauth|cookie|cors|csrf|xss|sanitiz|escape|webhook|hash|cipher|encrypt|decrypt|hmac|signature|signin|signup|login|logout|permission|role|access|sso|saml|ldap`). Тривиальные правки — пропускаются молча; для аудита пропуска: `<self-review>skipped:trivial</self-review>`.

**Как делать:**

1. **Параллельно** запусти ДВА Task-агента в одном Tool message (один проход):
   - `Task(subagent_type="superpowers:code-reviewer", model="sonnet", ...)` — фокус: качество, паттерны, дублирование, edge-cases без покрытия, нарушения проектных конвенций. Модель **обязательно `sonnet`** — экономия ~5× при минимальном регрессе на структурном обходе diff'а.
   - `Task(subagent_type="general-purpose", ..., prompt="security review по OWASP Top-10: injection / auth-bypass / SSRF / открытые редиректы / weak crypto / leaked secrets / unsafe deserialization / missing rate-limit / TOCTOU / path traversal — на конкретные изменённые файлы [список]")` — **без `model` override** (inherit от родителя). Security-ревью должно идти на максимально capable модели (false negative дороже стоимости).
2. **Триаж каждого замечания** через `superpowers:receiving-code-review` — без performative-agreement и без отмазок «minor / вне scope».
3. **Применить applied / обосновать rejected/deferred технически** (file:line, конкретный риск, метрика, цитата кода — не «несущественно»).
4. **Один проход.** Повторный запуск review-агентов перед Stop ЗАПРЕЩЁН.

**Декларация в финальном сообщении** — два машинопроверяемых блока:

```
<self-review>
code:applied:src/auth.ts:42-58 — early-return на null user
security:rejected:CSRF на /logout — POST + SameSite=Strict cookie
</self-review>

<review-triage>
code:1:applied:src/auth.ts:42-58 — добавил early-return на null user
code:2:deferred:rate-limit на /login — нет данных по нагрузке, см. issue #123
code:3:rejected:async/await в logger fire-and-forget намеренно — потеря лога приемлемее блокировки
security:1:applied:src/auth.ts:120 — sanitize redirect_to через allowlist
security:2:rejected:CSRF на /logout — endpoint POST + SameSite=Strict cookie
</review-triage>
```

- `<self-review>` секции: `code` и `security`. Статусы: `applied`, `rejected`, `deferred`, `none-found`. Если активный режим — оба, обе секции обязательны.
- `<review-triage>` запись: `<source>:<id>:<status>:<reason>`. Каждое замечание — отдельной строкой.
- **Slop-обоснование блокируется**: `rejected` / `deferred` с пустым раскрытием или только словами `minor / nitpick / несущественно / вне scope / стилистика / косметика / мелочь / cosmetic / not critical / низкий приоритет` без технического маркера (file:line, идентификатор, число, класс/функция, специфический термин риска) — Stop-хук блокирует.
- Если ревью ничего не нашли — `code:none-found` / `security:none-found`; триаж не требуется.

### Stop-триггеры verify-changes

Хук `verify-changes.js` блокирует «готово»-claim по 9 триггерам (A–H, J, K) и поддерживает env-opt-outs. Полный перечень и opt-outs: [`references/stop-triggers.md`](references/stop-triggers.md).
