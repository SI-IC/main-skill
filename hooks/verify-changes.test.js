const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const checks = require("./lib/checks");

const HOOK = path.join(__dirname, "verify-changes.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msv-"));
}

function writeFile(dir, rel, body) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

function writeTranscript(dir, entries) {
  const p = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n"));
  return p;
}

function runHook(transcript_path, env = {}) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ transcript_path }),
    encoding: "utf8",
    env: {
      ...process.env,
      MAIN_SKILL_VERIFY_TAIL_WAIT_MS: "0",
      MAIN_SKILL_VERIFY_LINT: "0",
      MAIN_SKILL_VERIFY_REVIEW: "0",
      MAIN_SKILL_VERIFY_DEPS: "0",
      MAIN_SKILL_VERIFY_PREMORTEM: "0",
      CLAUDE_PROJECT_DIR:
        env.CLAUDE_PROJECT_DIR || path.dirname(transcript_path),
      ...env,
    },
    timeout: 15_000,
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

function expectBlock(stdout, expectedTrigger) {
  const parsed = JSON.parse(stdout || "{}");
  assert.strictEqual(
    parsed.decision,
    "block",
    `expected block, got stdout: ${stdout}`,
  );
  if (expectedTrigger) {
    assert.match(
      parsed.reason,
      new RegExp(`триггер ${expectedTrigger}\\b`),
      `expected trigger ${expectedTrigger}, got: ${parsed.reason}`,
    );
  }
}

function expectNoBlock(stdout) {
  assert.strictEqual(stdout.trim(), "", `expected no block, got: ${stdout}`);
}

function asstEdit(file_path, name = "Edit") {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: { file_path } }] },
  };
}

function asstBash(command) {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  };
}

function asstText(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

function asstTask(subagent_type, description, prompt, model) {
  const input = { subagent_type, description, prompt };
  if (model !== undefined) input.model = model;
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Task", input }],
    },
  };
}

function asstAgent(subagent_type, description, prompt) {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Agent",
          input: { subagent_type, description, prompt },
        },
      ],
    },
  };
}

function asstEditWith(file_path, new_string) {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Edit",
          input: { file_path, old_string: "", new_string },
        },
      ],
    },
  };
}

function asstEditDelta(file_path, old_string, new_string) {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Edit",
          input: { file_path, old_string, new_string },
        },
      ],
    },
  };
}

const BIG_DIFF = Array.from(
  { length: 25 },
  (_, i) => `const x${i} = ${i};`,
).join("\n");

// Не менять, потому что фикстура держит дельту < 20: rename в широком якоре
// не должен форсить J/N.
const RENAME_OLD = BIG_DIFF;
const RENAME_NEW = BIG_DIFF.replace("const x3 = 3;", "const renamed3 = 3;");

const SUCCESS = "готово, всё работает";
const EDGE_CASES_BLOCK = (file, name) =>
  `<edge-cases>empty:${file}:${name}; race:${file}:${name}</edge-cases>`;

test("triggerC: делегирование shell блокируется", () => {
  const dir = tmp();
  const tp = writeTranscript(dir, [
    asstBash("ls"),
    asstText("Запусти у себя в терминале: ```\nnpm test\n```"),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "C");
});

test("triggerB: дисклеймер без попыток разведки блокируется", () => {
  const dir = tmp();
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstText("Фикс применён. End-to-end не проверил, проверь вручную."),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "B");
});

