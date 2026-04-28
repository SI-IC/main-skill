# Stop-триггеры `verify-changes.js`

Хук блокирует Stop, когда финальное сообщение содержит claim о завершении работы, но не выполнены минимальные требования к верификации/доке/тестам. Триггер-буква в сообщении хука соответствует одной из проверок ниже.

## Полный список триггеров

- **A** — success-слово (`готово/done/fixed/работает/пофиксил/исправил/it works/ready`) без verify-команды (`curl`, `npx playwright`, `claude -p`, `docker-compose up`, реального run теста).
- **B** — дисклеймер «не проверил» без следов разведки в transcript (`lsof`, `which`, `npx playwright install`, неуспешный `curl`).
- **C** — делегирование shell-команды пользователю (типа «запусти у себя `npm test`») при наличии своего Bash-доступа.
- **D** — observable код-файл правлен без парного `*.test.*` / `*.spec.*` / `__tests__/*` теста. Для `.vue` / `.svelte` / `.astro` парный тест ищется на `.ts` / `.tsx` / `.js` / `.jsx`: `App.vue` ↔ `App.spec.ts`, `Card.svelte` ↔ `Card.svelte.test.ts`.
- **E** — controller / route / api-handler без e2e-парного теста (`tests/functional/`, `tests/e2e/`, `cypress/e2e/`, `playwright/`).
- **F** — отсутствует или невалиден блок `<edge-cases>`.
- **G** — `npm run lint` / `ruff` / `golangci-lint` / `cargo clippy` exit ≠ 0.
- **H** — public surface (CLI, exports, plugin manifest, SKILL.md, frontmatter) изменён без обновления `*.md` / `docs/*` в той же сессии.
- **J** — отсутствует или невалиден блок `<self-review>` (нет review-агентов в transcript / фейковый `skipped:trivial` / нет нужной секции).
- **K** — `<review-triage>` отсутствует / невалиден / содержит slop-only `rejected` / `deferred` без технического обоснования.

## Env-opt-outs (per-shell, разовые)

- `MAIN_SKILL_VERIFY_CHANGES=0` — выключить все триггеры.
- `MAIN_SKILL_VERIFY_LINT=0` — выключить только G.
- `MAIN_SKILL_VERIFY_REVIEW=0` — выключить J/K.
- `MAIN_SKILL_VERIFY_REVIEW=code` — требовать только code-review секцию.
- `MAIN_SKILL_VERIFY_REVIEW=security` — требовать только security-review секцию.
- `MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/legacy/**:**/scripts/**"` — POSIX-globs (`:`-разделитель) для путей, которые не требуют парного теста (для D/E).

Опт-ауты — только когда триггер ловит действительно нерелевантный кейс. Не используй для обхода легитимных требований.
