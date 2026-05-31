// Unit-tests для lib/session-disabled.js. Запуск: node --test hooks/lib/session-disabled.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isDisabled, sentinelPath } = require("./session-disabled");

function tmpHome() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mssd-"));
  fs.mkdirSync(path.join(d, ".claude", "plugins"), { recursive: true });
  return d;
}
function touchSentinel(home) {
  fs.writeFileSync(sentinelPath({ HOME: home }), "");
}

test("sentinelPath строит путь от HOME из env", () => {
  assert.equal(
    sentinelPath({ HOME: "/x/y" }),
    path.join("/x/y", ".claude", "plugins", ".main-skill-off"),
  );
});

test("нет сентинела и нет env → плагин ВКЛ (false)", () => {
  const home = tmpHome();
  assert.equal(isDisabled({ HOME: home }), false);
});

test("сентинел присутствует → выключен (true)", () => {
  const home = tmpHome();
  touchSentinel(home);
  assert.equal(isDisabled({ HOME: home }), true);
});

test("env MAIN_SKILL_OFF=1 → выключен даже без сентинела", () => {
  const home = tmpHome();
  assert.equal(isDisabled({ HOME: home, MAIN_SKILL_OFF: "1" }), true);
});

test("MAIN_SKILL_OFF c иным значением не выключает", () => {
  const home = tmpHome();
  assert.equal(isDisabled({ HOME: home, MAIN_SKILL_OFF: "0" }), false);
  assert.equal(isDisabled({ HOME: home, MAIN_SKILL_OFF: "true" }), false);
});

test("isDisabled() без аргумента читает process.env, не бросает", () => {
  // Так его зовут verify-changes.js / auto-format.js. В нейтральной среде
  // (сентинела под реальным HOME нет) → false, без исключения.
  assert.doesNotThrow(() => isDisabled());
  assert.equal(typeof isDisabled(), "boolean");
});

test("fail-soft: несуществующий HOME → false, не бросает", () => {
  // existsSync под отсутствующим путём возвращает false, а не кидает.
  assert.equal(isDisabled({ HOME: "/nonexistent/main-skill-xyz" }), false);
});
