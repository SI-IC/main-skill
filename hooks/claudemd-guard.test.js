// Unit-тесты для claudemd-guard.js. Запуск: node hooks/claudemd-guard.test.js
//
// Хук — PreToolUse-гард на CLAUDE.md: на крупное дописывание в существующий файл
// возвращает permissionDecision:deny с дистиллятом правил claude-md-management.
// Создание-с-нуля и мелкие правки пропускаются молча.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const g = require("./claudemd-guard");

// ─── countLines ──────────────────────────────────────────────────────────────

test("countLines: пустая строка = 0", () => {
  assert.equal(g.countLines(""), 0);
  assert.equal(g.countLines(null), 0);
  assert.equal(g.countLines(undefined), 0);
});

test("countLines: считает строки по \\n", () => {
  assert.equal(g.countLines("a"), 1);
  assert.equal(g.countLines("a\nb\nc"), 3);
  assert.equal(g.countLines("a\nb\n"), 3); // trailing newline → последняя пустая строка считается
});

// ─── netAddedLines: Write ────────────────────────────────────────────────────

test("netAddedLines Write: создание-с-нуля (файла нет) → isCreation", () => {
  const r = g.netAddedLines(
    "Write",
    { file_path: "/x/CLAUDE.md", content: "a\nb\nc" },
    () => null,
  );
  assert.equal(r.isCreation, true);
  assert.equal(r.netAdded, 3);
});

test("netAddedLines Write: существующий пустой файл → тоже creation", () => {
  const r = g.netAddedLines(
    "Write",
    { file_path: "/x/CLAUDE.md", content: "a\nb" },
    () => "   \n  ",
  );
  assert.equal(r.isCreation, true);
});

test("netAddedLines Write: дописывание (rewrite больше) → net положительный", () => {
  const existing = Array.from({ length: 100 }, (_, i) => "l" + i).join("\n");
  const content = Array.from({ length: 130 }, (_, i) => "l" + i).join("\n");
  const r = g.netAddedLines(
    "Write",
    { file_path: "/x/CLAUDE.md", content },
    () => existing,
  );
  assert.equal(r.isCreation, false);
  assert.equal(r.netAdded, 30);
});

test("netAddedLines Write: тримминг (стало меньше) → net отрицательный", () => {
  const existing = Array.from({ length: 100 }, (_, i) => "l" + i).join("\n");
  const content = Array.from({ length: 80 }, (_, i) => "l" + i).join("\n");
  const r = g.netAddedLines(
    "Write",
    { file_path: "/x/CLAUDE.md", content },
    () => existing,
  );
  assert.equal(r.netAdded, -20);
});

test("netAddedLines Write: content не строка → null", () => {
  assert.equal(
    g.netAddedLines("Write", { file_path: "/x/CLAUDE.md" }, () => null),
    null,
  );
});

// ─── netAddedLines: Edit ─────────────────────────────────────────────────────

test("netAddedLines Edit: net = строки(new) - строки(old), не creation", () => {
  const r = g.netAddedLines(
    "Edit",
    {
      file_path: "/x/CLAUDE.md",
      old_string: "одна строка",
      new_string: Array.from({ length: 25 }, () => "x").join("\n"),
    },
    () => "файл",
  );
  assert.equal(r.isCreation, false);
  assert.equal(r.netAdded, 24);
});

test("netAddedLines Edit: вставка (old пустой) считает весь new", () => {
  const r = g.netAddedLines(
    "Edit",
    { file_path: "/x/CLAUDE.md", old_string: "", new_string: "a\nb\nc" },
    () => "f",
  );
  assert.equal(r.netAdded, 3);
});

test("netAddedLines Edit: new_string не строка → null", () => {
  assert.equal(
    g.netAddedLines(
      "Edit",
      { file_path: "/x/CLAUDE.md", old_string: "a" },
      () => "f",
    ),
    null,
  );
});

// ─── netAddedLines: MultiEdit ────────────────────────────────────────────────

test("netAddedLines MultiEdit: суммирует net по всем edits", () => {
  const r = g.netAddedLines(
    "MultiEdit",
    {
      file_path: "/x/CLAUDE.md",
      edits: [
        { old_string: "a", new_string: "a\nb\nc" }, // +2
        { old_string: "x", new_string: "x\ny\nz\nw" }, // +3
      ],
    },
    () => "f",
  );
  assert.equal(r.netAdded, 5);
  assert.equal(r.isCreation, false);
});

