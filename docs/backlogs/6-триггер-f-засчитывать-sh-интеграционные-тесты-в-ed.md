---
id: 6
title: Триггер F: засчитывать sh-интеграционные тесты в edge-cases декларации
priority: medium
status: done
created: 2026-07-27T13:27:58Z
updated: 2026-07-27T13:47:55Z
---
validateEdgeCases (hooks/lib/checks.js:1399) матчит test_name только по JS-паттерну it/test/describe/context/specify(...) и function-паттерну def/func/fn — sh-интеграционные тесты (hooks/session-start.test.sh: лейблы echo "ok - ..." / echo "not ok - ...") не распознаются, и честно покрытые кейсы приходится декларировать как N/A (дог-фудинг-кейс v1.12.0, сессия 2026-07-27). Сделать: третий fallback-паттерн для sh-тестов — матч подстроки test_name в лейблах ok/not ok или в комментариях-заголовках блоков (# 7d. ...). Синхронизировать: checks.test.js, reasonF в verify-changes.js (текст «в нём — it/test/describe/def»), stop-triggers.md, секция скилла про формат edge-cases.
