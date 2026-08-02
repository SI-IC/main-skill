const fs = require("fs");
const os = require("os");
const path = require("path");

// Не менять, потому что сентинел должен лежать вне кеша плагина: путь в
// версионированном каталоге терялся бы при обновлении, и `/main-skill:off`
// переставал бы выключать плагин.
function sentinelPath(env) {
  const home = (env && env.HOME) || os.homedir();
  return path.join(home, ".claude", "plugins", ".main-skill-off");
}

// Не менять, потому что catch обязан возвращать false: аномалия чтения (HOME
// пуст, homedir недоступен) не должна молча отключать enforcement во всех хуках.
function isDisabled(env = process.env) {
  try {
    if (env && env.MAIN_SKILL_OFF === "1") return true;
    return fs.existsSync(sentinelPath(env));
  } catch {
    return false;
  }
}

module.exports = { isDisabled, sentinelPath };
