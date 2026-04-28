// Unit-tests для auto-format.js. Запуск: node --test hooks/auto-format.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const af = require('./auto-format');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'msaf-'));
}
function writeFile(dir, rel, body = '') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

// ─── languageFor ────────────────────────────────────────────────────────────

test('languageFor распознаёт основные расширения', () => {
  assert.equal(af.languageFor('src/app.ts'), 'prettier');
  assert.equal(af.languageFor('src/app.tsx'), 'prettier');
  assert.equal(af.languageFor('app/page.svelte'), 'prettier');
  assert.equal(af.languageFor('schema.graphql'), 'prettier');
  assert.equal(af.languageFor('app/styles.scss'), 'prettier');
  assert.equal(af.languageFor('docs/readme.md'), 'prettier');
  assert.equal(af.languageFor('main.py'), 'ruff');
  assert.equal(af.languageFor('typings.pyi'), 'ruff');
  assert.equal(af.languageFor('cli/main.go'), 'gofmt');
  assert.equal(af.languageFor('src/lib.rs'), 'rustfmt');
  assert.equal(af.languageFor('app.cpp'), 'clang');
  assert.equal(af.languageFor('header.hpp'), 'clang');
  assert.equal(af.languageFor('main.m'), 'clang');
});

test('languageFor отсекает lock-файлы и минифицированные', () => {
  assert.equal(af.languageFor('package-lock.json'), null);
  assert.equal(af.languageFor('pnpm-lock.yaml'), null);
  assert.equal(af.languageFor('yarn.lock'), null);
  assert.equal(af.languageFor('bun.lockb'), null);
  assert.equal(af.languageFor('Cargo.lock'), null);
  assert.equal(af.languageFor('poetry.lock'), null);
  assert.equal(af.languageFor('uv.lock'), null);
  assert.equal(af.languageFor('go.sum'), null);
  assert.equal(af.languageFor('foo/bar/jquery.min.js'), null);
  assert.equal(af.languageFor('app.min.css'), null);
});

test('languageFor возвращает null для неизвестных расширений', () => {
  assert.equal(af.languageFor('binary.bin'), null);
  assert.equal(af.languageFor('archive.zip'), null);
  assert.equal(af.languageFor('image.png'), null);
  assert.equal(af.languageFor('LICENSE'), null);
  assert.equal(af.languageFor('Dockerfile'), null);
});

// ─── findLocalBin / findLocalPyBin ───────────────────────────────────────────

test('findLocalBin находит prettier через walk-up', () => {
  const root = tmp();
  const bin = writeFile(root, 'node_modules/.bin/prettier', '#!/bin/sh\n');
  fs.chmodSync(bin, 0o755);
  const start = path.join(root, 'packages', 'app', 'src');
  fs.mkdirSync(start, { recursive: true });

  const found = af.findLocalBin(start, 'prettier');
  assert.equal(found, bin);
});

test('findLocalBin возвращает null если не найден', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const found = af.findLocalBin(path.join(root, 'src'), 'prettier');
  assert.equal(found, null);
});

test('findLocalPyBin находит ruff в .venv/bin', () => {
  const root = tmp();
  const bin = writeFile(root, '.venv/bin/ruff', '#!/bin/sh\n');
  fs.chmodSync(bin, 0o755);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const found = af.findLocalPyBin(path.join(root, 'src'), 'ruff');
  assert.equal(found, bin);
});

test('findLocalPyBin поддерживает venv (без точки)', () => {
  const root = tmp();
  const bin = writeFile(root, 'venv/bin/black', '#!/bin/sh\n');
  fs.chmodSync(bin, 0o755);
  const found = af.findLocalPyBin(root, 'black');
  assert.equal(found, bin);
});

// ─── findUp ──────────────────────────────────────────────────────────────────

test('findUp находит lockfile в родительской директории', () => {
  const root = tmp();
  writeFile(root, 'pnpm-lock.yaml', '');
  const deep = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });

  const hit = af.findUp(deep, ['pnpm-lock.yaml']);
  assert.ok(hit);
  assert.equal(hit.file, 'pnpm-lock.yaml');
  assert.equal(hit.dir, root);
});

test('findUp возвращает null если файл не существует', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  const hit = af.findUp(path.join(root, 'a'), ['какой-нибудь-несуществующий.lock']);
  assert.equal(hit, null);
});