test("triggerD: src без парного теста блокируется", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(
      SUCCESS + " " + EDGE_CASES_BLOCK("tests/unit/foo.test.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "D");
});

test("triggerD: централизованный спек по фиче с импортом источника засчитывается", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export const calc = () => 1;");
  // Не менять, потому что имя спека НЕ зеркалит источник: засчитаться он обязан
  // через import-scan, а не findPairedTestFile.
  writeFile(
    dir,
    "tests/unit/checkout_flow.spec.ts",
    "import { calc } from '../../app/services/billing'\nit('empty', () => {});",
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/services/billing.ts")),
    asstBash("curl -s http://localhost:3000/api/checkout"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("tests/unit/checkout_flow.spec.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerD: централизованный спек БЕЗ импорта источника не засчитывается", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export const calc = () => 1;");
  writeFile(
    dir,
    "tests/unit/checkout_flow.spec.ts",
    "import { x } from '../../app/services/other'\nit('empty', () => {});",
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/services/billing.ts")),
    asstBash("curl -s http://localhost:3000/api/checkout"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("tests/unit/checkout_flow.spec.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "D");
});

test("triggerD: хвостовой релевантный спек за кэпом засчитывается (ранжирование, регресс)", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(
    dir,
    "app/validators/auth_validator.ts",
    "export const v = () => 1;",
  );
  // Не менять, потому что 205 алфавитно-ранних наполнителей и есть суть кейса:
  // при алфавитном порядке покрывающий спек уходит за бюджет.
  for (let i = 0; i < 205; i++) {
    const n = String(i).padStart(3, "0");
    writeFile(
      dir,
      `tests/unit/controllers/spec_${n}.spec.ts`,
      `import { t } from '#controllers/thing${n}'\nit('t', () => {});`,
    );
  }
  writeFile(
    dir,
    "tests/unit/validators/auth_flow.spec.ts",
    "import { v } from '#validators/auth_validator'\nit('empty', () => {});",
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/validators/auth_validator.ts")),
    asstBash("curl -s http://localhost:3000/api/auth"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("tests/unit/validators/auth_flow.spec.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerD: обрыв скана бюджетом → reason содержит ⚠-блок с grep-рецептом", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export const calc = () => 1;");
  for (let i = 0; i < 210; i++) {
    writeFile(
      dir,
      `tests/unit/f${String(i).padStart(3, "0")}.spec.ts`,
      "import { x } from '#other/thing'\nit('t', () => {});",
    );
  }
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/services/billing.ts")),
    asstBash("curl -s http://localhost:3000/api/billing"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("tests/unit/f000.spec.ts", "t")),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "D");
  const reason = JSON.parse(r.stdout).reason;
  assert.match(reason, /ОБОРВАН бюджетом/);
  assert.match(reason, /grep -rlF "billing"/);
  assert.match(reason, /MAIN_SKILL_IMPORT_SCAN_MAX_FILES/);
});

test("triggerD: злой basename не инжектится в grep-рецепт ⚠-блока", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/bil$(id)ling.ts", "export const c = () => 1;");
  for (let i = 0; i < 210; i++) {
    writeFile(
      dir,
      `tests/unit/f${String(i).padStart(3, "0")}.spec.ts`,
      "import { x } from '#other/thing'\nit('t', () => {});",
    );
  }
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/services/bil$(id)ling.ts")),
    asstBash("curl -s http://localhost:3000/api/billing"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("tests/unit/f000.spec.ts", "t")),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "D");
  const reason = JSON.parse(r.stdout).reason;
  assert.match(reason, /grep -rlF "bilidling"/);
  const grepLine = reason.split("\n").find((l) => l.includes("grep -rlF"));
  assert.ok(!/[$`();|]/.test(grepLine), `метасимвол в рецепте: ${grepLine}`);
});

test("triggerD: файл вне repoRoot (throwaway-скрипт в /tmp) не требует теста", () => {
  // Не менять, потому что путь обязан быть вне проекта: репро-скрипт в /tmp
  // покрывать нечем.
  const dir = tmp();
  const outside = tmp();
  writeFile(dir, "src/covered.ts", "export const a = 1;");
  writeFile(dir, "src/covered.test.ts", "it('a', () => {});");
  writeFile(outside, "scratch.js", "console.log(1);");
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/covered.ts")),
    asstEdit(path.join(outside, "scratch.js")),
    asstBash("curl -s http://localhost:3000/api/x"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/covered.test.ts", "a")),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerD: удалённый в ходе сессии файл не требует теста", () => {
  const dir = tmp();
  writeFile(dir, "src/covered.ts", "export const a = 1;");
  writeFile(dir, "src/covered.test.ts", "it('a', () => {});");
  const gone = writeFile(dir, "src/tmp_probe.js", "console.log(1);");
  fs.rmSync(gone);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/covered.ts")),
    asstEdit(gone),
    asstBash("curl -s http://localhost:3000/api/x"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/covered.test.ts", "a")),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerD: без обрыва скана ⚠-блока в reason нет", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(
      SUCCESS + " " + EDGE_CASES_BLOCK("tests/unit/foo.test.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "D");
  const reason = JSON.parse(r.stdout).reason;
  assert.doesNotMatch(reason, /ОБОРВАН бюджетом/);
});

test("triggerE: критичный endpoint (auth) без endpoint-теста блокируется", () => {
  const dir = tmp();
  writeFile(dir, "app/controllers/auth_controller.ts", "x");
  writeFile(
    dir,
    "app/controllers/auth_controller.test.ts",
    `it('empty', () => {});`,
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/controllers/auth_controller.ts")),
    asstBash("curl -s http://localhost:3000/login"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("app/controllers/auth_controller.test.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "E");
});

test("triggerE: рядовой controller с парным unit-тестом НЕ требует endpoint-теста", () => {
  const dir = tmp();
  writeFile(dir, "app/controllers/posts_controller.ts", "x");
  writeFile(
    dir,
    "app/controllers/posts_controller.test.ts",
    `it('empty', () => {});`,
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/controllers/posts_controller.ts")),
    asstBash("curl -s http://localhost:3000/posts"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("app/controllers/posts_controller.test.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerE: критичный endpoint с tests/integration-тестом проходит", () => {
  const dir = tmp();
  writeFile(dir, "app/controllers/auth_controller.ts", "x");
  writeFile(
    dir,
    "tests/integration/auth_controller.test.ts",
    `it('empty', () => {});`,
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/controllers/auth_controller.ts")),
    asstBash("curl -s http://localhost:3000/login"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("tests/integration/auth_controller.test.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerE: рядовой по имени controller с мутирующим handler-ом блокируется", () => {
  const dir = tmp();
  // Не менять, потому что имя намеренно НЕ критичное: кейс проверяет,
  // что мутация ловится по контенту, а не по пути.
  writeFile(
    dir,
    "app/controllers/users_controller.ts",
    "export default class UsersController { async destroy({ params }) {} }\n",
  );
  writeFile(
    dir,
    "app/controllers/users_controller.test.ts",
    `it('empty', () => {});`,
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/controllers/users_controller.ts")),
    asstBash("curl -s http://localhost:3000/users"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("app/controllers/users_controller.test.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "E");
});

const CARD_TSX = "export function Card() { return <div data-x>hi</div>; }\n";

function asstMcp(name, input = {}) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  };
}

test("triggerM: playwright через свой скрипт закрывает рендер-проверку", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.tsx", CARD_TSX);
  writeFile(dir, "src/Card.test.tsx", `it('empty', () => {});`);
  writeFile(
    dir,
    "scratch/verify.mjs",
    'import { chromium } from "playwright";\nawait chromium.launch();\n',
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/Card.tsx")),
    asstBash(`cd ${path.join(dir, "scratch")} && node verify.mjs "jwt" 2>&1`),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/Card.test.tsx", "empty")),
  ]);
  expectNoBlock(runHook(tp, { CLAUDE_PROJECT_DIR: dir }).stdout);
});

test("triggerM: скрипт без браузерного драйвера рендер не закрывает", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.tsx", CARD_TSX);
  writeFile(dir, "src/Card.test.tsx", `it('empty', () => {});`);
  writeFile(dir, "scratch/verify.mjs", 'console.log("no browser");\n');
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/Card.tsx")),
    asstBash(`cd ${path.join(dir, "scratch")} && node verify.mjs 2>&1`),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/Card.test.tsx", "empty")),
  ]);
  expectBlock(runHook(tp, { CLAUDE_PROJECT_DIR: dir }).stdout, "M");
});

test("triggerM: фронт-правка с unit-прогоном, но без рендера — блокируется", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.tsx", CARD_TSX);
  writeFile(dir, "src/Card.test.tsx", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/Card.tsx")),
    asstBash("npx vitest run"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/Card.test.tsx", "empty")),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "M");
});

test("triggerM: curl localhost после фронт-правки — проходит", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.tsx", CARD_TSX);
  writeFile(dir, "src/Card.test.tsx", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/Card.tsx")),
    asstBash("curl -s http://localhost:3000/cards"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/Card.test.tsx", "empty")),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerM: активный браузер-MCP после фронт-правки — проходит", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.tsx", CARD_TSX);
  writeFile(dir, "src/Card.test.tsx", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/Card.tsx")),
    asstMcp("mcp__claude-in-chrome__navigate", {
      url: "http://localhost:3000",
    }),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/Card.test.tsx", "empty")),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerM: правка тест-файла ПОСЛЕ рендера не ре-триггерит M", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.tsx", CARD_TSX);
  writeFile(dir, "src/Card.test.tsx", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/Card.tsx")),
    asstBash("curl -s http://localhost:3000/cards"),
    asstEdit(path.join(dir, "src/Card.test.tsx")),
    asstBash("npx vitest run"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/Card.test.tsx", "empty")),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerM: type-only .tsx exempt — рендер не требуется", () => {
  const dir = tmp();
  writeFile(
    dir,
    "src/types.tsx",
    "export interface CardProps { title: string }\n",
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/types.tsx")),
    asstBash("npx vitest run"),
    asstText(SUCCESS + " " + "<edge-cases>types:N/A:type-only</edge-cases>"),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerM: token-only CSS exempt, CSS с правилами — блокируется", () => {
  const dir = tmp();
  writeFile(dir, "src/tokens.css", ":root {\n--brand: #fff;\n}\n");
  writeFile(dir, "src/dummy.test.ts", `it('empty', () => {});`);
  const tpTokens = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/tokens.css")),
    asstBash("npx vitest run"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/dummy.test.ts", "empty")),
  ]);
  expectNoBlock(runHook(tpTokens, { CLAUDE_PROJECT_DIR: dir }).stdout);

  const dir2 = tmp();
  writeFile(dir2, "src/card.css", ".card { color: red; }\n");
  writeFile(dir2, "src/dummy.test.ts", `it('empty', () => {});`);
  const tpRules = writeTranscript(dir2, [
    asstEdit(path.join(dir2, "src/card.css")),
    asstBash("npx vitest run"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/dummy.test.ts", "empty")),
  ]);
  expectBlock(runHook(tpRules, { CLAUDE_PROJECT_DIR: dir2 }).stdout, "M");
});

test("triggerM: MAIN_SKILL_VERIFY_RENDER=0 выключает триггер", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.tsx", CARD_TSX);
  writeFile(dir, "src/Card.test.tsx", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/Card.tsx")),
    asstBash("npx vitest run"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/Card.test.tsx", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_RENDER: "0",
  });
  expectNoBlock(r.stdout);
});

test("triggerF: нет блока <edge-cases> блокируется", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(SUCCESS + " (без блока edge-cases)"),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "F");
});

test("triggerF: невалидная декларация блокируется", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('happy', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(
      SUCCESS +
        " <edge-cases>empty:src/foo.test.ts:nonexistent_test_name</edge-cases>",
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "F");
});

test("triggerF: sh-декларация — TAP-лейбл в *.test.sh засчитывается (нет блока)", () => {
  const dir = tmp();
  writeFile(dir, "scripts/foo.sh", "#!/bin/sh\necho hi\n");
  writeFile(
    dir,
    "scripts/foo.test.sh",
    `#!/bin/sh\n# 2a. пустой stdin\necho "ok - пустой stdin не роняет хук"\n`,
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "scripts/foo.sh")),
    asstBash("sh scripts/foo.test.sh"),
    asstText(
      SUCCESS +
        " <edge-cases>empty:scripts/foo.test.sh:пустой stdin не роняет</edge-cases>",
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerF: sh-декларация с несуществующим лейблом блокируется", () => {
  const dir = tmp();
  writeFile(dir, "scripts/foo.sh", "#!/bin/sh\necho hi\n");
  writeFile(
    dir,
    "scripts/foo.test.sh",
    `#!/bin/sh\necho "ok - совсем другой лейбл"\n`,
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "scripts/foo.sh")),
    asstBash("sh scripts/foo.test.sh"),
    asstText(
      SUCCESS +
        " <edge-cases>race:scripts/foo.test.sh:concurrent login</edge-cases>",
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "F");
});

test("lastText: промежуточный success-нарратив, за которым идёт tool_use, НЕ считается финальным claim", () => {
  // Не менять, потому что кейс закрывает регресс: промежуточный нарратив, за
  // которым идёт tool_use, принимался за финальный claim.
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(SUCCESS + " (промежуточный нарратив, без edge-cases)"),
    asstTask("general-purpose", "доделать", "ещё работаю"),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("lastText: терминальный текст после tool_use оценивается нормально (claim есть → F блокирует)", () => {
  // Не менять, потому что это контр-проверка к предыдущему кейсу: детект финала
  // не должен ослабнуть.
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstTask("general-purpose", "ревью", "code review"),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(SUCCESS + " (терминальный claim, без edge-cases)"),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "F");
});

test("triggerH: public surface (config) без doc edits блокируется", () => {
  const dir = tmp();
  writeFile(dir, ".claude-plugin/plugin.json", '{"name":"x"}');
  // Не менять, потому что кейс держит observableSrcFiles пустым: только так
  // проверяется, что H срабатывает, а F при этом не требует блока.
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, ".claude-plugin/plugin.json")),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(SUCCESS),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "H");
});

test("happy path: edits + verify + tests + edge-cases → НЕ блокируется", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(
    dir,
    "src/foo.test.ts",
    `it('empty', () => {});\nit('race_concurrent', () => {});`,
  );
  writeFile(dir, "README.md", "# foo");
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstEdit(path.join(dir, "src/foo.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(
      SUCCESS +
        " <edge-cases>empty:src/foo.test.ts:empty; race:src/foo.test.ts:race_concurrent</edge-cases>",
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("anti-loop: повторный success после блока не триггерит снова", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstText(SUCCESS),
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: "[main-skill:verify-changes] Stop заблокирован",
          },
        ],
      },
    },
    asstText(SUCCESS),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("опт-аут MAIN_SKILL_VERIFY_CHANGES=0 отключает все триггеры", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstText(SUCCESS),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_CHANGES: "0",
  });
  expectNoBlock(r.stdout);
});

