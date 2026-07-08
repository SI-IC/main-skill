// Unit-тесты для ignore-glob-guard.js. Запуск: node hooks/ignore-glob-guard.test.js
//
// Хук — PreToolUse-гард: deny на запись ШИРОКОГО MAIN_SKILL_VERIFY_IGNORE_GLOBS
// (каталог-глоб) в env-carrier-файл (.env / .claude/settings.json / *.sh) или в
// Bash-команду. Узкие глобы, не-carrier-файлы и прочие инструменты — молчим.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const g = require("./ignore-glob-guard");

const VAR = "MAIN_SKILL_VERIFY_IGNORE_GLOBS";

// ─── isEnvCarrierFile ─────────────────────────────────────────────────────────

test("isEnvCarrierFile: .env / settings.json / .claude / *.sh — carrier", () => {
  assert.ok(g.isEnvCarrierFile("/repo/.env"));
  assert.ok(g.isEnvCarrierFile("/repo/.env.local"));
  assert.ok(g.isEnvCarrierFile("/repo/.env.production"));
  assert.ok(g.isEnvCarrierFile("/repo/.claude/settings.json"));
  assert.ok(g.isEnvCarrierFile("/repo/.claude/settings.local.json"));
  assert.ok(g.isEnvCarrierFile("/repo/.mcp.json"));
  assert.ok(g.isEnvCarrierFile("/home/u/.bashrc"));
  assert.ok(g.isEnvCarrierFile("/home/u/.zshrc"));
  assert.ok(g.isEnvCarrierFile("/home/u/.profile"));
  assert.ok(g.isEnvCarrierFile("/repo/scripts/setup.sh"));
  assert.ok(g.isEnvCarrierFile("/repo/.envrc"));
  assert.ok(g.isEnvCarrierFile("/home/u/.zshenv")); // zsh env-файлы
  assert.ok(g.isEnvCarrierFile("/home/u/.zprofile"));
});

test("isEnvCarrierFile: доки и исходники — НЕ carrier (нет self-match)", () => {
  assert.ok(!g.isEnvCarrierFile("/repo/README.md"));
  assert.ok(!g.isEnvCarrierFile("/repo/skills/x/references/stop-triggers.md"));
  assert.ok(!g.isEnvCarrierFile("/repo/hooks/verify-changes.js"));
  assert.ok(!g.isEnvCarrierFile("/repo/src/app.ts"));
  // .md под .claude/ (напр. commands/off.md с примером VAR) — НЕ carrier.
  assert.ok(!g.isEnvCarrierFile("/repo/.claude/commands/off.md"));
  assert.ok(!g.isEnvCarrierFile("/repo/.claude/agents/reviewer.md"));
  assert.ok(!g.isEnvCarrierFile(null));
});

// ─── extractIgnoreGlobs ───────────────────────────────────────────────────────

test("extractIgnoreGlobs: .env bare (без кавычек), сплит по ':'", () => {
  assert.deepEqual(g.extractIgnoreGlobs(`${VAR}=a/**:b/**`), ["a/**", "b/**"]);
});

test("extractIgnoreGlobs: shell export с кавычками", () => {
  assert.deepEqual(g.extractIgnoreGlobs(`export ${VAR}="**/scripts/**"`), [
    "**/scripts/**",
  ]);
});

test("extractIgnoreGlobs: JSON-форма settings.json", () => {
  const json = `{ "env": { "${VAR}": "src/services/**:**/*.gen.ts" } }`;
  assert.deepEqual(g.extractIgnoreGlobs(json), [
    "src/services/**",
    "**/*.gen.ts",
  ]);
});

test("extractIgnoreGlobs: одинарные кавычки", () => {
  assert.deepEqual(g.extractIgnoreGlobs(`${VAR}='dir/**'`), ["dir/**"]);
});

test("extractIgnoreGlobs: bare-значение обрывается на комментарии '#'", () => {
  assert.deepEqual(g.extractIgnoreGlobs(`${VAR}=a/** # comment`), ["a/**"]);
});

test("extractIgnoreGlobs: несколько присваиваний (MultiEdit)", () => {
  const content = `${VAR}="a/**"\nfoo\n${VAR}="b/**"`;
  assert.deepEqual(g.extractIgnoreGlobs(content), ["a/**", "b/**"]);
});

test("extractIgnoreGlobs: закомментированная строка (# перед VAR) → пропуск", () => {
  assert.deepEqual(g.extractIgnoreGlobs(`# ${VAR}=dir/** (пример)`), []);
  assert.deepEqual(g.extractIgnoreGlobs(`  # ${VAR}="a/**"`), []);
  assert.deepEqual(g.extractIgnoreGlobs(`foo # ${VAR}=a/**`), []);
});

test("extractIgnoreGlobs: var-префикс (не VAR) → не матчим (word-boundary)", () => {
  assert.deepEqual(g.extractIgnoreGlobs(`LEGACY_${VAR}=dir/**`), []);
  assert.deepEqual(g.extractIgnoreGlobs(`MY${VAR}=dir/**`), []);
});

test("extractIgnoreGlobs: нет переменной → []", () => {
  assert.deepEqual(g.extractIgnoreGlobs("just some text"), []);
  assert.deepEqual(g.extractIgnoreGlobs(""), []);
  assert.deepEqual(g.extractIgnoreGlobs(null), []);
});

// ─── addedBroadGlobs (диф против old/on-disk) ──────────────────────────────────

test("addedBroadGlobs Edit: широкий уже в old_string → НЕ ново → []", () => {
  const r = g.addedBroadGlobs(
    "Edit",
    { old_string: `${VAR}="dir/**"\nX=1`, new_string: `${VAR}="dir/**"\nX=2` },
    () => "",
  );
  assert.deepEqual(r, []);
});