// ─── prettierInstaller ──────────────────────────────────────────────────────

test('prettierInstaller: bun.lockb → bun', () => {
  const root = tmp();
  writeFile(root, 'bun.lockb', '');
  assert.equal(af.prettierInstaller(path.join(root, 'app.ts')), 'bun add -d prettier');
});

test('prettierInstaller: pnpm-lock.yaml → pnpm', () => {
  const root = tmp();
  writeFile(root, 'pnpm-lock.yaml', '');
  assert.equal(af.prettierInstaller(path.join(root, 'src/app.ts')), 'pnpm add -D prettier');
});

test('prettierInstaller: yarn.lock → yarn', () => {
  const root = tmp();
  writeFile(root, 'yarn.lock', '');
  assert.equal(af.prettierInstaller(path.join(root, 'app.ts')), 'yarn add -D prettier');
});

test('prettierInstaller: дефолт → npm', () => {
  const root = tmp();
  writeFile(root, 'package.json', '{}');
  assert.equal(af.prettierInstaller(path.join(root, 'app.ts')), 'npm install -D prettier');
});

test('prettierInstaller: bun имеет приоритет над pnpm/yarn', () => {
  const root = tmp();
  writeFile(root, 'bun.lockb', '');
  writeFile(root, 'pnpm-lock.yaml', '');
  writeFile(root, 'yarn.lock', '');
  assert.equal(af.prettierInstaller(path.join(root, 'app.ts')), 'bun add -d prettier');
});

test('prettierInstaller: bun.lock (новый формат Bun 1.1+) → bun', () => {
  const root = tmp();
  writeFile(root, 'bun.lock', '');
  assert.equal(af.prettierInstaller(path.join(root, 'app.ts')), 'bun add -d prettier');
});

// ─── pythonInstaller ────────────────────────────────────────────────────────

test('pythonInstaller: uv.lock → uv', () => {
  const root = tmp();
  writeFile(root, 'uv.lock', '');
  assert.equal(af.pythonInstaller(path.join(root, 'main.py')), 'uv add --dev ruff');
});

test('pythonInstaller: poetry.lock → poetry', () => {
  const root = tmp();
  writeFile(root, 'poetry.lock', '');
  assert.equal(af.pythonInstaller(path.join(root, 'main.py')), 'poetry add --group dev ruff');
});

test('pythonInstaller: Pipfile → pipenv', () => {
  const root = tmp();
  writeFile(root, 'Pipfile', '');
  assert.equal(af.pythonInstaller(path.join(root, 'main.py')), 'pipenv install --dev ruff');
});

test('pythonInstaller: дефолт → pip', () => {
  const root = tmp();
  writeFile(root, 'pyproject.toml', '');
  assert.equal(af.pythonInstaller(path.join(root, 'main.py')), 'pip install ruff');
});

// ─── runFormatter ────────────────────────────────────────────────────────────

test('runFormatter: ENOENT → kind:missing с install msg', () => {
  const r = af.runFormatter({
    bin: '/definitely/does/not/exist/xyz123',
    args: ['/tmp/foo'],
    cwd: '/tmp',
    toolName: 'prettier',
    installer: () => 'pnpm add -D prettier',
  });
  assert.equal(r.kind, 'missing');
  assert.match(r.message, /prettier/);
  assert.match(r.message, /pnpm add -D prettier/);
  assert.match(r.message, /не отформатирован/i);
});

test('runFormatter: ENOENT с suppressMissing → kind:missing без message', () => {
  const r = af.runFormatter({
    bin: '/definitely/does/not/exist/xyz123',
    args: ['/tmp/foo'],
    cwd: '/tmp',
    toolName: 'ruff',
    suppressMissing: true,
  });
  assert.equal(r.kind, 'missing');
  assert.equal(r.message, undefined);
});

test('runFormatter: success exit 0 → kind:success', () => {
  // /usr/bin/true присутствует на macOS/Linux и делает exit 0.
  const r = af.runFormatter({
    bin: 'true',
    args: ['/tmp/foo'],
    cwd: '/tmp',
    toolName: 'fake',
  });
  assert.equal(r.kind, 'success');
});

