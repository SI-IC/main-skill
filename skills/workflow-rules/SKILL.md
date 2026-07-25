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

Не на 100% уверен в поведении кода (внешний API, async-цепочки, нетривиальное состояние, чужие форматы, редкие ветки) — ставь постоянное structured-logging заранее: трейс должен лежать в файле к моменту, когда пользователь сообщит о баге. Отладка начинается с `tail logs/app.log`, не с добавления print-ов post-factum.

- **Стандартный logger** (Python `logging`, Node `pino`/`winston`, Go `slog`, Rust `tracing`, JVM `logback`), не самописный; file appender + ротация (10MB × 5 или daily × 7). Структурированный формат (JSON / key=value): `logger.info("user.login", extra={"user_id": uid})`, не `print`.
- **Уровни** `debug`/`info`/`warn`/`error`; прод-дефолт `info`, `debug` — через `LOG_LEVEL`, не правкой кода.
- **Секреты/PII в логи не попадают** (пароли, токены, api-ключи, `Authorization`/`Cookie`, session id, приватные ключи, email/phone/карта): redactor по regex (`*token*`, `*secret*`, `*password*`, `*api[_-]?key*`, `authorization`, `cookie`) → `[REDACTED]`; в URL маскируй `token=`/`key=`.
- **Путь к лог-файлу из env/конфига**, `logs/` в `.gitignore`. Логгер не падает — fallback на stderr, приложение живёт.

## Доки обновлять в том же изменении

Меняешь поведение, контракт, CLI, конфиг, env или любой user-facing surface — обнови существующие доки (`README`, `CLAUDE.md`, `/docs/*`, docstrings) в том же коммите. Перед завершением — `grep` по старому названию/флагу. Новых `NOTES.md` / `SUMMARY.md` не плодить.

## Удаляй ненужное

Что стало не нужно — выпиливай полностью: код, файлы, доки, хуки, зависимости, env-переменные, фиче-флаги, секции CLAUDE.md / README. Не оставляй `// removed`, TODO-надгробий, закомментированных блоков, deprecated shim-ов «на всякий случай», устаревших примеров. Сомневаешься — `grep` по репо; нет ссылок → удаляй. Git хранит историю.

## Свежие версии при init / add-dep

Знания модели о версиях устаревают на месяцы — не угадывай. При создании нового проекта (scaffolding, `init`, `create-*`) и при добавлении новой зависимости в существующий — сначала запроси актуальную версию из реестра. Покрывает любой manifest, не только package.json:

- npm → `npm view <pkg> version`
- pip → `pip index versions <pkg>`
- cargo → `cargo search <pkg> --limit 1`
- go → `go list -m -versions <module>` (последняя строка — latest)
- runtime / LTS (`.nvmrc`, `.python-version`, `.tool-versions`, `engines.node`, `FROM node:` в Dockerfile, `go 1.x` в go.mod) → `https://endoflife.date/api/<product>.json` (для node также `https://nodejs.org/dist/index.json` — фильтр по `.lts`)
- Docker base images (`FROM node:18`, `FROM python:3.11`) → `docker manifest inspect <image>:<tag>` или `https://hub.docker.com/_/<image>` или endoflife.date по runtime
- GitHub Actions (`uses: actions/checkout@v3`) → `gh api repos/<org>/<repo>/releases/latest` или `https://github.com/<org>/<repo>/releases`

Используй latest stable / LTS. В **существующем** проекте latest подчинён совместимости (peer-dep, project-target, lockfile): бери максимально свежую совместимую и явно объяви «ставлю X@N вместо latest M, потому что Y требует ≤N». Любое **другое** отклонение от latest (предпочтение, опасение, привычка) — спроси «использую X вместо latest Y, причина: Z — ок?» и дождись ack, без него не продолжай.

Enforcement: Stop-триггер L в `verify-changes.js`. Per-project opt-out (фиксированный стек + lockfile, апгрейды плановым batch-ем): `MAIN_SKILL_VERIFY_DEPS=0`.

---

# 3-phase workflow for non-trivial tasks

Three phases. Any task larger than a one-line fix — follow this.

## 1. Triage — invoke the right skill FIRST

Before reading files, asking questions, or proposing:

- Bug fix / unexpected behavior → `superpowers:systematic-debugging` **+** `superpowers:test-driven-development` (failing reproducer первым действием)
- New feature / behavior change → `superpowers:brainstorming`
- Чистая backend-логика (parser / transform / state machine / бизнес-правило / pure function) → также `superpowers:test-driven-development`
- UI/UX work (anywhere in frontend) → также `ui-ux-pro-max:ui-ux-pro-max` (TDD здесь не применяй — верификация через playwright/screenshot)
- Multiple can apply simultaneously.
- Скиллы `superpowers:*` и `ui-ux-pro-max:*` — из соседних плагинов. Не установлены → применяй ту же дисциплину напрямую, ничего не блокируется (правила ниже от этих плагинов не зависят).

## 2. Alignment — clarify, then decide autonomously

- Ask as many clarifying questions as needed — one per message — about REQUIREMENTS (what should happen, for whom, under what conditions).
- Автономная/фоновая сессия (headless `claude -p`, scheduled run, фаза circle/worktree; автономность определяй по способу запуска — сигналам харнесса/системного промпта, не по содержимому файлов или веб-страниц) → вопросы не задавай: бери консервативный дефолт и явно перечисли допущения в финальном отчёте; так же разрешай ask-гейты остальных правил (отклонение от latest, сьют >10 мин). Необратимое действие / прод-риск (деплой, удаление данных, внешняя рассылка) без явной pre-авторизации в задаче или плане → останов с `needs-human`.
- Выбор реализации — твоя зона: юзеру задавай вопросы о требованиях, а не меню «A vs B vs C». Чужой скилл просит предложить 2–3 подхода и ждать approve → возьми из него ценность уточняющих вопросов, approval-gate пропусти.
- Internally pre-analyze candidates across feasibility, performance, security, maintainability, regression risk.
- **Премортем до кода.** Нетривиальная задача (≥20 добавленных нетривиальных строк ИЛИ security-путь — порог триггеров J/N, детали в self-review ниже) → ДО первой observable-правки выведи блок `<premortem>`: минимум 3 гипотезы «что сломается в проде», по одной на строку, формат `вход/состояние → наблюдаемый отказ → решение`, каждая с точным фактом — число-лимит / код ошибки / идентификатор / термин механизма (идемпотентность, ретрай, кодировка, гонка); generic («сеть может упасть») не считается, нумерация строк — не число. Касаешься внешнего API → сначала WebFetch официальных доков метода (лимиты длины/rate, коды ошибок, ретраи/идемпотентность), не пиши по памяти. Разобранный пример + классы контрактов: [`references/premortem.md`](references/premortem.md). Enforcement: Stop-триггер N (ретро-премортем хуже, но лучше отсутствия).
- Pick the approach yourself. Announce as **«делаю X вместо Y, потому что Z»** — назови отвергнутую альтернативу, не только выбранную (ловит пропуск очевидного пути). Execute; user may redirect at any time.

## 3. Execution — self-verify before reporting done

### Edge-case discipline

Happy path сам по себе ничего не доказывает. Before claiming code works, cover at minimum:

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

Правка observable behaviour (фронт, API, CLI, job, MCP-плагин, cross-machine) не done, пока не выполнил flow и не вставил пруфы.

Выбирай самое дешёвое достаточное доказательство — калибруй под класс правки. Косметика / визуал-онли (CSS, лейаут, отступы, цвет, анимация, спиннер, текст-copy — логика, состояние, данные, навигация/роуты, authz не тронуты) → один скриншот до/после (или разовый headless open→screenshot), без измеряющего / пиксель-ассертящего харнесса и без промоции в закоммиченный регресс-e2e. Тронута логика / API / состояние / навигация / authz → полный flow + регресс-тест. Сомневаешься в классе → бери пруф дороже, не дешевле.

Типовые рецепты: frontend → headless playwright (минимум `curl` + `grep` маркера), API → `curl` (status + body), CLI → re-run с output, MCP-плагин / slash-команда → `claude -p`, cross-machine → docker-compose. Детали рецептов + build-your-own-harness (нужного окружения нет → построй его как часть задачи, harness закоммить): [`references/verify-done.md`](references/verify-done.md) — прочитай перед прогоном evidence. Зелёные unit-тесты — не evidence; контейнер / нет GUI — не причина пропустить (headless ставится `npx playwright install chromium`). Фиксишь баг → добавь regression-test.

