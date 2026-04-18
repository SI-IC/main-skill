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
