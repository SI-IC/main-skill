# Verify-done — рецепты evidence и harness

Расширение правила «Reproduce-before-done» из SKILL.md: как добывать пруф для каждого класса правки и что делать, когда окружения для проверки нет. Читай перед прогоном evidence.

## Evidence по типу правки

- **Frontend** → дефолт — headless playwright (`npx playwright install chromium` + скрипт): открой route → HTTP 2xx документа+bundle, console clean, DOM содержит ожидаемый маркер; скриншот если визуально. Минимум — `curl localhost:PORT/route` → status + `grep`. MCP-браузеры — опциональный ускоритель, их недоступность не повод сдаться. Правка меняет user-флоу (роут-мап, дефолт-роут, страницы, cross-bundle склейка) → промотируй смоук в **закоммиченный** e2e-спек: разовый зелёный прогон покрывает «отгрузить раз», не регрессию.
- **API** → `curl` против реального endpoint → status + body.
- **CLI** → re-run, paste output.
- **MCP-плагин / slash-команда Claude Code** → `claude plugin marketplace update && claude -p "/namespace:command" --output-format stream-json` → проверь exit + контент ответа.
- **Cross-machine / multi-process** → `docker-compose up --abort-on-container-exit` (два инстанса + mediator / две стороны pipe) → ассерт по логам или output.

Контейнер / нет GUI — не причина пропустить: headless ставится `npx playwright install chromium`. Зелёные unit-тесты — не evidence. Фиксишь баг — добавь regression-test.

## Build-your-own-harness

Верификация требует окружения, которого нет (docker-compose, headless browser, fake external API, peers плагина) — строй harness как часть задачи, не повод сдаться. External API → заглушка (`msw` / `nock` / локальный http-server); slash-команды в unattended-CI → `claude -p --permission-mode bypassPermissions --output-format stream-json` (требует `ANTHROPIC_API_KEY`). Незнакомую технику верификации (замер, перехват сети, измерение лейаута) провалидируй **одним** дешёвым проб-прогоном и выясни ограничения окружения (service worker глушит `page.route`, кеш/пересборка бандла, throttling headless) **до** серии полно-стековых — на CPU-боксе каждый e2e ≈ минута. Harness коммить в репо (`scripts/e2e.sh`, `docker-compose.e2e.yml`, `tests/e2e/`) — следующая правка переиспользует.