test("docs-only edit (только *.md) не триггерит D/E/F (docs не observable src)", () => {
  const dir = tmp();
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "README.md")),
    asstText(SUCCESS),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerD НЕ срабатывает на миграции (timestamp filename + migrations dir)", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "backend/package.json", "{}");
  writeFile(
    dir,
    "backend/database/migrations/1777287343989_create_users_table.ts",
    "export class CreateUsers {}",
  );
  writeFile(dir, "backend/app/services/foo.ts", "export class Foo {}");
  writeFile(dir, "backend/tests/unit/foo.spec.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(
      path.join(
        dir,
        "backend/database/migrations/1777287343989_create_users_table.ts",
      ),
    ),
    asstEdit(path.join(dir, "backend/app/services/foo.ts")),
    asstBash("cd backend && pnpm test"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("backend/tests/unit/foo.spec.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerD НЕ срабатывает на type-only TS", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(
    dir,
    "src/types/role.ts",
    `export type Role = 'admin' | 'user';\nexport interface Permission { name: string }`,
  );
  writeFile(dir, "src/services/foo.ts", "export class Foo {}");
  writeFile(dir, "src/services/foo.spec.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/types/role.ts")),
    asstEdit(path.join(dir, "src/services/foo.ts")),
    asstBash("npm test"),
    asstText(
      SUCCESS + " " + EDGE_CASES_BLOCK("src/services/foo.spec.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerD НЕ срабатывает на декларативную Lucid-модель (content-skip)", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(
    dir,
    "app/models/ai_conversation.ts",
    `import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
export default class AiConversation extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @hasMany(() => AiConversation)
  declare replies: HasMany<typeof AiConversation>
}`,
  );
  writeFile(dir, "src/services/foo.ts", "export class Foo {}");
  writeFile(dir, "src/services/foo.spec.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/models/ai_conversation.ts")),
    asstEdit(path.join(dir, "src/services/foo.ts")),
    asstBash("npm test"),
    asstText(
      SUCCESS + " " + EDGE_CASES_BLOCK("src/services/foo.spec.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("triggerD срабатывает на Lucid-модель С логикой (@computed)", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(
    dir,
    "app/models/user.ts",
    `import { BaseModel, column } from '@adonisjs/lucid/orm'
export default class User extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @computed()
  get displayName() {
    return this.id
  }
}`,
  );
  writeFile(dir, "src/services/foo.ts", "export class Foo {}");
  writeFile(dir, "src/services/foo.spec.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "app/models/user.ts")),
    asstEdit(path.join(dir, "src/services/foo.ts")),
    asstBash("npm test"),
    asstText(
      SUCCESS + " " + EDGE_CASES_BLOCK("src/services/foo.spec.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "D");
});

test("triggerD НЕ срабатывает на framework-config (vite.config.ts)", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "vite.config.ts", "export default {}");
  writeFile(dir, "src/foo.ts", "export class Foo {}");
  writeFile(dir, "src/foo.spec.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "vite.config.ts")),
    asstEdit(path.join(dir, "src/foo.ts")),
    asstBash("npm test"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.spec.ts", "empty")),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("MAIN_SKILL_VERIFY_IGNORE_GLOBS пропускает указанный паттерн", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "legacy/old_module.ts", "export class Old {}");
  writeFile(dir, "src/util.ts", "export class Util {}");
  writeFile(dir, "src/util.spec.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "legacy/old_module.ts")),
    asstEdit(path.join(dir, "src/util.ts")),
    asstBash("npm test"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/util.spec.ts", "empty")),
  ]);
  const blocked = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(blocked.stdout, "D");
  const reasonD = JSON.parse(blocked.stdout).reason;
  assert.match(reasonD, /узкий глоб|ignore-glob-guard/);
  const allowed = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_IGNORE_GLOBS: "**/legacy/**",
  });
  expectNoBlock(allowed.stdout);
});

test("triggerD срабатывает в monorepo, когда тест в backend/tests/unit/ есть и не находится без фикса", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "backend/package.json", "{}");
  writeFile(
    dir,
    "backend/app/services/audit_log_service.ts",
    "export class AuditLog {}",
  );
  writeFile(
    dir,
    "backend/tests/unit/audit_log_service.spec.ts",
    `it('empty', () => {});`,
  );
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "backend/app/services/audit_log_service.ts")),
    asstBash("cd backend && pnpm test"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK(
          "backend/tests/unit/audit_log_service.spec.ts",
          "empty",
        ),
    ),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

