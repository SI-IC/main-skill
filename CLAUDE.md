# Additional rules

Auto-loaded alongside `skills/workflow-rules/SKILL.md` by the SessionStart hook. For workflow additions that don't fit the three-phase structure — one-off preferences, tool-specific rules, side notes.

**Editing this plugin:** when modifying any file in the `main-skill` plugin repo, ALWAYS bump `version` in `.claude-plugin/plugin.json` (patch increment by default) **before** committing. Without a bump, `claude plugin update` on consumer machines won't refresh the cached content.

---

## Не плодить дубли фоновых процессов

Перед запуском долгоживущего процесса (dev-server, watcher, туннель, `npm run dev` / `next dev` / `vite`, `tail -f`, ngrok) проверь, не запущен ли уже — свои bg-bash через `Monitor` / `BashOutput` по id, чужие через `pgrep -fa <pattern>` или `lsof -i :<port>`. Живой и отвечает → **переиспользуй**. Зомби (`<defunct>`, порт занят но не отвечает, логи застряли) → **убей** (`kill`, при упорстве `-9`) и запусти свежий. Один процесс на одну роль.

## Логировать неуверенные места (постоянно, с ротацией, без секретов)

Если не на 100% уверен в поведении кода (внешний API, async-цепочки, нетривиальное состояние, парсинг чужих форматов, редкие ветки) — ставь **постоянное structured-logging**, чтобы трейс уже лежал в файле к моменту, когда пользователь сообщит о баге.

- **Стандартный logger языка/фреймворка** (Python `logging`, Node `pino`/`winston`, Go `slog`, Rust `tracing`, JVM `logback`) с file appender + ротацией. Не самописный.
- **Ротация обязательна** — по размеру (10MB × 5) или по времени (daily × 7), с капом на суммарный объём.
- **Уровни по смыслу**: `debug` (детальный трейс), `info` (бизнес-события), `warn` (отклонения), `error` (сбой с контекстом). Прод-дефолт `info`; `debug` включается через `LOG_LEVEL`, не правкой кода.
- **Структурированный формат** (JSON / key=value), грепаемый: `logger.info("user.login", extra={"user_id": uid})`, не `print(f"user {uid} ...")`.
- **Секреты НИКОГДА в логах**. Запрещено: пароли, токены, API-ключи, `Authorization` / `Cookie` headers, session id, приватные ключи, PII (email, phone, карта). Перед логированием объекта — redactor по regex ключей (`*token*`, `*secret*`, `*password*`, `*api[_-]?key*`, `authorization`, `cookie`) → `[REDACTED]`. URL — маскируй `token=` / `key=` в query. Если структура непредсказуема — логируй имена полей и типы, не значения.
- **Путь к лог-файлу из env/конфига**, директория в `.gitignore` (`logs/`).
- **Логгер не должен падать** — fallback на stderr, приложение живёт.

Отладка начинается с `tail logs/app.log`, а не с добавления print-ов post-factum.