test('runFormatter: exit ≠ 0 → kind:failed со stderr', () => {
  const r = af.runFormatter({
    bin: 'false',
    args: ['/tmp/foo'],
    cwd: '/tmp',
    file: '/tmp/foo',
    toolName: 'fake',
  });
  assert.equal(r.kind, 'failed');
  assert.match(r.message, /fake/);
  assert.match(r.message, /<formatter-stderr>/);
  assert.match(r.message, /Не правь форматирование вручную/);
});

test('runFormatter: timeout → kind:failed', () => {
  const r = af.runFormatter({
    bin: 'sleep',
    args: ['10'],
    cwd: '/tmp',
    file: '/tmp/foo',
    toolName: 'fake',
    timeoutMs: 200,
  });
  assert.equal(r.kind, 'failed');
  assert.match(r.message, /превысил timeout/);
});

test('sanitizeStderr: ANSI, control chars, длинные строки', () => {
  const raw = '\x1b[31mERROR\x1b[0m\nlong'.padEnd(500, 'x') + '\nline3\x00with-null';
  const out = af.sanitizeStderr(raw, 8, 200);
  assert.ok(!/\x1b/.test(out), 'ANSI escape должен быть удалён');
  assert.ok(!/\x00/.test(out), 'NULL byte должен быть удалён');
  const lines = out.split('\n');
  for (const l of lines) assert.ok(l.length <= 200, 'каждая строка ≤200 chars');
});

test('sanitizeStderr: ≤8 строк', () => {
  const raw = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
  const out = af.sanitizeStderr(raw, 8, 200);
  assert.equal(out.split('\n').length, 8);
});

// ─── main (integration) ──────────────────────────────────────────────────────

function runMain(payload, env = {}) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(__dirname, 'auto-format.js')],
    {
      input: JSON.stringify(payload),
      env: { ...process.env, ...env, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return stdout;
}

test('main: tool_name не Edit/Write → no-op', () => {
  const out = runMain({ tool_name: 'Read', tool_input: { file_path: '/tmp/x.ts' } });
  assert.equal(out, '');
});

test('main: file не существует → no-op', () => {
  const out = runMain({
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/definitely-does-not-exist-123.ts' },
  });
  assert.equal(out, '');
});

test('main: lock-файл → no-op', () => {
  const root = tmp();
  const lock = writeFile(root, 'pnpm-lock.yaml', 'lockfileVersion: 6\n');
  const out = runMain({ tool_name: 'Edit', tool_input: { file_path: lock } });
  assert.equal(out, '');
});

test('main: файл в node_modules → no-op', () => {
  const root = tmp();
  const f = writeFile(root, 'node_modules/foo/bar.ts', 'export {}');
  const out = runMain({ tool_name: 'Edit', tool_input: { file_path: f } });
  assert.equal(out, '');
});

test('main: неизвестное расширение → no-op', () => {
  const root = tmp();
  const f = writeFile(root, 'data.bin', 'binary');
  const out = runMain({ tool_name: 'Edit', tool_input: { file_path: f } });
  assert.equal(out, '');
});

test('main: .ts файл без prettier → additionalContext с install-командой', () => {
  const root = tmp();
  writeFile(root, 'pnpm-lock.yaml', '');
  const f = writeFile(root, 'src/app.ts', 'export const a = 1;\n');

  const out = runMain({ tool_name: 'Edit', tool_input: { file_path: f } });
  assert.ok(out.length > 0, 'should produce output when prettier is missing');

  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /prettier/);
  assert.match(ctx, /pnpm add -D prettier/);
});

test('main: .py файл без ruff/black → additionalContext с pip install', () => {
  const root = tmp();
  writeFile(root, 'pyproject.toml', '');
  const f = writeFile(root, 'src/main.py', 'x = 1\n');

  const out = runMain({ tool_name: 'Edit', tool_input: { file_path: f } });
  const parsed = JSON.parse(out);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /ruff or black/);
  assert.match(ctx, /pip install ruff/);
});

