const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pc = require("./plugin-check");

const REC = [
  { name: "superpowers", why: "триаж" },
  { name: "ui-ux-pro-max", why: "UI" },
];

test("missingRecommended: оба отключены (enabledPlugins = {}) → оба missing", () => {
  const m = pc.missingRecommended({ enabledPlugins: {} }, REC);
  assert.deepStrictEqual(
    m.map((p) => p.name),
    ["superpowers", "ui-ux-pro-max"],
  );
});

test("missingRecommended: оба включены (любой marketplace-суффикс) → ничего", () => {
  const settings = {
    enabledPlugins: {
      "superpowers@claude-plugins-official": true,
      "ui-ux-pro-max@ui-ux-pro-max-skill": true,
    },
  };
  assert.deepStrictEqual(pc.missingRecommended(settings, REC), []);
});

test("missingRecommended: superpowers включён, ui-ux нет → только ui-ux", () => {
  const settings = {
    enabledPlugins: { "superpowers@superpowers-marketplace": true },
  };
  const m = pc.missingRecommended(settings, REC);
  assert.deepStrictEqual(
    m.map((p) => p.name),
    ["ui-ux-pro-max"],
  );
});

test("missingRecommended: value=false считается как missing (установлен, но выключен)", () => {
  const settings = {
    enabledPlugins: {
      "superpowers@claude-plugins-official": false,
      "ui-ux-pro-max@ui-ux-pro-max-skill": true,
    },
  };
  const m = pc.missingRecommended(settings, REC);
  assert.deepStrictEqual(
    m.map((p) => p.name),
    ["superpowers"],
  );
});

// Не менять, потому что пустой результат тут — требование: баннер не должен
// врать про «не установлен» на нечитаемом settings.json.
test("missingRecommended: нет ключа enabledPlugins → [] (no false positive)", () => {
  assert.deepStrictEqual(pc.missingRecommended({}, REC), []);
  assert.deepStrictEqual(pc.missingRecommended(null, REC), []);
  assert.deepStrictEqual(
    pc.missingRecommended({ enabledPlugins: "garbage" }, REC),
    [],
  );
});

test("missingRecommended: пустой список рекомендованных → []", () => {
  assert.deepStrictEqual(pc.missingRecommended({ enabledPlugins: {} }, []), []);
});

test("enabledPluginNames: берёт base-имя до '@' только для true", () => {
  const s = {
    enabledPlugins: {
      "a@m1": true,
      "b@m2": false,
      "c@m3": true,
    },
  };
  const names = pc.enabledPluginNames(s);
  assert.ok(names.has("a"));
  assert.ok(names.has("c"));
  assert.ok(!names.has("b"));
});

test("enabledPluginNames: ключ без '@' → base = всё имя", () => {
  const names = pc.enabledPluginNames({
    enabledPlugins: { superpowers: true },
  });
  assert.ok(names.has("superpowers"));
});

test("formatBanner: пусто → '' (нет вывода когда всё на месте)", () => {
  assert.strictEqual(pc.formatBanner([]), "");
  assert.strictEqual(pc.formatBanner(null), "");
});

test("formatBanner: перечисляет имена + opt-out + /plugin", () => {
  const b = pc.formatBanner([{ name: "superpowers", why: "триаж" }]);
  assert.match(b, /superpowers/);
  assert.match(b, /триаж/);
  assert.match(b, /MAIN_SKILL_PLUGIN_CHECK=0/);
  assert.match(b, /\/plugin/);
});

test("formatBanner: два плагина → оба bullet'а присутствуют", () => {
  const b = pc.formatBanner([
    { name: "superpowers", why: "триаж" },
    { name: "ui-ux-pro-max", why: "UI" },
  ]);
  assert.strictEqual((b.match(/^ {2}• /gm) || []).length, 2);
  assert.match(b, /superpowers/);
  assert.match(b, /ui-ux-pro-max/);
});

test("readSettings: битый JSON / отсутствующий файл → null (fail-soft)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-"));
  assert.strictEqual(pc.readSettings(dir), null);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "{not json");
  assert.strictEqual(pc.readSettings(dir), null);
});

test("readSettings: путь — директория, не файл → null (isFile-guard от зависания)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-"));
  fs.mkdirSync(path.join(dir, ".claude", "settings.json"), { recursive: true });
  assert.strictEqual(pc.readSettings(dir), null);
});

test("readSettings: валидный файл → объект с enabledPlugins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { "superpowers@x": true } }),
  );
  const s = pc.readSettings(dir);
  assert.strictEqual(s.enabledPlugins["superpowers@x"], true);
});

test("RECOMMENDED: дефолтный набор = superpowers + ui-ux-pro-max", () => {
  assert.deepStrictEqual(pc.RECOMMENDED.map((p) => p.name).sort(), [
    "superpowers",
    "ui-ux-pro-max",
  ]);
});
