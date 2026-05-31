---
description: Снова включить main-skill в текущей сессии (удаляет сентинел /main-skill:off)
allowed-tools: Bash(rm:*)
---

Удаляю сентинел:

!`rm -f ~/.claude/plugins/.main-skill-off && echo "main-skill: снова включён"`

main-skill снова активен в текущей сессии. Применяй `main-skill:workflow-rules` как обычно; хуки `verify-changes` / `claudemd-guard` / `auto-format` снова работают.