test('main: malformed JSON → no-op (exit 0)', () => {
  const stdout = execFileSync(
    process.execPath,
    [path.join(__dirname, 'auto-format.js')],
    {
      input: 'not json',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  assert.equal(stdout, '');
});

test('main: empty stdin → no-op', () => {
  const stdout = execFileSync(
    process.execPath,
    [path.join(__dirname, 'auto-format.js')],
    {
      input: '',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  assert.equal(stdout, '');
});

test('main: notebook_path для NotebookEdit → обрабатывается', () => {
  const root = tmp();
  // notebook расширение .ipynb — не наш язык; должно быть no-op
  const f = writeFile(root, 'nb.ipynb', '{}');
  const out = runMain({ tool_name: 'NotebookEdit', tool_input: { notebook_path: f } });
  assert.equal(out, '');
});

// ─── Security regression tests ───────────────────────────────────────────────

test('main: relative file_path → no-op (Claude Code всегда шлёт абсолют)', () => {
  const out = runMain({ tool_name: 'Edit', tool_input: { file_path: 'src/relative.ts' } });
  assert.equal(out, '');
});

test('main: symlink → no-op (защита от перезаписи цели)', () => {
  const root = tmp();
  writeFile(root, 'package.json', '{}');
  const target = writeFile(root, 'real.ts', 'export {}');
  const link = path.join(root, 'link.ts');
  fs.symlinkSync(target, link);
  const out = runMain({ tool_name: 'Edit', tool_input: { file_path: link } });
  assert.equal(out, '');
});

test('main: file_path указывает на директорию → no-op', () => {
  const root = tmp();
  writeFile(root, 'package.json', '{}');
  const subdir = path.join(root, 'subdir');
  fs.mkdirSync(subdir);
  const out = runMain({ tool_name: 'Edit', tool_input: { file_path: subdir } });
  assert.equal(out, '');
});

test('findLocalBin: walkUp не выходит за project-root marker', () => {
  // Атакующий: бинарь в evil-родителе, выше project-корня.
  const root = tmp();
  const evilBin = writeFile(root, 'node_modules/.bin/prettier', '#!/bin/sh\necho evil\n');
  fs.chmodSync(evilBin, 0o755);
  // Project с package.json внутри (project-root marker).
  writeFile(root, 'project/package.json', '{}');
  fs.mkdirSync(path.join(root, 'project', 'src'), { recursive: true });

  const found = af.findLocalBin(path.join(root, 'project', 'src'), 'prettier');
  assert.equal(found, null, 'walkUp должен остановиться на project-root, не дойти до evil-родителя');
});

test('findLocalPyBin: walkUp не выходит за project-root marker', () => {
  const root = tmp();
  const evilBin = writeFile(root, '.venv/bin/ruff', '#!/bin/sh\necho evil\n');
  fs.chmodSync(evilBin, 0o755);
  writeFile(root, 'project/pyproject.toml', '');
  fs.mkdirSync(path.join(root, 'project', 'src'), { recursive: true });

  const found = af.findLocalPyBin(path.join(root, 'project', 'src'), 'ruff');
  assert.equal(found, null);
});

test('findUp: walkUp не выходит за project-root marker', () => {
  const root = tmp();
  writeFile(root, 'pnpm-lock.yaml', ''); // в evil-родителе
  writeFile(root, 'project/package.json', '{}');
  fs.mkdirSync(path.join(root, 'project', 'src'), { recursive: true });

  const hit = af.findUp(path.join(root, 'project', 'src'), ['pnpm-lock.yaml']);
  assert.equal(hit, null, 'walkUp не должен подцепить чужой lockfile');
});

test('findLocalBin: symlink-бинарь, ведущий за пределы project-dir, отклоняется', () => {
  const root = tmp();
  // Создаём evil-target вне project'а
  const evilTarget = writeFile(root, 'evil/sh', '#!/bin/sh\necho evil\n');
  fs.chmodSync(evilTarget, 0o755);
  // Внутри project — symlink на evilTarget
  fs.mkdirSync(path.join(root, 'project', 'node_modules', '.bin'), { recursive: true });
  const link = path.join(root, 'project', 'node_modules', '.bin', 'prettier');
  fs.symlinkSync(evilTarget, link);

  const found = af.findLocalBin(path.join(root, 'project'), 'prettier');
  assert.equal(found, null, 'symlink, ведущий за пределы project-dir, не должен выбираться');
});

test('isProjectRoot: распознаёт стандартные маркеры', () => {
  const root = tmp();
  for (const m of af.PROJECT_ROOT_MARKERS) {
    const dir = path.join(root, `proj-${m}`);
    fs.mkdirSync(dir, { recursive: true });
    if (m === '.git') fs.mkdirSync(path.join(dir, '.git'));
    else writeFile(dir, m, '');
    assert.ok(af.isProjectRoot(dir), `${m} должен распознаваться как project-root marker`);
  }
});
