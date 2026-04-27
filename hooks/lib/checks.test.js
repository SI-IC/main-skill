// Unit-tests для lib/checks.js. Запуск: node --test hooks/lib/checks.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const checks = require('./checks');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'msc-'));
}
function writeFile(dir, rel, body) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

test('isTestFile распознаёт стандартные конвенции', () => {
  assert.ok(checks.isTestFile('src/foo.test.ts'));
  assert.ok(checks.isTestFile('src/foo.spec.js'));
  assert.ok(checks.isTestFile('src/__tests__/foo.ts'));
  assert.ok(checks.isTestFile('tests/unit/foo.ts'));
  assert.ok(checks.isTestFile('tests/test_foo.py'));
  assert.ok(checks.isTestFile('foo_test.go'));
  assert.ok(checks.isTestFile('e2e/login.e2e.ts'));
  assert.ok(!checks.isTestFile('src/foo.ts'));
  assert.ok(!checks.isTestFile('src/controllers/auth.ts'));
});

test('isCodeFile отсеивает конфиги/ассеты', () => {
  assert.ok(checks.isCodeFile('src/foo.ts'));
  assert.ok(checks.isCodeFile('main.py'));
  assert.ok(checks.isCodeFile('cli.go'));
  assert.ok(checks.isCodeFile('app/styles.css'));
  assert.ok(!checks.isCodeFile('plugin.json'));
  assert.ok(!checks.isCodeFile('config.yaml'));
  assert.ok(!checks.isCodeFile('Dockerfile'));
  assert.ok(!checks.isCodeFile('logo.png'));
});

test('isControllerOrRoute распознаёт endpoints', () => {
  assert.ok(checks.isControllerOrRoute('app/controllers/auth_controller.ts'));
  assert.ok(checks.isControllerOrRoute('src/routes/users.ts'));
  assert.ok(checks.isControllerOrRoute('app/api/auth/route.ts'));
  assert.ok(checks.isControllerOrRoute('pages/api/login.ts'));
  assert.ok(checks.isControllerOrRoute('src/UserController.ts'));
  assert.ok(!checks.isControllerOrRoute('src/services/auth.ts'));
  assert.ok(!checks.isControllerOrRoute('src/controllers/auth_controller.test.ts'));
});

test('isPublicSurface — manifest, SKILL.md, CLI', () => {
  assert.ok(checks.isPublicSurface('.claude-plugin/plugin.json'));
  assert.ok(checks.isPublicSurface('skills/foo/SKILL.md'));
  assert.ok(checks.isPublicSurface('bin/cli.js'));
  assert.ok(!checks.isPublicSurface('src/internal/util.ts'));
});

test('findPairedTestFile находит парный тест на диске', () => {
  const dir = tmp();
  writeFile(dir, 'src/foo.ts', 'export const x = 1;');
  writeFile(dir, 'src/foo.test.ts', 'test("x", () => {})');
  const found = checks.findPairedTestFile('src/foo.ts', dir);
  assert.strictEqual(found, path.join('src', 'foo.test.ts'));
});

test('findPairedTestFile возвращает null если нет', () => {
  const dir = tmp();
  writeFile(dir, 'src/foo.ts', 'x');
  assert.strictEqual(checks.findPairedTestFile('src/foo.ts', dir), null);
});

test('findPairedTestFile считает session-edit как валидный парный', () => {
  const dir = tmp();
  writeFile(dir, 'src/foo.ts', 'x');
  const sessionFiles = new Set([path.join(dir, 'src/foo.test.ts')]);
  const found = checks.findPairedTestFile('src/foo.ts', dir, sessionFiles);
  assert.ok(found);
});

test('findE2eFile находит functional-парный', () => {
  const dir = tmp();
  writeFile(dir, 'app/controllers/auth_controller.ts', 'x');
  writeFile(dir, 'tests/functional/auth.spec.ts', 'test("login", () => {})');
  const found = checks.findE2eFile('app/controllers/auth_controller.ts', dir);
  assert.ok(found);
});

test('parseEdgeCasesBlock парсит однострочный формат', () => {
  const t = '<edge-cases>empty:tests/auth.test.ts:test_empty; race:tests/auth.test.ts:test_race</edge-cases>';
  const r = checks.parseEdgeCasesBlock(t);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.entries[0].name, 'empty');
  assert.strictEqual(r.entries[0].test_file, 'tests/auth.test.ts');
  assert.strictEqual(r.entries[0].test_name, 'test_empty');
});

test('parseEdgeCasesBlock — нет блока → null', () => {
  assert.strictEqual(checks.parseEdgeCasesBlock('просто текст без блока'), null);
});

test('validateEdgeCases — test_name найден в файле', () => {
  const dir = tmp();
  writeFile(dir, 'tests/auth.test.ts', `it('handles empty password', () => {});\nit('handles concurrent_login', () => {});`);
  const parsed = checks.parseEdgeCasesBlock(
    '<edge-cases>empty:tests/auth.test.ts:empty password; race:tests/auth.test.ts:concurrent_login</edge-cases>',
  );
  const v = checks.validateEdgeCases(parsed, dir);
  assert.ok(v.every((x) => x.ok));
});

test('validateEdgeCases — test_name отсутствует → не ok', () => {
  const dir = tmp();
  writeFile(dir, 'tests/auth.test.ts', `it('happy path', () => {});`);
  const parsed = checks.parseEdgeCasesBlock(
    '<edge-cases>empty:tests/auth.test.ts:test_empty</edge-cases>',
  );
  const v = checks.validateEdgeCases(parsed, dir);
  assert.strictEqual(v[0].ok, false);
});

test('validateEdgeCases — test_file не существует → не ok', () => {
  const dir = tmp();
  const parsed = checks.parseEdgeCasesBlock(
    '<edge-cases>empty:tests/missing.test.ts:test_empty</edge-cases>',
  );
  const v = checks.validateEdgeCases(parsed, dir);
  assert.strictEqual(v[0].ok, false);
  assert.match(v[0].reason, /не найден/);
});

test('runLint возвращает null если ничего не настроено', () => {
  const dir = tmp();
  const r = checks.runLint(dir);
  assert.strictEqual(r, null);
});