function setupReviewBase(
  dir,
  srcPath = "src/foo.ts",
  testRel = "src/foo.test.ts",
  extraNew = BIG_DIFF,
) {
  writeFile(dir, srcPath, "x");
  writeFile(
    dir,
    testRel,
    `it('empty', () => {});\nit('race_concurrent', () => {});`,
  );
  return [
    asstEditWith(path.join(dir, srcPath), extraNew),
    asstEdit(path.join(dir, testRel)),
    asstBash("npx vitest --run --changed"),
    asstBash("curl -s http://localhost:3000/api/foo"),
  ];
}

const SELF_REVIEW_OK = (codeStatus = "none-found", secStatus = "none-found") =>
  `<self-review>code:${codeStatus}\nsecurity:${secStatus}</self-review>`;

test("агрегация: мехчек и ритуал приходят одним блоком", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.tsx", CARD_TSX);
  writeFile(dir, "src/Card.test.tsx", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEditWith(path.join(dir, "src/Card.tsx"), BIG_DIFF),
    asstEdit(path.join(dir, "src/Card.test.tsx")),
    asstBash("npx vitest run"),
    asstText(SUCCESS),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "0",
  });
  const reason = JSON.parse(r.stdout).reason;
  assert.match(reason, /триггер M\b/, "мехчек M обязан быть в reason");
  assert.match(reason, /триггер F\b/, "ритуал F обязан быть в том же reason");
});

test("агрегация: J достижим, даже когда мехчек M уже сработал", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.tsx", CARD_TSX);
  writeFile(dir, "src/Card.test.tsx", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEditWith(path.join(dir, "src/Card.tsx"), BIG_DIFF),
    asstEdit(path.join(dir, "src/Card.test.tsx")),
    asstBash("npx vitest run"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/Card.test.tsx", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "code",
  });
  const reason = JSON.parse(r.stdout).reason;
  assert.match(reason, /триггер M\b/);
  assert.match(reason, /триггер J\b/, "до фикса J был недостижим за M");
});

test("агрегация: F, N и J приходят одним блоком", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [...base, asstText(SUCCESS)]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  const reason = JSON.parse(r.stdout).reason;
  const heads = reason
    .split("\n")
    .filter((l) =>
      l.startsWith("[main-skill:verify-changes] Stop заблокирован"),
    );
  assert.deepStrictEqual(
    heads.map((h) => (h.match(/триггер ([A-N])/) || [])[1]),
    ["F", "N", "J"],
    `ожидались все три ритуала, получено: ${heads.join(" | ")}`,
  );
  assert.match(reason, /Сработало триггеров: F, N, J/);
});

test("агрегация: закрытый ритуал в блок не попадает", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  const reason = JSON.parse(r.stdout).reason;
  assert.ok(!/триггер F\b/.test(reason), "валидный <edge-cases> закрыл F");
  assert.match(reason, /триггер N\b/);
  assert.match(reason, /триггер J\b/);
});

test("агрегация: одиночный ритуал приходит без разделителя", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  const reason = JSON.parse(r.stdout).reason;
  assert.match(reason, /триггер J\b/);
  assert.ok(!reason.includes("─────"), "лишний разделитель при одном триггере");
});

test("triggerJ: значительный diff без self-review блока → block", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectBlock(r.stdout, "J");
  // Не менять, потому что кейс сторожит контр-авторизацию AgentTool-гейта в
  // тексте reasonJ.
  const reason = JSON.parse(r.stdout).reason;
  assert.match(reason, /unless the user requested it/);
  assert.match(reason, /запуск трёх ревью-сабагентов авторизован/);
});

test("triggerJ: тривиальная правка без self-review → НЕ блокирует", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEditWith(path.join(dir, "src/foo.ts"), "const a = 1;\nconst b = 2;"),
    asstEdit(path.join(dir, "src/foo.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ: rename с широким контекстным якорем — дельта тривиальна, self-review не требуется", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEditDelta(path.join(dir, "src/foo.ts"), RENAME_OLD, RENAME_NEW),
    asstEdit(path.join(dir, "src/foo.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ: security-sensitive путь требует self-review даже на тривиальной правке", () => {
  const dir = tmp();
  writeFile(dir, "src/auth_helper.ts", "x");
  writeFile(dir, "src/auth_helper.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEditWith(path.join(dir, "src/auth_helper.ts"), "const a = 1;"),
    asstEdit(path.join(dir, "src/auth_helper.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstText(
      SUCCESS + " " + EDGE_CASES_BLOCK("src/auth_helper.test.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectBlock(r.stdout, "J");
});

test("triggerJ: фейковый skipped:trivial при крупном diff → block", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " <self-review>skipped:trivial</self-review> " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectBlock(r.stdout, "J");
});

test("triggerJ: декларация code/security без Task-вызовов в transcript → block (fake-decl)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        SELF_REVIEW_OK("none-found", "none-found"),
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectBlock(r.stdout, "J");
});

test("triggerJ: review=code требует только code-секцию (security отсутствует — ОК)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask(
      "superpowers:code-reviewer",
      "review the auth changes",
      "please review the diff for code quality",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "code",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ: review=security требует только security (code отсутствует — ОК)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask(
      "general-purpose",
      "security audit",
      "security review with focus on OWASP Top-10, injection, auth bypass, secret leaks",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>security:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "security",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ: MAIN_SKILL_VERIFY_REVIEW=0 — J/K выключены целиком", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "0",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ + K: applied без обоснования / короткое — block (через K)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:applied:fixed\nsecurity:none-found</self-review>" +
        " <review-triage>code:1:applied:fixed</review-triage>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectBlock(r.stdout, "K");
});

test("triggerK: rejected с slop-only обоснованием → block", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:rejected:minor stuff\nsecurity:none-found</self-review>" +
        " <review-triage>\ncode:1:rejected:minor cosmetic nitpick, не критично\n</review-triage>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectBlock(r.stdout, "K");
});

test("triggerK: rejected с техническим обоснованием → НЕ блокирует", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:rejected:async logger pattern\nsecurity:none-found</self-review>" +
        " <review-triage>\ncode:1:rejected:async/await в logger fire-and-forget намеренно — потеря лога приемлемее блокировки запроса на горячем пути\n</review-triage>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

test("triggerK: none-found в обеих секциях → триаж не требуется", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        SELF_REVIEW_OK("none-found", "none-found"),
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ: fallback — code-review через general-purpose (без superpowers:code-reviewer) засчитывается", () => {
  // Не менять, потому что кейс закрывает регресс: general-purpose как fallback
  // обязан засчитываться, когда superpowers:code-reviewer недоступен.
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask(
      "general-purpose",
      "code review",
      "code review: качество, паттерны, дублирование, непокрытые edge-cases, нарушения конвенций",
    ),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        SELF_REVIEW_OK("none-found", "none-found"),
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ: ревью через инструмент Agent (Task недоступен в окружении) засчитывается", () => {
  // Не менять, потому что кейс закрывает регресс: в части сборок сабагент зовётся
  // Agent, а Task отсутствует.
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstAgent(
      "general-purpose",
      "code review",
      "code review: качество, паттерны, дублирование, непокрытые edge-cases",
    ),
    asstAgent(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        SELF_REVIEW_OK("none-found", "none-found"),
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ: per-section `code:skipped` НЕ принимается (regression: bypass через skipped)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:skipped:устал\nsecurity:skipped:устал</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectBlock(r.stdout, "J");
});

test("triggerK: русский slop без tech-сигнала блокируется (regression: \\b на кириллице)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:rejected:cosmetic стилистика\nsecurity:none-found</self-review>" +
        " <review-triage>\ncode:1:rejected:это косметика, мелочь, не важно для нас совсем\n</review-triage>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectBlock(r.stdout, "K");
});

test("triggerK: русское tech-обоснование с «потому что» проходит (regression: \\b на кириллице)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:rejected:async logger pattern\nsecurity:none-found</self-review>" +
        " <review-triage>\ncode:1:rejected:не делаем await потому что fire-and-forget на горячем пути приведёт к блокировке запроса\n</review-triage>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

test('triggerJ: невалидный MAIN_SKILL_VERIFY_REVIEW="off" → fallback на both (regression)', () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "off",
  });
  expectBlock(r.stdout, "J");
});

test("triggerJ: правка docs не учитывается в порог 20 строк (regression: filter observable)", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEditWith(path.join(dir, "src/foo.ts"), "const x = 1;"),
    asstEditWith(
      path.join(dir, "README.md"),
      Array.from({ length: 50 }, () => "doc line").join("\n"),
    ),
    asstEdit(path.join(dir, "src/foo.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

test("triggerK: ReDoS-защита — длинный buggy reason не подвешивает hook (regression)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const evil = "a".repeat(200_000);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask("general-purpose", "security review", "security review per OWASP"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:rejected:long\nsecurity:none-found</self-review>" +
        ` <review-triage>\ncode:1:rejected:${evil}\n</review-triage>`,
    ),
  ]);
  const start = Date.now();
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `hook took ${elapsed}ms, ReDoS не защищён`);
  // Не менять, потому что кейс проверяет только отсутствие катастрофического
  // backtracking, а не вердикт слоп-детектора.
  assert.ok(r.status === 0 || r.stdout.length >= 0);
});

test("triggerK: разделитель `;` между записями (regression: parser symmetry)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:applied:see triage\nsecurity:applied:see triage</self-review>" +
        " <review-triage>code:1:applied:src/foo.ts:42 — early-return на null user; security:1:applied:src/foo.ts:88 — sanitize redirect через allowlist</review-triage>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

test("triggerK: applied + полный валидный triage → НЕ блокирует", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <self-review>code:applied:see triage\nsecurity:applied:see triage</self-review>" +
        " <review-triage>\n" +
        "code:1:applied:src/foo.ts:42 — добавил early-return на null user\n" +
        "security:1:applied:src/foo.ts:88 — sanitize redirect через allowlist вместо regex\n" +
        "</review-triage>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
  });
  expectNoBlock(r.stdout);
});

