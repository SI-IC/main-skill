---
description: Отключить main-skill (workflow-rules + хуки) в текущей сессии; авто-сброс на следующем /clear или рестарте
allowed-tools: Bash(mkdir:*), Bash(touch:*)
---

Создаю сентинел, глушащий хуки main-skill в этой сессии:

!`mkdir -p ~/.claude/plugins && touch ~/.claude/plugins/.main-skill-off && echo "main-skill: выключен для этой сессии"`

main-skill отключён для текущей сессии. До конца сессии (или до `/main-skill:on`):

- НЕ применяй правила `main-skill:workflow-rules` — русский язык по умолчанию, триаж-скиллы, декларации `<edge-cases>` / `<self-review>` / `<review-triage>`, reproduce-before-done больше не обязательны. Работай как дефолтный Claude Code.
- Хуки (Stop `verify-changes`, PreToolUse `claudemd-guard`, PostToolUse `auto-format`) читают сентинел в рантайме и сами делают no-op — `<edge-cases>`-блоки и self-review для завершения хода больше не нужны.

Сентинел удаляется автоматически на следующем `/clear` или перезапуске Claude Code → плагин снова включится. Вернуть прямо сейчас — `/main-skill:on`.
