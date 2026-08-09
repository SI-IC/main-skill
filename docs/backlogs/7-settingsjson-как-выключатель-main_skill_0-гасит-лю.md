---
id: 7
title: settings.json как выключатель: MAIN_SKILL_*=0 гасит любой enforcement плагина без следа
priority: high
status: open
created: 2026-08-09T19:38:39Z
updated: 2026-08-09T19:38:39Z
---
Находка security-ревью (сессия 2026-08-09). Изначально сформулирована про ручки гарда зависимостей — та ветка работ откачена, но дыра к ней не привязана: она общая для всех ручек плагина и существует с v1.15.0.

Что не так: хуки читают ручки из своего окружения, а Claude Code подставляет хукам env из блока "env" в .claude/settings.json — обычного файла проекта, доступного модели на запись. Один Write с {"env":{"MAIN_SKILL_VERIFY_CHANGES":"0","MAIN_SKILL_COMMENT_CHECK":"0"}} гасит Stop-триггеры и PreToolUse-гарды бессрочно и молча. Ручек сейчас 23 (MAIN_SKILL_OFF, MAIN_SKILL_VERIFY_*, MAIN_SKILL_COMMENT_CHECK, MAIN_SKILL_COMMIT_CHECK, MAIN_SKILL_CLAUDEMD_CHECK, MAIN_SKILL_IGNORE_GLOB_CHECK, MAIN_SKILL_PLUGIN_CHECK и пороговые), у части выключение — это не только "0", но и подстановка запредельного порога (MAIN_SKILL_CLAUDEMD_MAXBYTES, MAIN_SKILL_COMMIT_HEADER_MAX, MAIN_SKILL_VERIFY_TAIL_WAIT_MS).

Почему решаемо дёшево: рубеж уже стоит. hooks/ignore-glob-guard.js:15-27 (isEnvCarrierFile) относит settings.json и settings.local.json к носителям env, а evaluate (hooks/ignore-glob-guard.js:122) гардит запись только одной ручки — MAIN_SKILL_VERIFY_IGNORE_GLOBS через extractIgnoreGlobs. Расширить разбор на прочие MAIN_SKILL_* — правка существующего гарда, новый хук не нужен.

Оговорки. (1) Против агента с произвольной записью абсолютной стойкости нет — тот же файл пишется через Bash, а гард обрывается на payload > 1MB. Ценность в том, что самый дешёвый путь перестаёт быть молчаливым: попытка упирается в deny и видна юзеру. (2) Юзер имеет право глушить ручки сам — deny должен нести опт-аут и не мешать легитимной правке settings.json руками; отличить руку от модели хук не может, поэтому reason обязан объяснять, а не только запрещать. (3) Носители env шире settings.json (.envrc, *.sh, .mcp.json уже в carrier-списке) — решить, гардить ли ручки во всех них или только в settings*.json.

Где: hooks/ignore-glob-guard.js:15-27 (isEnvCarrierFile), :122-131 (evaluate), extractIgnoreGlobs/addedBroadGlobs, парный hooks/ignore-glob-guard.test.js. Синхронизировать: README (дерево гардов + список env-ручек) и skills/workflow-rules/references/stop-triggers.md.