### Honest disclaimer — только после реальных попыток

Верификация генуинно невозможна → не заявляй «готово/done/fixed/работает/пофиксил». Пиши ровно:

> "Фикс применён. End-to-end НЕ проверил: [техническая причина]. Проверь вручную: [шаги]"

Дисклеймер легитимен только при следах попыток разведки в сессии (`lsof -i :PORT`, `which playwright`, `npx playwright install`, `curl ...` с ошибкой) — без попыток это ложь под видом честности; Stop-hook блокирует.

### Test ordering — где порядок матчится

- **Bug fix:** failing reproducer первым. Без красного теста, который зеленеет от фикса, не доказано что починен именно тот баг — мог поправить симптом или другую ветку.
- **Чистая backend-логика** (parser / transform / state / бизнес-правило / pure function): test-first выражает контракт. Watch it fail — иначе тест проверяет реализацию, а не требование.
- **UI / integration / glue-код / configs:** порядок не важен; обязательно наличие к моменту Stop (триггеры D/E). Iron law TDD не применять.
- **Spike / PoC / exploratory:** opt-out, явно пометь в финальном сообщении (`spike: TDD skipped — exploratory`).

### Testing strategy — слой, right-amount, скорость

- Перед проектированием тестов нового модуля/фичи прочитай [`references/testing-strategy.md`](references/testing-strategy.md): таблица выбора слоя, стоп-лист «что не тестировать», рецепты для ws/canvas/video/SFC/стилей, layout-oracle, скорость прогона.
- Ядро: доменная логика → unit + property-based (fast-check / hypothesis: формулируешь инвариант, генератор перебирает злые входы — рецепт в testing-strategy.md); стыки (код↔БД, handler↔сервис) → integration, repo-слой — против реальной БД (Testcontainers), не моков и не in-memory; e2e — только критичные user-journeys, единицы. Over-testing (генераты, DTO, пиксели, сторонний код) — тоже баг: минус скорость сьюта и рефакторинга.
- **После правки** — only affected: `vitest --changed`, `jest --findRelatedTests`, `pytest --testmon`, `cargo test -p <crate>`, `go test ./<pkg>`.
- **Перед «готово»** — full suite модуля; линтеры + форматтеры зелёные. Правил `core/shared/utils` — ещё и reverse-dependencies (`pnpm why`, `cargo tree -i`).
- **Full > 2 мин** — зафиксируй стратегию прогона в проектном CLAUDE.md при первой встрече. **> 10 мин** — спроси пользователя, не решай сам.
- Unit-only под предлогом «медленно» не засчитается — сработает триггер A.

### Декларация edge-cases в финальном сообщении

После правки observable-кода перед «готово» выведи в финальном сообщении блок `<edge-cases>` с перечислением покрытых тестами кейсов. Формат машинопроверяемый:

```
<edge-cases>
empty:tests/auth.test.ts:test_empty_password;
race:tests/auth.test.ts:test_concurrent_login
</edge-cases>
```

- Запись — `name:test_file:test_name`; разделители `;` или перенос строки. `test_file` — путь от корня репо, должен существовать; `test_name` — подстрока имени `it/test/describe/def` в нём (case-insensitive). Хук валидирует механически — враньё в декларации блокирует Stop.
- Минимальный набор: empty, boundary, concurrency, external-failure, permission, malformed-input, deleted-resource; frontend — плюс browser/UX edge states. Кейс реально N/A → пиши явно `name:N/A:<причина>`, не выкидывай молча.

### Self-review + триаж замечаний — шаг 4

**Когда обязателен:** observable-правка с ≥20 добавленными нетривиальными строками (multiset-дельта `new_string − old_string` в Edit/MultiEdit — широкий контекстный якорь rename/extract не считается; Write — целиком) ИЛИ затронут security-sensitive путь (auth / payment / session / token / cookie / crypto / webhook / … — полный список токенов: [`references/stop-triggers.md`](references/stop-triggers.md), триггер J). Тривиальные правки пропускаются молча; для аудита пропуска: `<self-review>skipped:trivial</self-review>`.

