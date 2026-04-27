// Self-tests для verify-changes.js + lib/checks.js.
// Запуск: node hooks/verify-changes.test.js
// Использует встроенный node:test (Node ≥ 18).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const checks = require('./lib/checks');

const HOOK = path.join(__dirname, 'verify-changes.js');

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'msv-'));
}

function writeFile(dir, rel, body) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

function writeTranscript(dir, entries) {
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n'));
  return p;
}

function runHook(transcript_path, env = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ transcript_path }),
    encoding: 'utf8',
    env: {
      ...process.env,
      MAIN_SKILL_VERIFY_LINT: '0', // лайнт отдельно тестируем; в общем потоке отключаем.
      CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR || path.dirname(transcript_path),
      ...env,
    },
    timeout: 15_000,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function expectBlock(stdout, expectedTrigger) {
  const parsed = JSON.parse(stdout || '{}');
  assert.strictEqual(parsed.decision, 'block', `expected block, got stdout: ${stdout}`);
  if (expectedTrigger) {
    assert.match(
      parsed.reason,
      new RegExp(`триггер ${expectedTrigger}\\b`),
      `expected trigger ${expectedTrigger}, got: ${parsed.reason}`,
    );
  }
}

function expectNoBlock(stdout) {
  assert.strictEqual(stdout.trim(), '', `expected no block, got: ${stdout}`);
}

function asstEdit(file_path, name = 'Edit') {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: { file_path } }] },
  };
}

function asstBash(command) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  };
}

function asstText(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

const SUCCESS = 'готово, всё работает';
const EDGE_CASES_BLOCK = (file, name) =>
  `<edge-cases>empty:${file}:${name}; race:${file}:${name}</edge-cases>`;

// ────────────────────────────────────────────────────────────────────────────
// integration tests на verify-changes.js
// (unit-тесты на lib/checks.js — в hooks/lib/checks.test.js)
// ────────────────────────────────────────────────────────────────────────────

test('triggerC: делегирование shell блокируется', () => {
  const dir = tmp();
  const tp = writeTranscript(dir, [
    asstBash('ls'),
    asstText('Запусти у себя в терминале: ```\nnpm test\n```'),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, 'C');
});

test('triggerB: дисклеймер без попыток разведки блокируется', () => {
  const dir = tmp();
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, 'src/foo.ts')),
    asstText('Фикс применён. End-to-end не проверил, проверь вручную.'),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, 'B');
});

test('triggerD: src без парного теста блокируется', () => {
  const dir = tmp();
  writeFile(dir, 'src/foo.ts', 'x');
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, 'src/foo.ts')),
    asstBash('curl -s http://localhost:3000/api/foo'),
    asstText(SUCCESS + ' ' + EDGE_CASES_BLOCK('tests/unit/foo.test.ts', 'empty')),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, 'D');
});

test('triggerE: controller без e2e блокируется', () => {
  const dir = tmp();
  writeFile(dir, 'app/controllers/auth_controller.ts', 'x');
  // парный unit-тест есть, чтобы D не сработал раньше.
  writeFile(dir, 'app/controllers/auth_controller.test.ts', `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, 'app/controllers/auth_controller.ts')),
    asstBash('curl -s http://localhost:3000/login'),
    asstText(SUCCESS + ' ' + EDGE_CASES_BLOCK('app/controllers/auth_controller.test.ts', 'empty')),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, 'E');
});

test('triggerF: нет блока <edge-cases> блокируется', () => {
  const dir = tmp();
  writeFile(dir, 'src/foo.ts', 'x');
  writeFile(dir, 'src/foo.test.ts', `it('empty', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, 'src/foo.ts')),
    asstBash('curl -s http://localhost:3000/api/foo'),
    asstText(SUCCESS + ' (без блока edge-cases)'),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, 'F');
});

test('triggerF: невалидная декларация блокируется', () => {
  const dir = tmp();
  writeFile(dir, 'src/foo.ts', 'x');
  writeFile(dir, 'src/foo.test.ts', `it('happy', () => {});`);
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, 'src/foo.ts')),
    asstBash('curl -s http://localhost:3000/api/foo'),
    asstText(SUCCESS + ' <edge-cases>empty:src/foo.test.ts:nonexistent_test_name</edge-cases>'),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, 'F');
});

test('triggerH: public surface (config) без doc edits блокируется', () => {
  const dir = tmp();
  writeFile(dir, '.claude-plugin/plugin.json', '{"name":"x"}');
  // plugin.json — config, D/E на него не действуют (isCodeFile=false).
  // Doc edits в сессии нет → должен сработать H. F (edge-cases) должен пройти, потому что
  // observableSrcFiles пуст → блок <edge-cases> можно опустить (не пуст — но валидируется,
  // если есть). Чтобы F не загорелся, добавим валидную декларацию (хотя observableSrcFiles
  // пуст, hook всё равно спросит про edge-cases — но не сработает приоритетно над H).
  // Точнее: H проверяется ДО F.
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, '.claude-plugin/plugin.json')),
    asstBash('curl -s http://localhost:3000/api/foo'),
    asstText(SUCCESS),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectBlock(r.stdout, 'H');
});

test('happy path: edits + verify + tests + edge-cases → НЕ блокируется', () => {
  const dir = tmp();
  writeFile(dir, 'src/foo.ts', 'x');
  writeFile(dir, 'src/foo.test.ts', `it('empty', () => {});\nit('race_concurrent', () => {});`);
  writeFile(dir, 'README.md', '# foo'); // public surface не тронут — H не должен сработать
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, 'src/foo.ts')),
    asstEdit(path.join(dir, 'src/foo.test.ts')),
    asstBash('npx vitest --run --changed'),
    asstBash('curl -s http://localhost:3000/api/foo'),
    asstText(SUCCESS + ' <edge-cases>empty:src/foo.test.ts:empty; race:src/foo.test.ts:race_concurrent</edge-cases>'),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test('anti-loop: повторный success после блока не триггерит снова', () => {
  const dir = tmp();
  writeFile(dir, 'src/foo.ts', 'x');
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, 'src/foo.ts')),
    asstText(SUCCESS),
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: '[main-skill:verify-changes] Stop заблокирован',
          },
        ],
      },
    },
    asstText(SUCCESS),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});

test('опт-аут MAIN_SKILL_VERIFY_CHANGES=0 отключает все триггеры', () => {
  const dir = tmp();
  writeFile(dir, 'src/foo.ts', 'x');
  const tp = writeTranscript(dir, [asstEdit(path.join(dir, 'src/foo.ts')), asstText(SUCCESS)]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir, MAIN_SKILL_VERIFY_CHANGES: '0' });
  expectNoBlock(r.stdout);
});

test('docs-only edit (только *.md) не триггерит D/E/F (docs не observable src)', () => {
  const dir = tmp();
  const tp = writeTranscript(dir, [
    asstEdit(path.join(dir, 'README.md')),
    asstText(SUCCESS),
  ]);
  const r = runHook(tp, { CLAUDE_PROJECT_DIR: dir });
  expectNoBlock(r.stdout);
});
