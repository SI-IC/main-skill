---
id: 4
title: Content-skip для декларативных ORM-моделей (Lucid/TypeORM: только колонки/relations)
priority: medium
status: open
created: 2026-07-10T06:55:05Z
updated: 2026-07-10T06:55:05Z
---
## Проблема (кейс ERP_NEW)
106 Lucid-моделей в apps/api/app/models/ — чистые декларации (@column/@hasMany + declare-поля, ноль методов; пример: ai_conversation.ts). Тест на такое бессмысленен (стоп-лист testing-strategy.md: «DTO/декларации не тестировать»), но D требует парный → Claude исключил models/** каталогом, спрятав и модели С логикой.

## Что сделать
isDeclarativeModelFile(content) в hooks/lib/checks.js — по образцу isTypeOnlyTsFile (checks.js, ~282):
- Гейт: класс extends BaseModel (Lucid) / @Entity() (TypeORM) — по контенту, не по пути (модели не всегда в models/).
- Skip ТОЛЬКО если после stripBlockComments (state-machine из v1.9.0 — переиспользовать, НЕ новый regex) тело класса содержит лишь decorator-поля (@column*/@hasMany/@belongsTo/@hasOne/@manyToMany + declare ...) и static-константы.
- ЛЮБОЙ сигнал логики → НЕ skip: тело метода (\w+\s*\([^)]*\)\s*{), стрелка =>, get/set, @computed, hooks (@beforeSave|@afterSave|@beforeCreate|...), serializeExtras. Fail toward требования — как isPresentationalSFC (консервативность задокументирована в CLAUDE.md).
- Все regex bounded — ReDoS-грабли репо (CLAUDE.md «Триггер M», adversarial-тесты в checks.test.js как образец).
- Подключить в shouldSkipForTestPairing content-skip веткой (рядом с isTypeOnlyTsFile, checks.js ~406).

## Синхронизация
checks.test.js (skip: голая Lucid-модель; НЕ skip: модель с @computed/методом/hook/стрелкой), reasonD, CLAUDE.md Skip-rules (+строка «декларативные ORM-модели»), bump version. После деплоя — убрать apps/api/app/models/** из глобов ERP_NEW.
