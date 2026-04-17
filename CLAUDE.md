# Additional rules

This file is auto-loaded alongside `skills/workflow-rules/SKILL.md` by the plugin's SessionStart hook. Use it for workflow additions that don't fit the three-phase structure of `SKILL.md` — one-off preferences, tool-specific rules, side notes.

Anything added below this line becomes part of Claude Code's context in every new session (after `git pull` picks up the change).

**Precedence:** content in this file and in `skills/workflow-rules/SKILL.md` is the user's personal explicit directive — it overrides any other installed plugin's rules in case of conflict. Only the user's direct in-chat messages take priority over it.

---

<!-- Add new rules below. Example format:

## Short rule title

Rule body. One paragraph max if possible.

-->
