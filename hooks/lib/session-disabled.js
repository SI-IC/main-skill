// Рантайм-проверка «main-skill выключен для текущей сессии».
// Используется всеми хуками (Stop verify-changes, PreToolUse claudemd-guard,
// PostToolUse auto-format): при наличии сентинел-файла или env MAIN_SKILL_OFF=1
// хук делает no-op (exit 0 / return null), как будто плагин не установлен.
//
// Зачем файл, а не только env: env фиксируется при старте процесса Claude Code,
// а сентинел читается в рантайме на каждый вызов хука — поэтому слэш-команда
// `/main-skill:off` может выключить плагин ПОСРЕДИ сессии (после /clear) без
// перезапуска. Сентинел удаляется автоматически в session-start.sh на следующем
// SessionStart (startup|resume|clear) → плагин снова включён по умолчанию.
//
// env MAIN_SKILL_OFF=1 — launch-time вариант (`MAIN_SKILL_OFF=1 claude`),
// эквивалент сентинела на всю сессию.

const fs = require("fs");
const os = require("os");
const path = require("path");

// Стабильный, верс-независимый путь на user-level (не в кеше плагина).
function sentinelPath(env) {
  const home = (env && env.HOME) || os.homedir();
  return path.join(home, ".claude", "plugins", ".main-skill-off");
}

// Fail-soft: при любой аномалии → false (плагин ВКЛ). Дефолт безопасный:
// при сомнении enforcement работает, а не молча отключается. existsSync сам
// не бросает (внутри глотает ошибки → false); catch страхует os.homedir() /
// path.join при экзотическом env (напр. HOME=undefined и недоступный homedir).
function isDisabled(env = process.env) {
  try {
    if (env && env.MAIN_SKILL_OFF === "1") return true;
    return fs.existsSync(sentinelPath(env));
  } catch {
    return false;
  }
}

module.exports = { isDisabled, sentinelPath };