const PREMORTEM_OK = [
  "<premortem>",
  "telegram sendMessage: text >4096 символов → 400 MESSAGE_TOO_LONG → чанковать по 4000",
  "parse_mode=Markdown: `*` в юзер-тексте → 400 can't parse entities → escape перед вставкой",
  "рассылка в цикле → 429 rate limit → троттлинг + уважать retry_after",
  "</premortem>",
].join("\n");

test("triggerN: нетривиальный diff без premortem-блока → block", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
});

test("triggerN: валидный premortem-блок до первой правки → НЕ блокирует", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    asstText(PREMORTEM_OK),
    ...base,
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("triggerN: ретро-блок в терминальном сообщении тоже засчитывается", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK,
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("triggerN: ASCII-стрелки -> принимаются", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const block =
    "<premortem>\n" +
    "sendMessage: text >4096 chars -> 400 MESSAGE_TOO_LONG -> chunk by 4000\n" +
    "parse_mode: raw `*` in name -> 400 cant parse entities -> escapeMarkdown\n" +
    "loop send -> 429 rate limit -> respect retry_after\n" +
    "</premortem>";
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        block,
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("triggerN: тривиальная правка — премортем не требуется", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEditWith(path.join(dir, "src/foo.ts"), "const a = 1;\nconst b = 2;"),
    asstEdit(path.join(dir, "src/foo.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("triggerN: rename с широким контекстным якорем — дельта тривиальна, премортем не требуется", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEditDelta(path.join(dir, "src/foo.ts"), RENAME_OLD, RENAME_NEW),
    asstEdit(path.join(dir, "src/foo.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("triggerN: дельта ровно 20 добавленных строк → block (флип порога)", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const ctx = Array.from({ length: 5 }, (_, i) => `const c${i} = ${i};`).join(
    "\n",
  );
  const added20 = Array.from(
    { length: 20 },
    (_, i) => `const n${i} = ${i};`,
  ).join("\n");
  const tp = writeTranscript(dir, [
    asstEditDelta(path.join(dir, "src/foo.ts"), ctx, ctx + "\n" + added20),
    asstEdit(path.join(dir, "src/foo.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
});

test("triggerN: дельта 19 добавленных строк → НЕ блокирует (флип порога)", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", `it('empty', () => {});`);
  const ctx = Array.from({ length: 5 }, (_, i) => `const c${i} = ${i};`).join(
    "\n",
  );
  const added19 = Array.from(
    { length: 19 },
    (_, i) => `const n${i} = ${i};`,
  ).join("\n");
  const tp = writeTranscript(dir, [
    asstEditDelta(path.join(dir, "src/foo.ts"), ctx, ctx + "\n" + added19),
    asstEdit(path.join(dir, "src/foo.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("triggerN: security-sensitive путь активирует N даже на мелкой правке", () => {
  const dir = tmp();
  writeFile(dir, "src/auth_helper.ts", "x");
  writeFile(dir, "src/auth_helper.test.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEditWith(path.join(dir, "src/auth_helper.ts"), "const a = 1;"),
    asstEdit(path.join(dir, "src/auth_helper.test.ts")),
    asstBash("npx vitest --run --changed"),
    asstText(
      SUCCESS + " " + EDGE_CASES_BLOCK("src/auth_helper.test.ts", "empty"),
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
});

test("triggerN: блок с 2 гипотезами (< минимума) → block с validCount", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const block =
    "<premortem>\n" +
    "sendMessage: text >4096 → 400 MESSAGE_TOO_LONG → чанковать\n" +
    "рассылка в цикле → 429 rate limit → уважать retry_after\n" +
    "</premortem>";
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        block,
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
  assert.match(JSON.parse(r.stdout).reason, /валидных гипотез: 2/);
});

test("triggerN: generic-гипотеза без числа/идентификатора/термина → block", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const block =
    "<premortem>\n" +
    "сеть может упасть → запрос не пройдёт → обработать ошибку\n" +
    "что-то пойдёт не так → будет плохо → починим\n" +
    "вход может быть пустым → падение → добавить проверку\n" +
    "</premortem>";
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        block,
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
  assert.match(JSON.parse(r.stdout).reason, /generic-гипотеза/);
});

test("triggerN: запись без двух стрелок → block (формат)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const block =
    "<premortem>\n" +
    "sendMessage: text >4096 → 400 MESSAGE_TOO_LONG → чанковать\n" +
    "parse_mode: `*` в тексте → 400 can't parse entities → escape\n" +
    "лимит 429 на рассылку — учесть\n" +
    "</premortem>";
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        block,
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
  assert.match(JSON.parse(r.stdout).reason, /минимум два `→`/);
});

test("triggerN: пустой <premortem></premortem> → block (invalid, 0 гипотез)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " <premortem></premortem>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
  assert.match(JSON.parse(r.stdout).reason, /валидных гипотез: 0/);
});

test("triggerN: пронумерованный generic-список не проходит по цифре нумерации", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const block =
    "<premortem>\n" +
    "1. сеть может упасть → запрос не пройдёт → обработать ошибку\n" +
    "2. что-то пойдёт не так → будет плохо → починим\n" +
    "3. вход кривой → падение → добавить проверку\n" +
    "</premortem>";
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        block,
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
});

test("triggerN: кириллические гипотезы с терминами механизмов проходят", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const block =
    "<premortem>\n" +
    "вебхук приходит повторно при ретрае поставщика → повторная запись → идемпотентность по внешнему идентификатору\n" +
    "непарные кавычки в имени → отказ разметки → экранировать текст\n" +
    "две вкладки шлют одновременно → гонка записи → блокировка строки\n" +
    "</premortem>";
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        block,
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("triggerN: копипаста #-примера из reasonN не закрывает триггер", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const block =
    "<premortem>\n" +
    "# telegram sendMessage: text >4096 символов → 400 MESSAGE_TOO_LONG, отчёт потерян → чанковать по 4000\n" +
    "# parse_mode=Markdown: `*`/`_` в юзер-тексте → 400 can't parse entities → escape перед вставкой\n" +
    "# рассылка по chatIds в цикле → 429 при превышении rate limit → троттлинг + уважать retry_after\n" +
    "</premortem>";
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        block,
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
});

test("triggerN: ReDoS-регрессия — 30k незакрытых <premortem> не подвешивают hook", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const hostile = "<premortem>".repeat(30_000);
  const tp = writeTranscript(dir, [
    asstText(hostile),
    ...base,
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const t0 = Date.now();
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  const elapsed = Date.now() - t0;
  expectBlock(r.stdout, "N");
  assert.ok(elapsed < 10_000, `hook занял ${elapsed}ms на adversarial-входе`);
});

test("triggerN: ANSI-escapes в невалидной записи стрипуются из reason", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const block =
    "<premortem>\n" +
    "[2K[1Aзлая generic-строка → отказ → починим\n" +
    "ещё generic → отказ → починим\n" +
    "и ещё generic → отказ → починим\n" +
    "</premortem>";
  const tp = writeTranscript(dir, [
    ...base,
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        " " +
        block,
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "N");
  assert.ok(
    !r.stdout.includes("\\u001b") && !JSON.parse(r.stdout).reason.includes(""),
  );
});

test("triggerK: edge-записи в triage при суженном режиме =code → wrong-source block", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:applied:см. триаж</self-review>" +
        "\n<review-triage>\ncode:1:applied:src/foo.ts:42 — добавил early-return на null user\nedge:1:applied:src/foo.ts:12 — чанкование по лимиту 4096\n</review-triage>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "code",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "K");
});

test("triggerN: MAIN_SKILL_VERIFY_PREMORTEM=0 выключает N", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/foo.test.ts", "empty")),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_PREMORTEM: "0",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ: режим both + премортем включён требует edge-секцию", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n" +
        SELF_REVIEW_OK("none-found", "none-found"),
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "J");
  assert.match(JSON.parse(r.stdout).reason, /edge/);
});

test("triggerJ: edge:none-found + premortem-агент в transcript → НЕ блокирует", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstTask(
      "general-purpose",
      "premortem review",
      "премортем: top-5 гипотез, что сломается в проде, с числами и симптомами",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:none-found\nsecurity:none-found\nedge:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("triggerJ: edge-декларация без premortem-агента → block (fake-decl)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:none-found\nsecurity:none-found\nedge:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "J");
});

test("triggerJ: отравленный tool_use не роняет хук в silent exit", () => {
  // Не менять, потому что кейс закрывает класс «одна запись в транскрипте гасит
  // все триггеры»: String({toString: 1}) бросает TypeError.
  const dir = tmp();
  const base = setupReviewBase(dir);
  const poisoned = {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Task",
          input: {
            subagent_type: { toString: 1 },
            description: { toString: 1 },
            prompt: { toString: 1 },
            model: { toString: 1 },
          },
        },
      ],
    },
  };
  const tp = writeTranscript(dir, [
    ...base,
    poisoned,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:none-found\nsecurity:none-found\nedge:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "J");
});

test("triggerJ: premortem-агент на haiku → block (weak-edge-model)", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstTask(
      "general-purpose",
      "premortem review",
      "премортем: top-5 гипотез",
      "claude-haiku-4-5-20251001",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:none-found\nsecurity:none-found\nedge:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "J");
  assert.match(r.stdout, /haiku/);
});

test("triggerJ: premortem перезапущен на sonnet после haiku → блока нет", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstTask(
      "general-purpose",
      "premortem review",
      "премортем: top-5",
      "haiku",
    ),
    asstTask(
      "general-purpose",
      "premortem review",
      "премортем: top-5",
      "sonnet",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:none-found\nsecurity:none-found\nedge:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  assert.strictEqual(r.stdout.trim(), "");
});

test("triggerJ: premortem без override модели (наследование сессии) — не блок", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstTask("general-purpose", "premortem review", "премортем: top-5 гипотез"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:none-found\nsecurity:none-found\nedge:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  assert.strictEqual(r.stdout.trim(), "");
});

test("triggerJ: haiku-премортем при MAIN_SKILL_VERIFY_PREMORTEM=0 — не блок", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstTask("general-purpose", "premortem review", "премортем", "haiku"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n<self-review>code:none-found\nsecurity:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "0",
  });
  assert.strictEqual(r.stdout.trim(), "");
});

test("triggerJ: ANSI в имени модели санитизируется в reason", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstTask(
      "general-purpose",
      "premortem review",
      "премортем",
      "claude-haiku-4-5[2K[1Aevil",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:none-found\nsecurity:none-found\nedge:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectBlock(r.stdout, "J");
  const parsed = JSON.parse(r.stdout);
  assert.ok(
    !parsed.reason.includes("\x1b"),
    "reason содержит ESC после sanitize",
  );
  assert.match(parsed.reason, /haiku/, "имя модели должно эхо-иться в reason");
});

test("triggerJ: review=code + премортем включён — edge-секция НЕ требуется", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:none-found</self-review>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "code",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("triggerK: edge-источник в review-triage валиден", () => {
  const dir = tmp();
  const base = setupReviewBase(dir);
  const tp = writeTranscript(dir, [
    ...base,
    asstTask("superpowers:code-reviewer", "review", "code review please"),
    asstTask(
      "general-purpose",
      "security review",
      "security review per OWASP, injection, auth bypass",
    ),
    asstTask(
      "general-purpose",
      "premortem review",
      "premortem: top-5 гипотез, что сломается в проде",
    ),
    asstText(
      SUCCESS +
        " " +
        EDGE_CASES_BLOCK("src/foo.test.ts", "empty") +
        "\n" +
        PREMORTEM_OK +
        "\n<self-review>code:none-found\nsecurity:none-found\nedge:applied:см. триаж</self-review>" +
        "\n<review-triage>\nedge:1:applied:src/foo.ts:12 — добавил чанкование текста по лимиту 4096\n</review-triage>",
    ),
  ]);
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_REVIEW: "both",
    MAIN_SKILL_VERIFY_PREMORTEM: "1",
  });
  expectNoBlock(r.stdout);
});

test("hardening: transcript_path не существует → silent exit", () => {
  const dir = tmp();
  const r = runHook(path.join(dir, "no-such.jsonl"), {
    CLAUDE_PROJECT_DIR: dir,
  });
  expectNoBlock(r.stdout);
});

test("hardening: transcript_path указывает на директорию → silent exit", () => {
  const dir = tmp();
  const r = runHook(dir, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("hardening: transcript > MAX_TRANSCRIPT_BYTES → silent exit", () => {
  const dir = tmp();
  const tp = path.join(dir, "big.jsonl");
  const fd = fs.openSync(tp, "w");
  const chunk = Buffer.alloc(1024 * 1024, "x");
  for (let i = 0; i < 51; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("hardening: ANSI escapes в file_path strip-аются из reason", () => {
  const dir = tmp();
  // Не менять, потому что файл создаётся реально: несуществующий путь отсеётся
  // в existsInsideRepo раньше, и кейс перестанет проверять strip.
  const malicious = "src/\x1b[2K\x1b[1Aevil.ts";
  writeFile(dir, malicious, "x");
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, malicious)),
    asstText("готово"),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "D");
  const parsed = JSON.parse(r.stdout);
  assert.ok(
    !parsed.reason.includes("\x1b"),
    "reason содержит ESC после sanitize",
  );
  const sanitizedCheck = parsed.reason.replace(/\n/g, "");
  assert.ok(
    !/[\x00-\x1f\x7f]/.test(sanitizedCheck),
    "reason содержит control-chars кроме \\n",
  );
});

function asstEditWith(file_path, new_string) {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Edit",
          input: { file_path, new_string },
        },
      ],
    },
  };
}

function asstWriteWith(file_path, content) {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Write",
          input: { file_path, content },
        },
      ],
    },
  };
}

