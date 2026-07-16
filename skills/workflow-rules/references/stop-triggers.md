# Stop-триггеры `verify-changes.js`

Хук блокирует Stop, когда финальное сообщение содержит claim о завершении работы, но не выполнены минимальные требования к верификации/доке/тестам. Триггер-буква в сообщении хука соответствует одной из проверок ниже.

## Полный список триггеров

- **A** — success-слово (`готово/done/fixed/работает/пофиксил/исправил/it works/ready`) без verify-команды (`curl`, `npx playwright`, `claude -p`, `docker-compose up`, реального run теста).
- **B** — дисклеймер «не проверил» без следов разведки в transcript (`lsof`, `which`, `npx playwright install`, неуспешный `curl`).
- **C** — делегирование shell-команды пользователю (типа «запусти у себя `npm test`») при наличии своего Bash-доступа.
- **D** — observable код-файл правлен без парного `*.test.*` / `*.spec.*` / `__tests__/*` теста. Для `.vue` / `.svelte` / `.astro` парный тест ищется на `.ts` / `.tsx` / `.js` / `.jsx`: `App.vue` ↔ `App.spec.ts`, `Card.svelte` ↔ `Card.svelte.test.ts`. Централизованные спеки, именованные по фиче (`tests/unit/auth_cookies.spec.ts`), засчитываются fallback-ом: спек в `tests/ | test/ | spec/ | specs/ | __tests__/` от package-root, импортирующий правленый файл (import/require/from/vi.mock, включая `#алиасы` и относительные пути), снимает D — каталожный ignore-глоб не нужен. Спеки читаются по релевантности файлу, бюджет — `MAIN_SKILL_IMPORT_SCAN_MAX_FILES` (дефолт 200); обрыв без матча помечается в reason ⚠-блоком с grep-рецептом («теста нет» не доказано). Файлы вне repoRoot и удалённые к моменту Stop — скип.
- **E** — **критичный** endpoint без endpoint-level теста (`tests/functional/`, `tests/integration/`, `tests/e2e/`, `cypress/e2e/`, `playwright/`). Критичность: имя пути (auth / деньги / доступ: `auth|login|session|password|payment|checkout|admin|…`) ИЛИ мутирующий handler в теле файла (`POST/PUT/PATCH/DELETE`, `destroy/store/update`). Дефолт — integration (api-client/supertest); e2e — только для сквозных критичных user-journeys. Рядовой read-only controller/route E не трогает — его покрывает D.
- **F** — отсутствует или невалиден блок `<edge-cases>`.
- **G** — `npm run lint` / `ruff` / `golangci-lint` / `cargo clippy` exit ≠ 0.
- **H** — public surface (CLI, exports, plugin manifest, SKILL.md, frontmatter) изменён без обновления `*.md` / `docs/*` в той же сессии.
- **J** — отсутствует или невалиден блок `<self-review>` (нет review-агентов в transcript / фейковый `skipped:trivial` / нет нужной секции). В полном режиме both при включённом премортем-слое обязательна и секция `edge:` (premortem-линза — третий сабагент); её декларация без реального premortem-агента в transcript ловится как fake-decl.
- **K** — `<review-triage>` отсутствует / невалиден / содержит slop-only `rejected` / `deferred` без технического обоснования. Источники записей: `code` / `security` / `edge`; записи неактивной секции (в т.ч. `edge` при выключенном премортем-слое или суженном режиме) — wrong-source.
- **L** — правка manifest-файла (`package.json`, `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Dockerfile`, `.nvmrc`, `.tool-versions`, workflows) с новой пиновой версией без version-lookup в сессии (`npm view` / `pip index versions` / `cargo search` / endoflife.date / `gh api releases` / registry-URL). Loose-версии (`latest`, `*`, `>=0`) lookup не требуют.
- **M** — frontend-файл правлен, но после последней фронт-правки нет render-класса прогона: headless browser / `curl`|`wget` по localhost / активный браузер-MCP. Unit-раннеры (vitest/jest в jsdom) рендером НЕ считаются — нет layout-движка. Не считаются фронт-правкой: тест/док-файлы, type-only `.tsx/.jsx`, token-only stylesheet (только custom-props/`$vars`/`@import`), `@generated`. Презентационные SFC и `.html` рендер-проверки ТРЕБУЮТ.
- **N** — нетривиальная правка (тот же порог, что J: ≥20 **добавленных** нетривиальных observable-строк ИЛИ security-sensitive путь; добавленные = multiset-дельта канонизированных строк (trim + схлопнутый whitespace + NFC) `new_string − old_string` в Edit/MultiEdit, Write считается целиком — перестановки, re-indent, реформат и чистые удаления ВНУТРИ одной правки добавлением не считаются (перенос блока двумя правками — считается), широкий контекстный якорь rename/extract счётчик не надувает; `replace_all` считается один раз) без валидного блока `<premortem>` где-либо в сессии. Блок валиден: минимум 3 гипотезы, по одной на строку, формат `вход/состояние → наблюдаемый отказ → решение` (стрелки `→` или `->`), каждая с точным фактом — числом (лимит/код ошибки/таймаут; нумерация строки не считается), идентификатором кода (camelCase / snake_case / `литерал`) или термином механизма отказа (идемпотентность / ретрай / таймаут / кодировка / гонка / … — кириллическая конкретика принимается); generic («сеть может упасть») не проходит, частично-мусорный блок не засчитывается. Позиция «до первой правки» механически не форсится (блокировка не отматывает время) — её несёт правило workflow-rules §2; зуб ловит отсутствие/невалидность ритуала и требует ретро-премортем. `MAIN_SKILL_VERIFY_REVIEW=0` триггер N НЕ отключает — только `MAIN_SKILL_VERIFY_PREMORTEM=0`. Разобранный пример: [`premortem.md`](premortem.md).

## Env-opt-outs (per-shell, разовые)

- `MAIN_SKILL_VERIFY_CHANGES=0` — выключить все триггеры.
- `MAIN_SKILL_VERIFY_LINT=0` — выключить только G.
- `MAIN_SKILL_VERIFY_DEPS=0` — выключить только L (проекты с фиксированным стеком).
- `MAIN_SKILL_VERIFY_RENDER=0` — выключить только M.
- `MAIN_SKILL_VERIFY_REVIEW=0` — выключить J/K.
- `MAIN_SKILL_VERIFY_REVIEW=code` — требовать только code-review секцию.
- `MAIN_SKILL_VERIFY_REVIEW=security` — требовать только security-review секцию.
- `MAIN_SKILL_VERIFY_PREMORTEM=0` — выключить N и требование edge-секции в J.
- `MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/*.gen.ts:src/generated/schema.ts"` — POSIX-globs (`:`-разделитель) для путей, которые не требуют парного теста (для D/E). **Только узкий глоб по имени/расширению конкретных файлов, не каталог целиком** — широкий `dir/**` прячет и тестируемую логику рядом и отклоняется PreToolUse-хуком `ignore-glob-guard`. Централизованные тесты, импортирующие исходники, D засчитывает сам (fallback выше); спеки вовсе без импортов (чистый HTTP-flow) → не глоб, а `MAIN_SKILL_VERIFY_CHANGES=0`.
- `MAIN_SKILL_IGNORE_GLOB_CHECK=0` — отключить `ignore-glob-guard` (разрешить запись широких ignore-глобов).

Опт-ауты — только когда триггер ловит действительно нерелевантный кейс. Не используй для обхода легитимных требований.
