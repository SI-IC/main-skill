# Stop-триггеры `verify-changes.js`

Хук блокирует Stop, когда финальное сообщение содержит claim о завершении работы, но не выполнены минимальные требования к верификации/доке/тестам. Триггер-буква в сообщении хука соответствует одной из проверок ниже.

## Полный список триггеров

- **A** — success-слово (`готово/done/fixed/работает/пофиксил/исправил/it works/ready`) без verify-команды (`curl`, `npx playwright`, `claude -p`, `docker-compose up`, реального run теста).
- **B** — дисклеймер «не проверил» без следов разведки в transcript (`lsof`, `which`, `npx playwright install`, неуспешный `curl`).
- **C** — делегирование shell-команды пользователю (типа «запусти у себя `npm test`») при наличии своего Bash-доступа.
- **D** — observable код-файл правлен без парного `*.test.*` / `*.spec.*` / `__tests__/*` теста. Для `.vue` / `.svelte` / `.astro` парный тест ищется на `.ts` / `.tsx` / `.js` / `.jsx`: `App.vue` ↔ `App.spec.ts`, `Card.svelte` ↔ `Card.svelte.test.ts`.
- **E** — **критичный** endpoint без endpoint-level теста (`tests/functional/`, `tests/integration/`, `tests/e2e/`, `cypress/e2e/`, `playwright/`). Критичность: имя пути (auth / деньги / доступ: `auth|login|session|password|payment|checkout|admin|…`) ИЛИ мутирующий handler в теле файла (`POST/PUT/PATCH/DELETE`, `destroy/store/update`). Дефолт — integration (api-client/supertest); e2e — только для сквозных критичных user-journeys. Рядовой read-only controller/route E не трогает — его покрывает D.
- **F** — отсутствует или невалиден блок `<edge-cases>`.
- **G** — `npm run lint` / `ruff` / `golangci-lint` / `cargo clippy` exit ≠ 0.
- **H** — public surface (CLI, exports, plugin manifest, SKILL.md, frontmatter) изменён без обновления `*.md` / `docs/*` в той же сессии.
- **J** — отсутствует или невалиден блок `<self-review>` (нет review-агентов в transcript / фейковый `skipped:trivial` / нет нужной секции).
- **K** — `<review-triage>` отсутствует / невалиден / содержит slop-only `rejected` / `deferred` без технического обоснования.
- **L** — правка manifest-файла (`package.json`, `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Dockerfile`, `.nvmrc`, `.tool-versions`, workflows) с новой пиновой версией без version-lookup в сессии (`npm view` / `pip index versions` / `cargo search` / endoflife.date / `gh api releases` / registry-URL). Loose-версии (`latest`, `*`, `>=0`) lookup не требуют.
- **M** — frontend-файл правлен, но после последней фронт-правки нет render-класса прогона: headless browser / `curl`|`wget` по localhost / активный браузер-MCP. Unit-раннеры (vitest/jest в jsdom) рендером НЕ считаются — нет layout-движка. Не считаются фронт-правкой: тест/док-файлы, type-only `.tsx/.jsx`, token-only stylesheet (только custom-props/`$vars`/`@import`), `@generated`. Презентационные SFC и `.html` рендер-проверки ТРЕБУЮТ.

## Env-opt-outs (per-shell, разовые)

- `MAIN_SKILL_VERIFY_CHANGES=0` — выключить все триггеры.
- `MAIN_SKILL_VERIFY_LINT=0` — выключить только G.
- `MAIN_SKILL_VERIFY_DEPS=0` — выключить только L (проекты с фиксированным стеком).
- `MAIN_SKILL_VERIFY_RENDER=0` — выключить только M.
- `MAIN_SKILL_VERIFY_REVIEW=0` — выключить J/K.
- `MAIN_SKILL_VERIFY_REVIEW=code` — требовать только code-review секцию.
- `MAIN_SKILL_VERIFY_REVIEW=security` — требовать только security-review секцию.
- `MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/*.gen.ts:src/generated/schema.ts"` — POSIX-globs (`:`-разделитель) для путей, которые не требуют парного теста (для D/E). **Только узкий глоб по имени/расширению конкретных файлов, не каталог целиком** — широкий `dir/**` прячет и тестируемую логику рядом и отклоняется PreToolUse-хуком `ignore-glob-guard`. Централизованные тесты (весь `src/` без локальных) → не глоб, а `MAIN_SKILL_VERIFY_CHANGES=0`.
- `MAIN_SKILL_IGNORE_GLOB_CHECK=0` — отключить `ignore-glob-guard` (разрешить запись широких ignore-глобов).

Опт-ауты — только когда триггер ловит действительно нерелевантный кейс. Не используй для обхода легитимных требований.
