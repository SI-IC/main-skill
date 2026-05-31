#!/bin/sh
# Integration-тесты для session-start.sh. Запуск: sh hooks/session-start.test.sh
# Гоняем хук с контролируемым env: temp HOME (своя settings.json) + MAIN_SKILL_AUTO_UPDATE=0
# (чтобы maybe_update вышел ДО сетевых вызовов) и ассертим на stdout.

set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOOK="$HERE/session-start.sh"
FAIL=0

BANNER_MARKER="рекомендованные плагины не установлены"
SKILL_MARKER="main-skill:workflow-rules"

# temp HOME с заданным enabledPlugins JSON; печатает путь в stdout.
mk_home() {
  d=$(mktemp -d)
  mkdir -p "$d/.claude"
  printf '%s\n' "$1" >"$d/.claude/settings.json"
  printf '%s' "$d"
}

assert_contains() { # haystack needle label
  if printf '%s' "$1" | grep -qF -- "$2"; then
    echo "ok - $3"
  else
    echo "not ok - $3 (ожидал подстроку: $2)"
    FAIL=1
  fi
}
assert_not_contains() { # haystack needle label
  if printf '%s' "$1" | grep -qF -- "$2"; then
    echo "not ok - $3 (не должно быть: $2)"
    FAIL=1
  else
    echo "ok - $3"
  fi
}

# 1. empty: пустой enabledPlugins → баннер + skill-инструкция.
H=$(mk_home '{"enabledPlugins":{}}')
OUT=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK")
rm -rf "$H"
assert_contains "$OUT" "$BANNER_MARKER" "empty enabledPlugins → баннер"
assert_contains "$OUT" "$SKILL_MARKER" "empty enabledPlugins → skill-инструкция"

# 2. всё включено → нет баннера, инструкция есть.
H=$(mk_home '{"enabledPlugins":{"superpowers@x":true,"ui-ux-pro-max@y":true}}')
OUT=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK")
rm -rf "$H"
assert_not_contains "$OUT" "$BANNER_MARKER" "всё включено → нет баннера"
assert_contains "$OUT" "$SKILL_MARKER" "всё включено → инструкция есть"

# 3. opt-out MAIN_SKILL_PLUGIN_CHECK=0 → нет баннера даже без плагинов, инструкция остаётся.
H=$(mk_home '{"enabledPlugins":{}}')
OUT=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 MAIN_SKILL_PLUGIN_CHECK=0 sh "$HOOK")
rm -rf "$H"
assert_not_contains "$OUT" "$BANNER_MARKER" "opt-out → нет баннера"
assert_contains "$OUT" "$SKILL_MARKER" "opt-out → инструкция всё равно есть"

# 4. порядок: баннер ПЕРЕД skill-инструкцией.
H=$(mk_home '{"enabledPlugins":{}}')
OUT=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK")
rm -rf "$H"
bline=$(printf '%s\n' "$OUT" | grep -n -- "$BANNER_MARKER" | head -1 | cut -d: -f1)
sline=$(printf '%s\n' "$OUT" | grep -n -- "$SKILL_MARKER" | head -1 | cut -d: -f1)
if [ -n "$bline" ] && [ -n "$sline" ] && [ "$bline" -lt "$sline" ]; then
  echo "ok - баннер идёт перед skill-инструкцией"
else
  echo "not ok - порядок баннер/инструкция (banner=$bline skill=$sline)"
  FAIL=1
fi

# 5. сброс per-session disable: сентинел .main-skill-off удаляется на SessionStart.
H=$(mk_home '{"enabledPlugins":{}}')
mkdir -p "$H/.claude/plugins"
touch "$H/.claude/plugins/.main-skill-off"
OUT=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK")
if [ -e "$H/.claude/plugins/.main-skill-off" ]; then
  echo "not ok - SessionStart должен удалять сентинел .main-skill-off"
  FAIL=1
else
  echo "ok - SessionStart удаляет сентинел .main-skill-off (re-enable на новой сессии)"
fi
assert_contains "$OUT" "$SKILL_MARKER" "после сброса сентинела skill-инструкция есть"
rm -rf "$H"

# 6. launch-time MAIN_SKILL_OFF=1 → полная тишина (ни баннера, ни skill-инструкции),
#    но сброс сентинела всё равно отрабатывает (rm идёт ДО early-exit).
H=$(mk_home '{"enabledPlugins":{}}')
mkdir -p "$H/.claude/plugins"
touch "$H/.claude/plugins/.main-skill-off"
OUT=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 MAIN_SKILL_OFF=1 sh "$HOOK")
assert_not_contains "$OUT" "$SKILL_MARKER" "MAIN_SKILL_OFF=1 → нет skill-инструкции"
assert_not_contains "$OUT" "$BANNER_MARKER" "MAIN_SKILL_OFF=1 → нет баннера"
if [ -e "$H/.claude/plugins/.main-skill-off" ]; then
  echo "not ok - MAIN_SKILL_OFF=1 → сентинел всё равно должен удаляться"
  FAIL=1
else
  echo "ok - MAIN_SKILL_OFF=1 → сентинел удалён (rm до early-exit)"
fi
rm -rf "$H"

if [ "$FAIL" -eq 0 ]; then
  echo "# all session-start.sh integration tests passed"
else
  echo "# FAILURES present"
fi
exit "$FAIL"