function runHookWithDeps(transcript_path, env = {}) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ transcript_path }),
    encoding: "utf8",
    env: {
      ...process.env,
      MAIN_SKILL_VERIFY_TAIL_WAIT_MS: "0",
      MAIN_SKILL_VERIFY_LINT: "0",
      MAIN_SKILL_VERIFY_REVIEW: "0",
      CLAUDE_PROJECT_DIR:
        env.CLAUDE_PROJECT_DIR || path.dirname(transcript_path),
      ...env,
    },
    timeout: 15_000,
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

test("L: блок при добавлении npm dep без lookup", () => {
  const dir = tmp();
  const pkgPath = path.join(dir, "package.json");
  fs.writeFileSync(
    pkgPath,
    JSON.stringify({ name: "x", version: "1.0.0" }, null, 2),
  );
  const tp = writeTranscript(dir, [
    asstEditWith(pkgPath, `"react": "^18.0.0"`),
    asstBash("curl http://localhost:3000/"),
    asstText(
      "готово.\n\n<edge-cases>\nempty:N/A:текстовая правка\nboundary:N/A:n/a\nconcurrency:N/A:n/a\nexternal_failure:N/A:n/a\npermission:N/A:n/a\nmalformed_input:N/A:n/a\ndeleted_resource:N/A:n/a\n</edge-cases>",
    ),
  ]);
  const r = runHookWithDeps(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "L");
  const parsed = JSON.parse(r.stdout);
  assert.match(parsed.reason, /react@\^18\.0\.0/);
  assert.match(parsed.reason, /npm view <pkg> version/);
});

