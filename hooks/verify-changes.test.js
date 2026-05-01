// Self-tests для verify-changes.js + lib/checks.js.
// Запуск: node hooks/verify-changes.test.js
// Использует встроенный node:test (Node ≥ 18).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const checks = require("./lib/checks");

const HOOK = path.join(__dirname, "verify-changes.js");

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

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
      MAIN_SKILL_VERIFY_LINT: "0", // лайнт отдельно тестируем; в общем потоке отключаем.
      MAIN_SKILL_VERIFY_REVIEW: "0", // J/K тестируем отдельно; иначе старые тесты сломаются.
      MAIN_SKILL_VERIFY_DEPS: "0", // L тестируется отдельно; в общем потоке отключён.
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

function asstTask(subagent_type, description, prompt) {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Task",
          input: { subagent_type, description, prompt },
        },
      ],
    },
  };
}

// Edit с реальным new_string — для тестов на nonTrivialDiffLines.
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

const BIG_DIFF = Array.from(
  { length: 25 },
  (_, i) => `const x${i} = ${i};`,
).join("\n");

const SUCCESS = "готово, всё работает";
const EDGE_CASES_BLOCK = (file, name) =>
  `<edge-cases>empty:${file}:${name}; race:${file}:${name}</edge-cases>`;

// ────────────────────────────────────────────────────────────────────────────
// integration tests на verify-changes.js
// (unit-тесты на lib/checks.js — в hooks/lib/checks.test.js)
// ────────────────────────────────────────────────────────────────────────────

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

