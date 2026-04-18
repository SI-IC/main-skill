#!/bin/sh
# SessionStart hook for main-skill.
# 1. Cheap remote SHA check (git ls-remote on marketplace clone).
# 2. If remote moved — run claude plugin update SYNCHRONOUSLY.
# 3. cat SKILL.md + CLAUDE.md from the LATEST cached version (not from
#    ${CLAUDE_PLUGIN_ROOT}, which is bound to the version active at
#    session start and would yield stale content after an update).
#
# Opt-out: MAIN_SKILL_AUTO_UPDATE=0 disables the update check.

CACHE_BASE="$HOME/.claude/plugins/cache/main-skill/main-skill"
MP_DIR="$HOME/.claude/plugins/marketplaces/main-skill"
STAMP="$HOME/.claude/plugins/.main-skill-update-stamp"

maybe_update() {
  [ "${MAIN_SKILL_AUTO_UPDATE:-1}" = "0" ] && return

  # Concurrent-run guard: 60s window to prevent racing across windows.
  if [ -f "$STAMP" ] && [ -n "$(find "$STAMP" -mmin -1 2>/dev/null)" ]; then
    return
  fi

  mkdir -p "$(dirname "$STAMP")" 2>/dev/null

  # Cheap remote check: if marketplace clone HEAD == remote HEAD, nothing to do.
  if command -v git >/dev/null 2>&1 && [ -d "$MP_DIR/.git" ]; then
    REMOTE=$(git -C "$MP_DIR" ls-remote origin HEAD 2>/dev/null | awk '{print $1}')
    LOCAL=$(git -C "$MP_DIR" rev-parse HEAD 2>/dev/null)
    if [ -n "$REMOTE" ] && [ "$REMOTE" = "$LOCAL" ]; then
      touch "$STAMP"
      return
    fi
  fi

  command -v claude >/dev/null 2>&1 || return

  claude plugin marketplace update main-skill </dev/null >/dev/null 2>&1
  claude plugin update main-skill@main-skill </dev/null >/dev/null 2>&1

  touch "$STAMP"
}

emit_latest() {
  if [ -d "$CACHE_BASE" ]; then
    LATEST=$(ls "$CACHE_BASE" 2>/dev/null | sort -V | tail -1)
    if [ -n "$LATEST" ]; then
      cat "$CACHE_BASE/$LATEST/skills/workflow-rules/SKILL.md" "$CACHE_BASE/$LATEST/CLAUDE.md" 2>/dev/null
      return
    fi
  fi
  # Fallback: ${CLAUDE_PLUGIN_ROOT} (current session's version path)
  cat "${CLAUDE_PLUGIN_ROOT}/skills/workflow-rules/SKILL.md" "${CLAUDE_PLUGIN_ROOT}/CLAUDE.md" 2>/dev/null
}

maybe_update
emit_latest