test("L: пропускает при наличии npm view <pkg>", () => {
  const dir = tmp();
  const pkgPath = path.join(dir, "package.json");
  fs.writeFileSync(
    pkgPath,
    JSON.stringify({ name: "x", version: "1.0.0" }, null, 2),
  );
  const tp = writeTranscript(dir, [
    asstBash("npm view react version"),
    asstEditWith(pkgPath, `"react": "^18.0.0"`),
    asstBash("curl http://localhost:3000/"),
    asstText(
      "готово.\n\n<edge-cases>\nempty:N/A:n\nboundary:N/A:n\nconcurrency:N/A:n\nexternal_failure:N/A:n\npermission:N/A:n\nmalformed_input:N/A:n\ndeleted_resource:N/A:n\n</edge-cases>",
    ),
  ]);
  const r = runHookWithDeps(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("L: блок при FROM node:18 в Dockerfile без lookup", () => {
  const dir = tmp();
  const dockerPath = path.join(dir, "Dockerfile");
  fs.writeFileSync(dockerPath, "FROM scratch\n");
  const tp = writeTranscript(dir, [
    asstWriteWith(dockerPath, "FROM node:18-alpine\nWORKDIR /app\n"),
    asstBash("docker build ."),
    asstText(
      "готово.\n\n<edge-cases>\nempty:N/A:n\nboundary:N/A:n\nconcurrency:N/A:n\nexternal_failure:N/A:n\npermission:N/A:n\nmalformed_input:N/A:n\ndeleted_resource:N/A:n\n</edge-cases>",
    ),
  ]);
  const r = runHookWithDeps(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "L");
  const parsed = JSON.parse(r.stdout);
  assert.match(parsed.reason, /node@18-alpine/);
});

test("L: пропускает Dockerfile FROM node:18 если был fetch endoflife.date/api/nodejs", () => {
  const dir = tmp();
  const dockerPath = path.join(dir, "Dockerfile");
  fs.writeFileSync(dockerPath, "FROM scratch\n");
  const tp = writeTranscript(dir, [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "WebFetch",
            input: {
              url: "https://endoflife.date/api/nodejs.json",
              prompt: "latest LTS",
            },
          },
        ],
      },
    },
    asstWriteWith(dockerPath, "FROM node:18-alpine\n"),
    asstBash("docker build ."),
    asstText(
      "готово.\n\n<edge-cases>\nempty:N/A:n\nboundary:N/A:n\nconcurrency:N/A:n\nexternal_failure:N/A:n\npermission:N/A:n\nmalformed_input:N/A:n\ndeleted_resource:N/A:n\n</edge-cases>",
    ),
  ]);
  const r = runHookWithDeps(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("L: блок при actions/checkout@v3 в workflow без gh api", () => {
  const dir = tmp();
  const wfPath = path.join(dir, ".github/workflows/ci.yml");
  fs.mkdirSync(path.dirname(wfPath), { recursive: true });
  fs.writeFileSync(wfPath, "name: CI\non: [push]\n");
  const tp = writeTranscript(dir, [
    asstWriteWith(
      wfPath,
      `name: CI\non: [push]\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v3\n`,
    ),
    asstBash("curl http://localhost:3000/"),
    asstText(
      "готово.\n\n<edge-cases>\nempty:N/A:n\nboundary:N/A:n\nconcurrency:N/A:n\nexternal_failure:N/A:n\npermission:N/A:n\nmalformed_input:N/A:n\ndeleted_resource:N/A:n\n</edge-cases>",
    ),
  ]);
  const r = runHookWithDeps(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "L");
  assert.match(JSON.parse(r.stdout).reason, /actions\/checkout/);
});

test("L: latest / * версии не блокируют", () => {
  const dir = tmp();
  const pkgPath = path.join(dir, "package.json");
  fs.writeFileSync(pkgPath, JSON.stringify({ name: "x" }, null, 2));
  const tp = writeTranscript(dir, [
    asstEditWith(pkgPath, `"react": "latest"`),
    asstBash("curl http://localhost:3000/"),
    asstText(
      "готово.\n\n<edge-cases>\nempty:N/A:n\nboundary:N/A:n\nconcurrency:N/A:n\nexternal_failure:N/A:n\npermission:N/A:n\nmalformed_input:N/A:n\ndeleted_resource:N/A:n\n</edge-cases>",
    ),
  ]);
  const r = runHookWithDeps(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("L: opt-out MAIN_SKILL_VERIFY_DEPS=0 пропускает", () => {
  const dir = tmp();
  const pkgPath = path.join(dir, "package.json");
  fs.writeFileSync(pkgPath, JSON.stringify({ name: "x" }, null, 2));
  const tp = writeTranscript(dir, [
    asstEditWith(pkgPath, `"react": "^18.0.0"`),
    asstBash("curl http://localhost:3000/"),
    asstText(
      "готово.\n\n<edge-cases>\nempty:N/A:n\nboundary:N/A:n\nconcurrency:N/A:n\nexternal_failure:N/A:n\npermission:N/A:n\nmalformed_input:N/A:n\ndeleted_resource:N/A:n\n</edge-cases>",
    ),
  ]);
  const r = runHookWithDeps(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_DEPS: "0",
  });
  expectNoBlock(r.stdout);
});

test("L: не активируется без manifest-правки", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/foo.test.ts", "test('x', ()=>{});");
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstBash("curl http://localhost:3000/"),
    asstText(
      "готово.\n\n<edge-cases>\nempty:N/A:n\nboundary:N/A:n\nconcurrency:N/A:n\nexternal_failure:N/A:n\npermission:N/A:n\nmalformed_input:N/A:n\ndeleted_resource:N/A:n\n</edge-cases>",
    ),
  ]);
  const r = runHookWithDeps(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

function blockingDscenario() {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(
      SUCCESS + " " + EDGE_CASES_BLOCK("tests/unit/foo.test.ts", "empty"),
    ),
  ]);
  return { dir, tp };
}

test("session-disabled: env MAIN_SKILL_OFF=1 → Stop не блокирует", () => {
  const { dir, tp } = blockingDscenario();
  expectBlock(runHook(tp, { CLAUDE_PROJECT_DIR: dir }).stdout, "D");
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir, MAIN_SKILL_OFF: "1" });
  expectNoBlock(r.stdout);
});

