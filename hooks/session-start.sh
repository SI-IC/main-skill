#!/bin/sh
# SessionStart hook for main-skill.
# 1. Cheap remote SHA check (git ls-remote on marketplace clone).
# 2. If remote moved — run claude plugin update SYNCHRONOUSLY.
# 3. If the cache LATEST version changed during this run, echo a one-line
#    banner so the user (and Claude) get a visible "actually upgraded" signal
#    — Claude Code's /plugin UI is bound to the version loaded at process
#    start and won't reflect mid-session updates.
# 4. Emit a short instruction telling Claude to invoke the workflow-rules
#    skill. Skill content arrives via the Skill-tool channel, which is NOT
#    subject to the 10KB cap that applies to SessionStart hook stdout.
#
# Opt-out: MAIN_SKILL_AUTO_UPDATE=0 disables the update check.

MP_DIR="$HOME/.claude/plugins/marketplaces/main-skill"
STAMP="$HOME/.claude/plugins/.main-skill-update-stamp"
CACHE_BASE="$HOME/.claude/plugins/cache/main-skill/main-skill"

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

  OLD_VERSION=$(ls "$CACHE_BASE" 2>/dev/null | sort -V | tail -1)

  claude plugin marketplace update main-skill </dev/null >/dev/null 2>&1
  claude plugin update main-skill@main-skill </dev/null >/dev/null 2>&1

  touch "$STAMP"

  NEW_VERSION=$(ls "$CACHE_BASE" 2>/dev/null | sort -V | tail -1)
  if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "$OLD_VERSION" ]; then
    echo "main-skill updated to v${NEW_VERSION}"
    echo
  fi
}

emit_skill_invocation() {
  cat <<'EOF'
ОБЯЗАТЕЛЬНО — перед любым ответом, включая clarifying questions, вызови `Skill` tool со skill `main-skill:workflow-rules`. Это твои персональные workflow-правила (язык общения, триаж, edge-cases, verify, self-review). Содержимое приходит через skill-канал и не обрезается 10KB-капом хуков. Не «и так помню» — версия в плагине меняется, перечитай свежее. После загрузки следуй ему до конца сессии.
EOF
}

maybe_update
emit_skill_invocation
