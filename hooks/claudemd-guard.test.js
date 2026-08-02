const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const g = require("./claudemd-guard");

test("countLines: пустая строка = 0", () => {
  assert.equal(g.countLines(""), 0);
  assert.equal(g.countLines(null), 0);
  assert.equal(g.countLines(undefined), 0);
});

test("countLines: считает строки по \\n", () => {
  assert.equal(g.countLines("a"), 1);
  assert.equal(g.countLines("a\nb\nc"), 3);
  assert.equal(g.countLines("a\nb\n"), 3);
});

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

test("netAddedLines MultiEdit: суммирует net по всем edits", () => {
  const r = g.netAddedLines(
    "MultiEdit",
    {
      file_path: "/x/CLAUDE.md",
      edits: [
        { old_string: "a", new_string: "a\nb\nc" },
        { old_string: "x", new_string: "x\ny\nz\nw" },
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

const RU = "правило про хук и триггер\n";
const RU_BYTES = Buffer.byteLength(RU, "utf8");
const ruText = (bytes) => RU.repeat(Math.ceil(bytes / RU_BYTES));

test("resolveMaxBytes: дефолт 40KB, env переопределяет, мусор → дефолт", () => {
  assert.equal(g.resolveMaxBytes({}), 40 * 1024);
  assert.equal(
    g.resolveMaxBytes({ MAIN_SKILL_CLAUDEMD_MAXBYTES: "8192" }),
    8192,
  );
  assert.equal(
    g.resolveMaxBytes({ MAIN_SKILL_CLAUDEMD_MAXBYTES: "0" }),
    40 * 1024,
  );
  assert.equal(
    g.resolveMaxBytes({ MAIN_SKILL_CLAUDEMD_MAXBYTES: "ы" }),
    40 * 1024,
  );
});

test("projectedBytes: кириллица считается в байтах, а не символах", () => {
  const s = "привет";
  assert.equal(
    g.projectedBytes(
      "Write",
      { file_path: "/x/CLAUDE.md", content: s },
      () => null,
    ),
    12,
  );
});

test("projectedBytes: Edit/MultiEdit = размер на диске - old + new", () => {
  const disk = () => "x".repeat(1000);
  assert.equal(
    g.projectedBytes(
      "Edit",
      { file_path: "/x/CLAUDE.md", old_string: "xx", new_string: "yyyyy" },
      disk,
    ),
    1003,
  );
  assert.equal(
    g.projectedBytes(
      "MultiEdit",
      {
        file_path: "/x/CLAUDE.md",
        edits: [
          { old_string: "x", new_string: "yy" },
          { old_string: "xxx", new_string: "" },
        ],
      },
      disk,
    ),
    998,
  );
  assert.equal(g.projectedBytes("Edit", { new_string: 1 }, disk), null);
  assert.equal(g.projectedBytes("Edit", null, disk), null);
});

test("evaluate: правка, уводящая файл за кап → deny про размер", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: "",
      new_string: "новая секция\n",
    },
  };
  const out = g.evaluate(p, denyDeps({ readFile: () => ruText(41 * 1024) }));
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /при капе 40KB/);
  assert.match(out.reason, /Не менять, потому что/);
});

test("evaluate: под капом крупная правка гардится порогом, а не размером", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: "a",
      new_string: Array.from({ length: 30 }, () => "x").join("\n"),
    },
  };
  const out = g.evaluate(p, denyDeps({ readFile: () => "small\n" }));
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /порог 20/);
});

test("evaluate: кап бьёт и по созданию-с-нуля (в отличие от порога)", () => {
  const p = {
    tool_name: "Write",
    tool_input: { file_path: "/x/CLAUDE.md", content: ruText(41 * 1024) },
  };
  const out = g.evaluate(p, denyDeps({ readFile: () => null }));
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /весит ~4[12]KB/);
});

test("evaluate: правка, СОКРАЩАЮЩАЯ раздутый файл ниже капа → пропускаем", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: ruText(30 * 1024),
      new_string: "коротко\n",
    },
  };
  assert.equal(
    g.evaluate(p, denyDeps({ readFile: () => ruText(45 * 1024) })),
    null,
  );
});

test("evaluate: кап переопределяется env", () => {
  const p = {
    tool_name: "Write",
    tool_input: { file_path: "/x/CLAUDE.md", content: ruText(41 * 1024) },
  };
  assert.equal(
    g.evaluate(
      p,
      denyDeps({
        env: { MAIN_SKILL_CLAUDEMD_MAXBYTES: String(100 * 1024) },
        readFile: () => null,
      }),
    ),
    null,
  );
});

test("evaluate: session-disabled (env + сентинел) → null, хотя иначе был бы deny", () => {
  const p = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: "a",
      new_string: Array.from({ length: 30 }, () => "x").join("\n"),
    },
  };
  assert.ok(g.evaluate(p, denyDeps()));
  assert.equal(g.evaluate(p, denyDeps({ env: { MAIN_SKILL_OFF: "1" } })), null);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "msg-home-"));
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", ".main-skill-off"),
    "",
  );
  assert.equal(g.evaluate(p, denyDeps({ env: { HOME: home } })), null);
});

test("evaluate: над капом уменьшающая правка проходит, растущая — нет", () => {
  const disk = ruText(45 * 1024);
  const shrink = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: RU.repeat(50),
      new_string: RU.repeat(20),
    },
  };
  assert.equal(g.evaluate(shrink, denyDeps({ readFile: () => disk })), null);

  const grow = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: RU.repeat(20),
      new_string: RU.repeat(50),
    },
  };
  const out = g.evaluate(grow, denyDeps({ readFile: () => disk }));
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /УМЕНЬШАЕТ/);
});

test("evaluate: над капом правка того же размера не проходит", () => {
  const disk = ruText(45 * 1024);
  const same = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/x/CLAUDE.md",
      old_string: RU.repeat(20),
      new_string: "я".repeat(Buffer.byteLength(RU.repeat(20), "utf8") / 2),
    },
  };
  assert.ok(g.evaluate(same, denyDeps({ readFile: () => disk })));
});
