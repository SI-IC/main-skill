const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const a = require("./audit-ignore-globs");

const VAR = "MAIN_SKILL_VERIFY_IGNORE_GLOBS";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aig-"));
}

test("describeBroad: каталог-глоб → упоминает папку", () => {
  assert.match(a.describeBroad("src/**"), /src\//);
  assert.match(a.describeBroad("config/*"), /config\//);
});

test("describeBroad: `**` в одиночку → всё дерево", () => {
  assert.match(a.describeBroad("**"), /дерев/i);
});

test("describeBroad: язык-глоб → упоминает расширение", () => {
  assert.match(a.describeBroad("**/*.ts"), /\.ts/);
  assert.match(a.describeBroad("*.py"), /\.py/);
});

test("classifySources: разносит по isBroadIgnoreGlob", () => {
  const sources = [
    { label: ".env", globs: ["src/**", "**/*.gen.ts", "*.ts", "schema.ts"] },
  ];
  const { broad, narrow } = a.classifySources(sources);
  assert.deepEqual(
    broad.map((b) => b.glob),
    ["src/**", "*.ts"],
  );
  assert.deepEqual(
    narrow.map((n) => n.glob),
    ["**/*.gen.ts", "schema.ts"],
  );
  assert.equal(broad[0].label, ".env");
  assert.ok(broad[0].why);
});

test("classifySources: sanitize применяется к отображаемому глобу", () => {
  const sources = [{ label: ".env", globs: ["dir\x1b[2K/**"] }];
  const { broad } = a.classifySources(sources, a.sanitizeGlob);
  assert.equal(broad.length, 1);
  assert.doesNotMatch(broad[0].glob, /\x1b/);
});

test("walkCarrierFiles: находит carrier, пропускает node_modules/.git", () => {
  const root = tmpProject();
  try {
    fs.writeFileSync(path.join(root, ".env"), "X=1");
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{}");
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", ".env"), "X=1");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "config.sh"), "");
    fs.writeFileSync(path.join(root, "README.md"), "# doc");

    const found = a.walkCarrierFiles(root).map((f) => path.relative(root, f));
    assert.ok(found.includes(".env"));
    assert.ok(found.includes(path.join(".claude", "settings.json")));
    assert.ok(!found.some((f) => f.includes("node_modules")));
    assert.ok(!found.some((f) => f.includes(".git")));
    assert.ok(!found.includes("README.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectSources: env + project-файлы + home", () => {
  const root = tmpProject();
  const home = tmpProject();
  try {
    fs.writeFileSync(path.join(root, ".env"), `${VAR}=src/**:**/*.gen.ts`);
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", "settings.json"),
      `{ "env": { "${VAR}": "config/*" } }`,
    );
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      `{ "env": { "${VAR}": "app/**" } }`,
    );

    const sources = a.collectSources({
      rootDir: root,
      env: { [VAR]: "scripts/**:lib/x.ts" },
      homeDir: home,
    });
    const byLabel = Object.fromEntries(sources.map((s) => [s.label, s.globs]));
    assert.deepEqual(byLabel["окружение (env)"], ["scripts/**", "lib/x.ts"]);
    assert.deepEqual(byLabel[".env"], ["src/**", "**/*.gen.ts"]);
    assert.deepEqual(byLabel[path.join(".claude", "settings.json")], [
      "config/*",
    ]);
    assert.deepEqual(byLabel["~/.claude/settings.json"], ["app/**"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("collectSources: нет присваиваний → пустой список", () => {
  const root = tmpProject();
  try {
    fs.writeFileSync(path.join(root, ".env"), "FOO=bar");
    const sources = a.collectSources({ rootDir: root, env: {}, homeDir: null });
    assert.deepEqual(sources, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectSources: отсутствующие home-carrier-файлы → пропуск (external-failure)", () => {
  const home = tmpProject();
  try {
    const sources = a.collectSources({ rootDir: null, env: {}, homeDir: home });
    assert.deepEqual(sources, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("safeRead-путь: директория вместо файла → '' (не читаем не-файл)", () => {
  const root = tmpProject();
  try {
    fs.mkdirSync(path.join(root, ".env"));
    const sources = a.collectSources({ rootDir: root, env: {}, homeDir: null });
    assert.deepEqual(sources, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("walkCarrierFiles: maxDepth ограничивает глубину (boundary)", () => {
  const root = tmpProject();
  try {
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, ".env"), "X=1");
    assert.equal(a.walkCarrierFiles(root, { maxDepth: 1 }).length, 0);
    assert.equal(a.walkCarrierFiles(root, { maxDepth: 8 }).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("classifySources: пустые/мусорные глобы не роняют классификатор (malformed)", () => {
  const sources = [{ label: ".env", globs: ["", "   ", "***", "/", "a b"] }];
  assert.doesNotThrow(() => a.classifySources(sources, a.sanitizeGlob));
  const { broad, narrow } = a.classifySources(sources, a.sanitizeGlob);
  assert.equal(broad.length + narrow.length, 5);
});

test("formatReport: широкие → раздел ⚠ + summary про VERIFY_CHANGES", () => {
  const sources = [{ label: ".env", globs: ["src/**", "**/*.gen.ts"] }];
  const out = a.formatReport(sources, "/repo", a.sanitizeGlob);
  assert.match(out, /ШИРОК/i);
  assert.match(out, /src\/\*\*/);
  assert.match(out, /\*\*\/\*\.gen\.ts/);
  assert.match(out, /VERIFY_CHANGES=0/);
});

test("formatReport: только узкие → нет раздела ШИРОКИЕ", () => {
  const sources = [{ label: ".env", globs: ["**/*.gen.ts", "schema.ts"] }];
  const out = a.formatReport(sources, "/repo", a.sanitizeGlob);
  assert.doesNotMatch(out, /ШИРОКИЕ глобы/);
  assert.match(out, /узк/i);
});

test("formatReport: пусто → 'нигде не задан'", () => {
  const out = a.formatReport([], "/repo", a.sanitizeGlob);
  assert.match(out, /нигде не задан/i);
});

test("formatReport: ESC в dir-части широкого глоба НЕ протекает в why (terminal-injection)", () => {
  const sources = [{ label: ".env", globs: ["evil\x1b[2K/**"] }];
  const out = a.formatReport(sources, "/repo", a.sanitizeGlob);
  assert.match(out, /ШИРОК/i);
  assert.doesNotMatch(out, /\x1b/);
});

test("formatReport: ESC в label (имя файла) НЕ протекает (terminal-injection)", () => {
  const sources = [{ label: "ev\x1b[2Kil.sh", globs: ["src/**"] }];
  const out = a.formatReport(sources, "/repo", a.sanitizeGlob);
  assert.doesNotMatch(out, /\x1b/);
});

test("run: несуществующий путь → 'путь не найден' (usability, не молчит)", () => {
  const out = a.run(["node", "audit", "/no/such/dir/xyz123"], {}, null);
  assert.match(out, /путь не найден/);
});

test("safeRead cap: carrier 3MB (>старый 2MB, <5MB) всё ещё читается", () => {
  const root = tmpProject();
  try {
    const pad = "#".repeat(3 * 1024 * 1024);
    fs.writeFileSync(
      path.join(root, ".env"),
      "MAIN_SKILL_VERIFY_IGNORE" + "_GLOBS=src/**\n" + pad,
    );
    const sources = a.collectSources({ rootDir: root, env: {}, homeDir: null });
    assert.equal(sources.length, 1);
    assert.deepEqual(sources[0].globs, ["src/**"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run: интеграция — temp-проект с широким глобом в .env", () => {
  const root = tmpProject();
  try {
    fs.writeFileSync(path.join(root, ".env"), `${VAR}="src/**:*.d.ts"`);
    const out = a.run(["node", "audit", root], {}, null);
    assert.match(out, /ШИРОК/i);
    assert.match(out, /src\/\*\*/);
    assert.match(out, /\*\.d\.ts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
