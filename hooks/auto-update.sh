#!/bin/sh
# Background auto-update for main-skill.
# Refreshes marketplace metadata and plugin cache asynchronously on session start.
# Current session reads old cache; the next session loads the fresh version.
# Dedup: skip if last successful run was < 1h ago. Opt-out: MAIN_SKILL_AUTO_UPDATE=0.

if [ -z "${MAIN_SKILL_AUTO_UPDATE_BG:-}" ]; then
  MAIN_SKILL_AUTO_UPDATE_BG=1 nohup sh "$0" </dev/null >/dev/null 2>&1 &
  exit 0
fi

[ "${MAIN_SKILL_AUTO_UPDATE:-1}" = "0" ] && exit 0
command -v claude >/dev/null 2>&1 || exit 0

STAMP="$HOME/.claude/plugins/.main-skill-update-stamp"
mkdir -p "$(dirname "$STAMP")" 2>/dev/null

if [ -f "$STAMP" ] && [ -n "$(find "$STAMP" -mmin -60 2>/dev/null)" ]; then
  exit 0
fi

claude plugin marketplace update main-skill </dev/null >/dev/null 2>&1 || exit 0
claude plugin update main-skill@main-skill </dev/null >/dev/null 2>&1 || exit 0

touch "$STAMP"
