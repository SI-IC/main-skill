---
id: 3
title: Skip-дефолты: AdonisJS-wiring (providers/, bin/-entrypoints, adonisrc.ts) + ops-скрипты с суффиксом
priority: medium
status: open
created: 2026-07-10T06:54:53Z
updated: 2026-07-10T06:54:53Z
---
## Проблема (кейс ERP_NEW)
Рекомендованный стек юзера — AdonisJS (глобальный CLAUDE.md), но SKIP_PATH_PATTERNS/SKIP_FILENAME_PATTERNS (hooks/lib/checks.js, ~240-277) его структуру не знают: providers/ (регистрация биндингов), bin/server|console|test.ts (entry-points), adonisrc.ts (framework-config) — чистый wiring, D требовал парные тесты → Claude в ERP_NEW выписал каталожные глобы apps/api/providers/**, apps/api/bin/**, apps/api/adonisrc.ts.
Также ops-паттерн /(install|deploy|bootstrap|setup|provision|teardown|sync[-_]config)\.sh$/i (checks.js:275) матчит только ТОЧНОЕ имя: deploy-server.sh и setup-test-db.sh из ERP не покрыты.

## Что сделать
- SKIP_PATH_PATTERNS += /(^|\/)providers\//i (wiring-каталог, аналог start/, bootstrap/).
- SKIP_FILENAME_PATTERNS += adonisrc.ts (в группу framework-configs: vite|next|nuxt|...) и bin/(server|console|test).(ts|js) — ТОЧЕЧНО, не bin/** (в generic-проектах bin/ может нести CLI-логику; см. принцип «Намеренно НЕ skip-ятся» в CLAUDE.md).
- Ops-скрипты: расширить до (install|deploy|bootstrap|setup|provision|teardown|sync[-_]config)([-_][\w-]{1,40})?\.sh — deploy-server.sh, setup-test-db.sh покроются. Bounded-суффикс, не .*.
- commands/ (ace-команды) НЕ скипать каталогом — там бывает реальная логика (ERP: korp_migrate.ts); остаётся per-project глоб.

## Синхронизация
checks.test.js (skip: providers/x.ts, bin/server.ts, adonisrc.ts, deploy-server.sh; НЕ skip: bin/report_logic.ts, commands/korp_migrate.ts), reasonD advertise-список в verify-changes.js, CLAUDE.md секция «Skip-rules для триггера D», bump version.