test("addedBroadGlobs Edit: широкий ново введён → флажим", () => {
  const r = g.addedBroadGlobs(
    "Edit",
    { old_string: "X=1", new_string: `${VAR}="dir/**"` },
    () => "",
  );
  assert.deepEqual(r, ["dir/**"]);
});

test("addedBroadGlobs Write: широкий уже на диске → НЕ ново → []", () => {
  const r = g.addedBroadGlobs(
    "Write",
    { file_path: "/repo/.env", content: `${VAR}="dir/**"\nA=1` },
    () => `${VAR}="dir/**"`,
  );
  assert.deepEqual(r, []);
});

// ─── evaluate ─────────────────────────────────────────────────────────────────

const editPayload = (file_path, new_string) => ({
  tool_name: "Edit",
  tool_input: { file_path, old_string: "", new_string },
});
const noDisable = { env: {} };

test("evaluate: широкий глоб в .env → deny", () => {
  const out = g.evaluate(
    editPayload("/repo/.env", `${VAR}="**/scripts/**"`),
    noDisable,
  );
  assert.ok(out, "ожидался deny");
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /scripts/);
  assert.match(out.reason, /VERIFY_CHANGES=0/);
});

test("evaluate: узкий глоб → null (молчим)", () => {
  assert.equal(
    g.evaluate(
      editPayload("/repo/.env", `${VAR}="**/*.gen.ts:src/schema.ts"`),
      noDisable,
    ),
    null,
  );
});

test("evaluate: широкий глоб, но НЕ env-carrier (README) → null (нет self-match)", () => {
  assert.equal(
    g.evaluate(
      editPayload("/repo/README.md", `${VAR}="**/scripts/**"`),
      noDisable,
    ),
    null,
  );
});

test("evaluate: смешанный список (узкий + широкий) → deny по широкому", () => {
  const out = g.evaluate(
    editPayload("/repo/.env", `${VAR}="**/*.gen.ts:src/services/**"`),
    noDisable,
  );
  assert.ok(out);
  // Широкий перечислен в списке-буллете; узкий из входа в буллеты не попал.
  assert.match(out.reason, /• src\/services\/\*\*/);
  assert.doesNotMatch(out.reason, /• \*\*\/\*\.gen\.ts/);
});

test("evaluate: Bash export с широким глобом → deny (file_path не нужен)", () => {
  const out = g.evaluate(
    { tool_name: "Bash", tool_input: { command: `export ${VAR}="dir/**"` } },
    noDisable,
  );
  assert.ok(out);
  assert.equal(out.decision, "deny");
});

test("evaluate: Write settings.json с широким глобом → deny", () => {
  const out = g.evaluate(
    {
      tool_name: "Write",
      tool_input: {
        file_path: "/repo/.claude/settings.json",
        content: `{"env":{"${VAR}":"app/**"}}`,
      },
    },
    noDisable,
  );
  assert.ok(out);
});

test("evaluate: прочий инструмент (Read) → null", () => {
  assert.equal(
    g.evaluate(
      { tool_name: "Read", tool_input: { file_path: "/repo/.env" } },
      noDisable,
    ),
    null,
  );
});

test("evaluate: opt-out MAIN_SKILL_IGNORE_GLOB_CHECK=0 → null", () => {
  assert.equal(
    g.evaluate(editPayload("/repo/.env", `${VAR}="dir/**"`), {
      env: { MAIN_SKILL_IGNORE_GLOB_CHECK: "0" },
    }),
    null,
  );
});

test("evaluate: session-disabled (env + сентинел) → null, хотя иначе был бы deny", () => {
  const p = editPayload("/repo/.env", `${VAR}="dir/**"`);
  assert.ok(g.evaluate(p, noDisable)); // sanity
  assert.equal(g.evaluate(p, { env: { MAIN_SKILL_OFF: "1" } }), null);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "igg-home-"));
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "plugins", ".main-skill-off"), "");
  assert.equal(g.evaluate(p, { env: { HOME: home } }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test("evaluate: malformed input (нет tool_input) → null, не падаем", () => {
  assert.equal(g.evaluate({ tool_name: "Edit" }, noDisable), null);
  assert.equal(g.evaluate({}, noDisable), null);
  assert.equal(g.evaluate(null, noDisable), null);
});

// ─── sanitizeGlob (ANSI-инъекция) ─────────────────────────────────────────────

test("sanitizeGlob: control-chars стрипаются", () => {
  assert.equal(g.sanitizeGlob("dir/\x1b[2K**"), "dir/[2K**");
  assert.equal(g.sanitizeGlob("a\x00b\x7fc"), "abc");
});

test("evaluate: reason не содержит raw ESC из глоба", () => {
  const out = g.evaluate(
    editPayload("/repo/.env", `${VAR}="\x1b[31mevil/**"`),
    noDisable,
  );
  assert.ok(out);
  assert.doesNotMatch(out.reason, /\x1b/);
});

// ─── main: контракт stdout ───────────────────────────────────────────────────

test("main: широкий глоб → PreToolUse permissionDecision=deny в stdout", () => {
  let captured = "";
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    captured += s;
    return true;
  };
  try {
    g.main(editPayload("/repo/.env", `${VAR}="**/scripts/**"`));
  } finally {
    process.stdout.write = orig;
  }
  const o = JSON.parse(captured);
  assert.equal(o.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(o.hookSpecificOutput.permissionDecision, "deny");
  assert.match(o.hookSpecificOutput.permissionDecisionReason, /scripts/);
});

test("main: узкий глоб → ничего не пишет", () => {
  let captured = "";
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    captured += s;
    return true;
  };
  try {
    g.main(editPayload("/repo/.env", `${VAR}="**/*.gen.ts"`));
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(captured, "");
});