test("session-disabled: сентинел-файл под HOME → Stop не блокирует", () => {
  const { dir, tp } = blockingDscenario();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "msv-home-"));
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", ".main-skill-off"),
    "",
  );
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir, HOME: home });
  expectNoBlock(r.stdout);
});

function raceScenario() {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  const entries = [
    asstEdit(path.join(dir, "src/foo.ts")),
    asstBash("curl -s http://localhost:3000/api/foo"),
    asstText(
      SUCCESS + " " + EDGE_CASES_BLOCK("tests/unit/foo.test.ts", "empty"),
    ),
  ];
  const tp = path.join(dir, "transcript.jsonl");
  const flushed = entries
    .slice(0, -1)
    .map((e) => JSON.stringify(e))
    .join("\n");
  fs.writeFileSync(tp, flushed);
  const tail = "\n" + JSON.stringify(entries[entries.length - 1]);
  return { dir, tp, tail };
}

test("flush-гонка: финальное сообщение дописано после старта хука → триггер всё равно виден", () => {
  const { dir, tp, tail } = raceScenario();
  const child = require("child_process").spawn(
    "node",
    [
      "-e",
      `const fs=require("fs");setTimeout(()=>fs.appendFileSync(${JSON.stringify(tp)},${JSON.stringify(tail)}),300);`,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_TAIL_WAIT_MS: "3000",
  });
  expectBlock(r.stdout, "D");
});

test("flush-гонка: без ожидания тот же транскрипт даёт молчание (регресс до фикса)", () => {
  const { dir, tp } = raceScenario();
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_TAIL_WAIT_MS: "0",
  });
  expectNoBlock(r.stdout);
});

test("flush-гонка: хвост так и не дописан → выход по бюджету, без зависания", () => {
  const { dir, tp } = raceScenario();
  const t0 = Date.now();
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_TAIL_WAIT_MS: "600",
  });
  const spent = Date.now() - t0;
  expectNoBlock(r.stdout);
  assert.ok(spent < 10_000, `хук завис: ${spent}ms`);
});

test("flush-гонка: бюджет ожидания зажат сверху и снизу", () => {
  const src = fs.readFileSync(HOOK, "utf8");
  assert.match(
    src,
    /Math\.max\(0,\s*Math\.min\(rawBudget,\s*TAIL_WAIT_MAX_MS\)\)/,
    "бюджет из env обязан зажиматься в [0, TAIL_WAIT_MAX_MS]",
  );
});

function traceLines(fp) {
  if (!fs.existsSync(fp)) return [];
  return fs
    .readFileSync(fp, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("trace: по умолчанию ничего не пишет", () => {
  const { dir, tp } = blockingDscenario();
  const trace = path.join(dir, "trace.jsonl");
  expectBlock(runHook(tp, { CLAUDE_PROJECT_DIR: dir }).stdout, "D");
  assert.ok(!fs.existsSync(trace), "trace создан без явной ручки");
});

test("trace: тихий выход по недописанному хвосту виден в файле", () => {
  const { dir, tp } = raceScenario();
  const trace = path.join(dir, "trace.jsonl");
  const r = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_TRACE: trace,
    MAIN_SKILL_VERIFY_TAIL_WAIT_MS: "200",
  });
  expectNoBlock(r.stdout);
  const recs = traceLines(trace);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].exit, "no-last-text");
  assert.strictEqual(recs[0].settled, false);
  assert.ok(typeof recs[0].waitedMs === "number");
});

test("trace: блок пишет список сработавших триггеров", () => {
  const { dir, tp } = blockingDscenario();
  const trace = path.join(dir, "trace.jsonl");
  expectBlock(
    runHook(tp, { CLAUDE_PROJECT_DIR: dir, MAIN_SKILL_VERIFY_TRACE: trace })
      .stdout,
    "D",
  );
  const recs = traceLines(trace);
  assert.strictEqual(recs[0].exit, "block");
  assert.deepStrictEqual(recs[0].fired, ["D", "F"]);
  assert.ok(recs[0].bytes > 0);
});

test("trace: анти-луп и опт-аут различимы по коду выхода", () => {
  const { dir, tp } = blockingDscenario();
  const trace = path.join(dir, "trace.jsonl");
  runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_TRACE: trace,
    MAIN_SKILL_VERIFY_CHANGES: "0",
  });
  assert.strictEqual(traceLines(trace)[0].exit, "env-off");
});

test("trace: файл больше капа не растёт", () => {
  const { dir, tp } = blockingDscenario();
  const trace = path.join(dir, "trace.jsonl");
  fs.writeFileSync(trace, "x".repeat(6 * 1024 * 1024));
  const before = fs.statSync(trace).size;
  expectBlock(
    runHook(tp, { CLAUDE_PROJECT_DIR: dir, MAIN_SKILL_VERIFY_TRACE: trace })
      .stdout,
    "D",
  );
  assert.strictEqual(fs.statSync(trace).size, before, "кап trace не соблюдён");
});

test("trace: недоступный для записи путь не ломает блокировку", () => {
  const { dir, tp } = blockingDscenario();
  const locked = path.join(dir, "locked");
  fs.mkdirSync(locked, { recursive: true });
  fs.chmodSync(locked, 0o500);
  try {
    expectBlock(
      runHook(tp, {
        CLAUDE_PROJECT_DIR: dir,
        MAIN_SKILL_VERIFY_TRACE: path.join(locked, "trace.jsonl"),
      }).stdout,
      "D",
    );
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("trace: MAIN_SKILL_VERIFY_TRACE=1 пишет под HOME/.claude", () => {
  const { dir, tp } = blockingDscenario();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "msv-trhome-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  expectBlock(
    runHook(tp, {
      CLAUDE_PROJECT_DIR: dir,
      MAIN_SKILL_VERIFY_TRACE: "1",
      HOME: home,
    }).stdout,
    "D",
  );
  const recs = traceLines(
    path.join(home, ".claude", "main-skill-verify-trace.jsonl"),
  );
  assert.strictEqual(recs[0].exit, "block");
});

test("reason-статика: reasonD/reasonG цитируют актуальные формулировки SKILL.md", () => {
  const src = fs.readFileSync(HOOK, "utf8");
  assert.ok(src.includes("Edge-case discipline"), "reasonD: живое имя секции");
  assert.ok(!src.includes("NOT enough"), "reasonD: старая цитата удалена");
  assert.ok(
    !src.includes("Linters + formatters green"),
    "reasonG: старая цитата удалена",
  );
  assert.ok(
    src.includes("зелёные линтеры + форматтеры"),
    "reasonG: новая формулировка",
  );
});