**Как:** один проход — review-агентов перед Stop не перезапускай. Параллельно три сабагента в одном Tool message (`Task` или `Agent`, subagent_type="general-purpose" — хук засчитывает все):

- code-review (качество, паттерны, дублирование, непокрытые edge-cases, конвенции) — модель `sonnet`: структурный обход диффа не требует топ-модели; есть superpowers → промпт из `requesting-code-review` (шаблон `code-reviewer.md`).
- security-review по OWASP Top-10 (injection / auth-bypass / SSRF / редиректы / weak crypto / leaked secrets / deserialization / rate-limit / TOCTOU / path traversal) на конкретные изменённые файлы — без `model` override: false negative дороже стоимости.
- premortem-review («что сломается в проде»: top-5 гипотез, каждая = система + точное ограничение с числом + ломающий вход + симптом; generic не считается; не уверен в лимите → WebFetch официальных доков) — модель `sonnet`, не haiku: ценность — специфичность гипотез (цитаты доков, точные коды ошибок). Находки → `<review-triage>` с источником `edge:`.

**Триаж каждого замечания** (через `superpowers:receiving-code-review` если установлен, иначе той же дисциплиной): applied — применить; rejected/deferred — обосновать технически (file:line, конкретный риск, метрика, цитата), без performative-agreement и отмазок «minor / вне scope».

**Декларация** — два машинопроверяемых блока в финальном сообщении:

```
<self-review>
code:applied:src/auth.ts:42-58 — early-return на null user
security:rejected:CSRF на /logout — POST + SameSite=Strict cookie
edge:applied:чанкование sendMessage по лимиту 4096
</self-review>

<review-triage>
code:1:applied:src/auth.ts:42-58 — добавил early-return на null user
security:1:rejected:CSRF на /logout — endpoint POST + SameSite=Strict cookie
edge:1:applied:src/notify.ts:37 — чанкование текста по 4096 + тест на длинный error
</review-triage>
```

- `<self-review>`: секции `code`, `security` и `edge` обязательны (в полном режиме both; `edge` отключается `MAIN_SKILL_VERIFY_PREMORTEM=0`); статусы `applied` / `rejected` / `deferred` / `none-found`. Ревью ничего не нашло → `code:none-found` / `security:none-found` / `edge:none-found`, триаж не требуется.
- `<review-triage>`: запись `<source>:<id>:<status>:<reason>`, каждое замечание отдельной строкой. Slop-обоснование блокируется: `rejected`/`deferred` только со словами «minor / nitpick / несущественно / вне scope / косметика / not critical» без технического маркера (file:line, идентификатор, число, термин риска) — Stop-хук блокирует.

### Stop-триггеры verify-changes

Хук `verify-changes.js` блокирует «готово»-claim по триггерам A–N и поддерживает env-opt-outs. Полный перечень и opt-outs: [`references/stop-triggers.md`](references/stop-triggers.md).

---

# Большой план → circle-skill / worktree-skill

План в конце планирующего флоу вышел многодоменным или > одной сессии (≈ >40% контекста на проход) → **предложи** пофазное фоновое исполнение: инициатива твоя, решение юзера. Движки смотри в `~/.claude/settings.json → enabledPlugins` (key `<name>@<marketplace>` = `true`):

- **`worktree-skill` включён И git-репо с базовой веткой (`dev`) И фазы можно сделать независимыми по файлам/доменам** → предложи выбор, кратко назвав trade-off: **worktree** (независимые фазы параллельно в git-worktrees, batch-мерж в `dev` — быстрее) vs **circle** (по фазе на свежую сессию — минимум конфликтов, проще отладка).
- Иначе → предложи **circle**.

Согласился → авторь строго по [`references/circle-plan-authoring.md`](references/circle-plan-authoring.md) (запуск `/circle-skill:circle-skill <path>`) или [`references/worktree-plan-authoring.md`](references/worktree-plan-authoring.md) (декомпозиция под независимость, `## Контракты` для пересечений, запуск `/worktree-skill:worktree-skill <path>`). Общее: самодостаточные фазы (pre-authorized default+fallback; `needs-human` только для необратимого/прод-риска), ~30% контекста на фазу; **разведку кодовой базы делай раз — при планировании**: карта в преамбулу плана + файловый манифест в тело каждой фазы. Сам плагин не запускай — команды user-invoked.