test("netAddedLines MultiEdit: edits не массив → null", () => {
  assert.equal(
    g.netAddedLines(
      "MultiEdit",
      { file_path: "/x/CLAUDE.md", edits: "nope" },
      () => "f",
    ),
    null,
  );
});

test("netAddedLines MultiEdit: пустой массив → net 0, не creation", () => {
  const r = g.netAddedLines(
    "MultiEdit",
    { file_path: "/x/CLAUDE.md", edits: [] },
    () => "f",
  );
  assert.equal(r.netAdded, 0);
  assert.equal(r.isCreation, false);
});

// ─── decide ──────────────────────────────────────────────────────────────────

test("decide: creation никогда не гардим", () => {
  assert.equal(g.decide({ netAdded: 999, isCreation: true }, 20).guard, false);
});

test("decide: ниже порога → не гардим", () => {
  assert.equal(g.decide({ netAdded: 19, isCreation: false }, 20).guard, false);
});

test("decide: на пороге и выше → гардим (boundary)", () => {
  assert.equal(g.decide({ netAdded: 20, isCreation: false }, 20).guard, true);
  assert.equal(g.decide({ netAdded: 21, isCreation: false }, 20).guard, true);
});

test("decide: null-метрики (malformed) → не гардим", () => {
  assert.equal(g.decide(null, 20).guard, false);
});

// ─── resolveThreshold ────────────────────────────────────────────────────────

test("resolveThreshold: дефолт 20", () => {
  assert.equal(g.resolveThreshold({}), 20);
});

test("resolveThreshold: валидное env переопределяет", () => {
  assert.equal(g.resolveThreshold({ MAIN_SKILL_CLAUDEMD_MAXADD: "15" }), 15);
});

test("resolveThreshold: мусор/ноль/отрицательное → дефолт", () => {
  assert.equal(g.resolveThreshold({ MAIN_SKILL_CLAUDEMD_MAXADD: "abc" }), 20);
  assert.equal(g.resolveThreshold({ MAIN_SKILL_CLAUDEMD_MAXADD: "0" }), 20);
  assert.equal(g.resolveThreshold({ MAIN_SKILL_CLAUDEMD_MAXADD: "-5" }), 20);
});

// ─── isClaudeMd ──────────────────────────────────────────────────────────────

test("isClaudeMd: матч по basename, в т.ч. вложенный", () => {
  assert.equal(g.isClaudeMd("/repo/CLAUDE.md"), true);
  assert.equal(g.isClaudeMd("/repo/packages/foo/CLAUDE.md"), true);
});

test("isClaudeMd: не матчит прочее и регистр", () => {
  assert.equal(g.isClaudeMd("/repo/README.md"), false);
  assert.equal(g.isClaudeMd("/repo/CLAUDE.local.md"), false);
  assert.equal(g.isClaudeMd("/repo/claude.md"), false);
  assert.equal(g.isClaudeMd(null), false);
});

// ─── evaluate (интеграция pure-ядра) ─────────────────────────────────────────

const denyDeps = (overrides = {}) => ({
  env: {},
  readFile: () => Array.from({ length: 100 }, (_, i) => "l" + i).join("\n"),
  improverAvailable: () => false,
  ...overrides,
});

test("evaluate: opt-out env → null (молчим)", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: "a",
      new_string: Array.from({ length: 30 }, () => "x").join("\n"),
    },
  };
  assert.equal(
    g.evaluate(p, denyDeps({ env: { MAIN_SKILL_CLAUDEMD_CHECK: "0" } })),
    null,
  );
});

test("evaluate: не CLAUDE.md → null", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/README.md",
      old_string: "a",
      new_string: Array.from({ length: 30 }, () => "x").join("\n"),
    },
  };
  assert.equal(g.evaluate(p, denyDeps()), null);
});

test("evaluate: не Edit/Write/MultiEdit → null", () => {
  const p = {
    tool_name: "NotebookEdit",
    tool_input: { file_path: "/x/CLAUDE.md" },
  };
  assert.equal(g.evaluate(p, denyDeps()), null);
});

