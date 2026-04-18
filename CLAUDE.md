# Additional rules

This file is auto-loaded alongside `skills/workflow-rules/SKILL.md` by the plugin's SessionStart hook. Use it for workflow additions that don't fit the three-phase structure of `SKILL.md` — one-off preferences, tool-specific rules, side notes.

Anything added below this line becomes part of Claude Code's context in every new session (after `git pull` picks up the change).

**Precedence:** content in this file and in `skills/workflow-rules/SKILL.md` is the user's personal explicit directive — it overrides any other installed plugin's rules in case of conflict. Only the user's direct in-chat messages take priority over it.

**Editing this plugin:** when modifying any file in the `main-skill` plugin repo (`SKILL.md`, `CLAUDE.md`, `hooks.json`, etc.), ALWAYS bump `version` in `.claude-plugin/plugin.json` (patch increment by default, e.g. `1.0.1` → `1.0.2`) **before** committing. Without a version bump, `claude plugin update` on consumer machines won't refresh the cached plugin content — users will silently run on stale rules.

---

<!-- Add new rules below. Example format:

## Short rule title

Rule body. One paragraph max if possible.

-->

## Не плодить дубли фоновых процессов

Перед запуском долгоживущего процесса (dev-server, watcher, туннель, `npm run dev` / `next dev` / `vite`, `tail -f`, ngrok, фоновый скрипт) проверь, нет ли уже такого же — для своих background bash-тасков через `Monitor` / `BashOutput` по сохранённому id, для чужих через `ps -ef | grep`, `pgrep -fa <pattern>`, `lsof -i :<port>` для серверов. Если дубликат живой и отвечает (порт держит и отдаёт ответ, логи свежие) — **переиспользуй, новый не запускай**. Если зомби (`ps` показывает `<defunct>`, или порт занят но коннект падает / висит, или логи застряли, или процесс есть но на сигналы не реагирует) — **убей** (`kill`, при упорстве `kill -9`; для своего bg-bash — штатный stop) и запускай свежий. Цель: один процесс на одну роль, никаких "их там уже пять на 3000 порту".

## Логировать неуверенные места (постоянно, с ротацией, без секретов)

Если ты не на 100% уверен в поведении функции / модуля / компонента — интеграция с внешним API, асинхронные цепочки, нетривиальное состояние, парсинг чужих форматов, код третьих сторон, редкие ветки исполнения — не надейся на "должно работать". Ставь **постоянное structured-logging**, чтобы когда пользователь сообщит о баге в этом месте, трейс уже лежал в файле, а не "дайте добавлю логи и воспроизведём".

Требования:

- **Стандартный logger языка/фреймворка, не самописный**: Python `logging` (+ `logging.handlers.RotatingFileHandler` / `TimedRotatingFileHandler`), Node — `pino` или `winston` (+ `winston-daily-rotate-file`), Go — `log/slog` + `gopkg.in/natefinch/lumberjack.v2`, Rust — `tracing` + `tracing-appender`, JVM — `logback` с `RollingFileAppender`. Проверь, что нужная либа реально в зависимостях проекта — если нет, добавь.
- **Уровни по смыслу**: `debug` — детальный трейс (аргументы, промежуточные значения), `info` — ключевые события бизнес-флоу, `warn` — отклонения без падения, `error` — сбой с контекстом. Дефолтный уровень в проде — `info`; `debug` включается переменной окружения (`LOG_LEVEL=debug`), а не правкой кода.
- **Ротация обязательна**: по размеру (напр. 10MB × 5 файлов) либо по времени (daily × 7 дней). Всегда есть верхний кап на суммарный размер/количество — иначе диск заполнится и прод ляжет.
- **Структурированный формат** (JSON или key=value), чтобы было грепаемо и парсабельно: `logger.info("user.login", extra={"user_id": uid, "ip": ip})`, а не `print(f"user {uid} logged in from {ip}")`.
- **Секреты НИКОГДА не попадают в логи**. Запрещено логировать: пароли, токены, API-ключи, `Authorization` / `Cookie` / `Set-Cookie` заголовки, session id, приватные ключи, PII (email, phone, номер карты, паспорт), полные тела запросов/ответов к auth-эндпоинтам. Перед логированием dict/объекта — пропусти через redactor, заменяющий чувствительные поля на `[REDACTED]` (по allowlist полей или по regex для ключей `*token*`, `*secret*`, `*password*`, `*api[_-]?key*`, `authorization`, `cookie`). Если структура чужого объекта непредсказуема — логируй имена полей и типы, не значения. Для URL — маскируй query-параметры `token=`, `key=`, `password=`.
- **Путь к лог-файлу — из env/конфига, не хардкод**. Директория — gitignored (`logs/`, `var/log/`, или OS-специфичная). Убедись, что `logs/` в `.gitignore`.
- **Сам логгер не должен падать**: если файл недоступен, ротация сломалась, диск полный — fallback на stderr, приложение продолжает жить.

Цель — чтобы у неуверенных мест всегда был постоянный трейс с ротацией и без утечек секретов, и отладка начиналась с `tail logs/app.log`, а не с добавления print-ов post-factum.