test("triggerE: controller без e2e блокируется", () => {
  const dir = tmp();
  writeFile(dir, "app/controllers/auth_controller.ts", "x");
  // парный unit-тест есть, чтобы D не сработал раньше.
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

test("triggerH: public surface (config) без doc edits блокируется", () => {
  const dir = tmp();
  writeFile(dir, ".claude-plugin/plugin.json", '{"name":"x"}');
  // plugin.json — config, D/E на него не действуют (isCodeFile=false).
  // Doc edits в сессии нет → должен сработать H. F (edge-cases) должен пройти, потому что
  // observableSrcFiles пуст → блок <edge-cases> можно опустить (не пуст — но валидируется,
  // если есть). Чтобы F не загорелся, добавим валидную декларацию (хотя observableSrcFiles
  // пуст, hook всё равно спросит про edge-cases — но не сработает приоритетно над H).
  // Точнее: H проверяется ДО F.
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
  writeFile(dir, "README.md", "# foo"); // public surface не тронут — H не должен сработать
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
  // Парный «logic»-файл с тестом — чтобы не падать на E (controller) и F (no edge-cases).
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
  // Дополнительная редактируемая пара чтобы edge-cases имел валидный test_file.
  writeFile(dir, "src/util.ts", "export class Util {}");
  writeFile(dir, "src/util.spec.ts", `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, "legacy/old_module.ts")),
    asstEdit(path.join(dir, "src/util.ts")),
    asstBash("npm test"),
    asstText(SUCCESS + " " + EDGE_CASES_BLOCK("src/util.spec.ts", "empty")),
  ]);
  // Без override — D-триггер сработает на legacy/old_module.ts.
  const blocked = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(blocked.stdout, "D");
  // С override — НЕ блокируется.
  const allowed = runHook(tp, {
    CLAUDE_PROJECT_DIR: dir,
    MAIN_SKILL_VERIFY_IGNORE_GLOBS: "**/legacy/**",
  });
  expectNoBlock(allowed.stdout);
});

test("triggerD срабатывает в monorepo, когда тест в backend/tests/unit/ есть и не находится без фикса", () => {
  // Это reverse-test: подтверждаем, что workspace-aware lookup НАХОДИТ тест.
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

// ────────────────────────────────────────────────────────────────────────────
// Триггеры J / K: self-review + review-triage
// ────────────────────────────────────────────────────────────────────────────

// Сетап минимально-валидного okay-кейса для J/K — все остальные триггеры пройдены.
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
        " <review-triage>code:1:applied:fixed</review-triage>", // applied слишком короткий reason
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
  // "off" не в allowlist → откатываемся на both → значит требуется self-review.
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
  // 1 строка observable, 50 строк docs — должно быть trivial.
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
  // 200K char строка из 'a' — worst-case для регекса /[a-z][a-zA-Z]{3,}[A-Z]\w+/
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
  // Должно завершиться в разумное время (< 5 сек). Раньше зависало > 30 сек.
  assert.ok(elapsed < 5000, `hook took ${elapsed}ms, ReDoS не защищён`);
  // 200K of 'a' — slop по тексту нет, но и tech-signal'а нет (только weak _WEAK_SIGNALS — единичный),
  // поэтому слоп-детектор не блокирует, просто длинный reason без сигналов проходит. Это OK для
  // теста — проверяем именно скорость, не семантику.
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

// ────────────────────────────────────────────────────────────────────────────
// hardening (v1.6.9): transcript size cap, isFile guard, ANSI strip
// ────────────────────────────────────────────────────────────────────────────

test("hardening: transcript_path не существует → silent exit", () => {
  const dir = tmp();
  const r = runHook(path.join(dir, "no-such.jsonl"), {
    CLAUDE_PROJECT_DIR: dir,
  });
  expectNoBlock(r.stdout);
});

test("hardening: transcript_path указывает на директорию → silent exit", () => {
  const dir = tmp();
  // dir сам — не файл; isFile()=false → silent exit
  const r = runHook(dir, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("hardening: transcript > MAX_TRANSCRIPT_BYTES → silent exit", () => {
  const dir = tmp();
  const tp = path.join(dir, "big.jsonl");
  // 51 MB — над cap-ом 50 MB. Без stat-guard хук бы прочитал всё в память.
  const fd = fs.openSync(tp, "w");
  const chunk = Buffer.alloc(1024 * 1024, "x");
  for (let i = 0; i < 51; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test("hardening: ANSI escapes в file_path strip-аются из reason", () => {
  const dir = tmp();
  // Контрольные символы в имени файла: ESC[2K (clear line), ESC[1A (cursor up).
  // Без strip эти байты дошли бы до терминала юзера.
  const malicious = "src/\x1b[2K\x1b[1Aevil.ts";
  const tp = writeTranscript(dir, [asstEdit(malicious), asstText("готово")]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, "D");
  const parsed = JSON.parse(r.stdout);
  assert.ok(
    !parsed.reason.includes("\x1b"),
    "reason содержит ESC после sanitize",
  );
  // \n остаётся легитимно (line breaks reason). Остальные control-chars — нет.
  const sanitizedCheck = parsed.reason.replace(/\n/g, "");
  assert.ok(
    !/[\x00-\x1f\x7f]/.test(sanitizedCheck),
    "reason содержит control-chars кроме \\n",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Триггер L: dep version-lookup enforcement
// ────────────────────────────────────────────────────────────────────────────

// Helper: симулирует "Edit на manifest-файл" с конкретным new_string.
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

// runHookWithDeps: тот же helper что runHook, но без MAIN_SKILL_VERIFY_DEPS=0.
function runHookWithDeps(transcript_path, env = {}) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ transcript_path }),
    encoding: "utf8",
    env: {
      ...process.env,
      MAIN_SKILL_VERIFY_LINT: "0",
      MAIN_SKILL_VERIFY_REVIEW: "0",
      // MAIN_SKILL_VERIFY_DEPS НЕ выставлен — по умолчанию active.
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
  // Имитируем сценарий: Claude добавил react в package.json без вызова npm view.
  const pkgPath = path.join(dir, "package.json");
  // Файл существует, чтобы пара test-файла не валила D раньше.
  fs.writeFileSync(
    pkgPath,
    JSON.stringify({ name: "x", version: "1.0.0" }, null, 2),
  );
  const tp = writeTranscript(dir, [
    asstEditWith(pkgPath, `"react": "^18.0.0"`),
    asstBash("curl http://localhost:3000/"), // верификация для A
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
  fs.writeFileSync(dockerPath, "FROM scratch\n"); // pre-existing
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
  // Только src-правка с парным тестом, никаких manifest-edit.
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