test("evaluate: создание-с-нуля даже большое → null", () => {
  const p = {
    tool_name: "Write",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      content: Array.from({ length: 60 }, () => "x").join("\n"),
    },
  };
  assert.equal(g.evaluate(p, denyDeps({ readFile: () => null })), null);
});

test("evaluate: мелкое дописывание (< порога) → null", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: "a",
      new_string: Array.from({ length: 10 }, () => "x").join("\n"),
    },
  };
  assert.equal(g.evaluate(p, denyDeps()), null);
});

test("evaluate: крупное дописывание → deny с reason", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: "a",
      new_string: Array.from({ length: 30 }, () => "x").join("\n"),
    },
  };
  const out = g.evaluate(p, denyDeps());
  assert.ok(out, "ожидался deny-результат");
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /claude-md/i);
  assert.match(out.reason, /CLAUDE\.md/);
});

test("evaluate: reason упоминает improver когда плагин включён", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: "a",
      new_string: Array.from({ length: 30 }, () => "x").join("\n"),
    },
  };
  const withImprover = g.evaluate(
    p,
    denyDeps({ improverAvailable: () => true }),
  );
  assert.match(withImprover.reason, /claude-md-improver/);
  const without = g.evaluate(p, denyDeps({ improverAvailable: () => false }));
  assert.doesNotMatch(without.reason, /claude-md-improver/);
});

// ─── buildReason ─────────────────────────────────────────────────────────────

test("buildReason: содержит число прироста, порог и анти-паттерны", () => {
  const r = g.buildReason(30, 20, false);
  assert.match(r, /30/);
  assert.match(r, /20/);
  assert.match(r, /generic|очевидн|разов|многослов/i);
});

test("evaluate: improverAvailable бросает → deny всё равно выдаётся, не падаем", () => {
  const big = Array.from({ length: 30 }, () => "x").join("\n");
  const p = {
    tool_name: "Edit",
    tool_input: { file_path: "/x/CLAUDE.md", old_string: "a", new_string: big },
  };
  const out = g.evaluate(
    p,
    denyDeps({
      improverAvailable: () => {
        throw new Error("boom");
      },
    }),
  );
  assert.ok(out);
  assert.equal(out.decision, "deny");
});

// ─── main: контракт stdout ───────────────────────────────────────────────────

test("main: на крупной правке пишет PreToolUse с ключом permissionDecision=deny", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msgrd-"));
  const fp = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(
    fp,
    Array.from({ length: 50 }, (_, i) => "l" + i).join("\n"),
  );
  const big = Array.from({ length: 30 }, () => "x").join("\n");
  let captured = "";
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    captured += s;
    return true;
  };
  try {
    g.main({
      tool_name: "Edit",
      tool_input: { file_path: fp, old_string: "l0", new_string: big },
    });
  } finally {
    process.stdout.write = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const o = JSON.parse(captured);
  // hooks.json зависит от точного ключа permissionDecision (НЕ decision).
  assert.equal(o.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(o.hookSpecificOutput.permissionDecision, "deny");
  assert.match(o.hookSpecificOutput.permissionDecisionReason, /CLAUDE\.md/);
});

test("main: мелкая правка → ничего не пишет в stdout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msgrd-"));
  const fp = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(fp, "l0\nl1\nl2\n");
  let captured = "";
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    captured += s;
    return true;
  };
  try {
    g.main({
      tool_name: "Edit",
      tool_input: { file_path: fp, old_string: "l0", new_string: "a\nb" },
    });
  } finally {
    process.stdout.write = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(captured, "");
});

// ─── session-disabled (/main-skill:off, MAIN_SKILL_OFF=1) ─────────────────────

test("evaluate: session-disabled (env + сентинел) → null, хотя иначе был бы deny", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: "a",
      new_string: Array.from({ length: 30 }, () => "x").join("\n"),
    },
  };
  // sanity: без выключения этот payload даёт deny.
  assert.ok(g.evaluate(p, denyDeps()));
  // env-выключение.
  assert.equal(g.evaluate(p, denyDeps({ env: { MAIN_SKILL_OFF: "1" } })), null);
  // сентинел-файл под HOME.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "msg-home-"));
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", ".main-skill-off"),
    "",
  );
  assert.equal(g.evaluate(p, denyDeps({ env: { HOME: home } })), null);
});
