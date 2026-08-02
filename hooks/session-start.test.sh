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
SKILL_PHRASE="Перед первым ответом"
CAPS_PRESSURE="ОБЯЗАТЕЛЬНО"

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
# Не менять, потому что пара проверок держит тон инструкции: императив есть,
# CAPS-нажима нет (стиль правил из CLAUDE.md → «Процесс правки»).
assert_contains "$OUT" "$SKILL_PHRASE" "инструкция начинается с императива «Перед первым ответом»"
assert_not_contains "$OUT" "$CAPS_PRESSURE" "инструкция без CAPS-нажима (ОБЯЗАТЕЛЬНО)"
# Контр-авторизация серверного AgentTool-гейта — ревью-сабагенты = standing-запрос.
assert_contains "$OUT" "unless the user requested it" "инструкция содержит контр-авторизацию AgentTool-гейта"

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

# 7. self-provision standing-request в ~/.claude/CLAUDE.md.
PROV_MARKER="main-skill:agenttool-standing-request"
H=$(mk_home '{"enabledPlugins":{}}')
OUT=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK")
if [ -f "$H/.claude/CLAUDE.md" ] && grep -q "$PROV_MARKER" "$H/.claude/CLAUDE.md"; then
  echo "ok - свежий HOME → CLAUDE.md создан со standing-request строкой"
else
  echo "not ok - свежий HOME → CLAUDE.md со standing-request строкой"
  FAIL=1
fi
assert_contains "$OUT" "standing-request строка добавлена" "факт записи виден баннером"
# повторный запуск → идемпотентно (маркер один раз, баннера нет).
OUT2=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK")
CNT=$(grep -c "$PROV_MARKER" "$H/.claude/CLAUDE.md")
if [ "$CNT" = "1" ]; then
  echo "ok - повторный запуск идемпотентен (маркер один раз)"
else
  echo "not ok - повторный запуск: маркеров $CNT (ожидал 1)"
  FAIL=1
fi
assert_not_contains "$OUT2" "standing-request строка добавлена" "повторный запуск → без баннера записи"
rm -rf "$H"

# 7b. существующий CLAUDE.md → append, контент сохранён; opt-out → нетронут.
H=$(mk_home '{"enabledPlugins":{}}')
printf '# Мой конфиг\n' >"$H/.claude/CLAUDE.md"
HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK" >/dev/null
if grep -q "Мой конфиг" "$H/.claude/CLAUDE.md" && grep -q "$PROV_MARKER" "$H/.claude/CLAUDE.md"; then
  echo "ok - существующий CLAUDE.md → append с сохранением контента"
else
  echo "not ok - существующий CLAUDE.md → append с сохранением контента"
  FAIL=1
fi
rm -rf "$H"
H=$(mk_home '{"enabledPlugins":{}}')
OUT=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 MAIN_SKILL_CLAUDEMD_PROVISION=0 sh "$HOOK")
if [ -f "$H/.claude/CLAUDE.md" ]; then
  echo "not ok - opt-out MAIN_SKILL_CLAUDEMD_PROVISION=0 → CLAUDE.md не должен создаваться"
  FAIL=1
else
  echo "ok - opt-out MAIN_SKILL_CLAUDEMD_PROVISION=0 → CLAUDE.md не создан"
fi
rm -rf "$H"

# 7c. MAIN_SKILL_OFF=1 → провижининг тоже молчит (early-exit до ensure_standing_request).
H=$(mk_home '{"enabledPlugins":{}}')
OUT=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 MAIN_SKILL_OFF=1 sh "$HOOK")
if [ -f "$H/.claude/CLAUDE.md" ]; then
  echo "not ok - MAIN_SKILL_OFF=1 → CLAUDE.md не должен создаваться"
  FAIL=1
else
  echo "ok - MAIN_SKILL_OFF=1 → провижининг пропущен"
fi
rm -rf "$H"

# 7d. недоступный на запись ~/.claude → fail-soft БЕЗ утечки stderr (порядок редиректов).
H=$(mk_home '{"enabledPlugins":{}}')
chmod 555 "$H/.claude"
ERR=$(HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK" 2>&1 >/dev/null)
chmod 755 "$H/.claude"
if printf '%s' "$ERR" | grep -qiE "permission denied|cannot create"; then
  echo "not ok - read-only .claude → stderr утёк: $ERR"
  FAIL=1
else
  echo "ok - read-only .claude → fail-soft без утечки stderr"
fi
rm -rf "$H"

# 7e. CLAUDE.md-симлинк (dotfiles-менеджер) → пропуск, target не тронут.
H=$(mk_home '{"enabledPlugins":{}}')
printf '# dotfiles source\n' >"$H/dotfiles-src.md"
ln -s "$H/dotfiles-src.md" "$H/.claude/CLAUDE.md"
HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK" >/dev/null
if grep -q "$PROV_MARKER" "$H/dotfiles-src.md"; then
  echo "not ok - симлинк CLAUDE.md → append не должен уходить в target"
  FAIL=1
else
  echo "ok - симлинк CLAUDE.md → провижининг пропущен, target не тронут"
fi
rm -rf "$H"

# 7f. идемпотентность по payload-якорю: маркер-коммент стёрт (claude-md-improver),
#     текст остался → второй блок не дописывается.
H=$(mk_home '{"enabledPlugins":{}}')
printf 'Standing request (main-skill): текст без маркера.\n' >"$H/.claude/CLAUDE.md"
HOME="$H" MAIN_SKILL_AUTO_UPDATE=0 sh "$HOOK" >/dev/null
if grep -q "$PROV_MARKER" "$H/.claude/CLAUDE.md"; then
  echo "not ok - payload-якорь без маркера → не должен дописывать второй блок"
  FAIL=1
else
  echo "ok - payload-якорь без маркера → второй блок не дописан"
fi
rm -rf "$H"

# 7g. пустой HOME → тихий пропуск без падения хука.
OUT=$(HOME="" MAIN_SKILL_AUTO_UPDATE=0 MAIN_SKILL_PLUGIN_CHECK=0 sh "$HOOK" 2>&1) || {
  echo "not ok - пустой HOME → хук не должен падать"
  FAIL=1
}
assert_not_contains "$OUT" "standing-request строка добавлена" "пустой HOME → без баннера записи"

if [ "$FAIL" -eq 0 ]; then
  echo "# all session-start.sh integration tests passed"
else
  echo "# FAILURES present"
fi
exit "$FAIL"
