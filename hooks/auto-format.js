#!/usr/bin/env node
// PostToolUse hook: автоматически форматирует файл после Edit/Write/MultiEdit
// нужным форматтером для языка проекта. Если форматтер не установлен —
// возвращает Claude'у additionalContext с install-командой (детектит package
// manager: pnpm/yarn/npm/bun, uv/poetry/pipenv/pip).
//
// Языки и форматтеры:
//   prettier:     .js .jsx .ts .tsx .mjs .cjs
//                 .css .scss .sass .less
//                 .html .htm
//                 .json .json5 .jsonc
//                 .yaml .yml
//                 .md .mdx
//                 .vue .svelte
//                 .graphql .gql
//   ruff/black:   .py .pyi
//   gofmt:        .go
//   rustfmt:      .rs
//   clang-format: .c .cpp .cc .cxx .h .hpp .hh .hxx .m .mm
//
// Приоритет поиска бинаря: project-local (node_modules/.bin, .venv/bin) →
// global PATH. Если ни там, ни там — additionalContext с install-командой.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (require.main === module) {
  let payload = '';
  let aborted = false;
  process.stdin.on('data', (c) => {
    payload += c;
    if (payload.length > 1024 * 1024) {
      aborted = true;
      process.stdin.destroy();
    }
  });
  process.stdin.on('end', () => {
    if (aborted) return process.exit(0);
    try {
      main(JSON.parse(payload));
    } catch {
      process.exit(0);
    }
  });
}

const EXCLUDE_DIR_RE =
  /(^|[\\/])(node_modules|dist|build|out|coverage|\.next|\.nuxt|target|vendor|\.git|__pycache__|\.venv|venv|\.cache|\.turbo|\.pnpm-store|\.idea|\.vscode|\.parcel-cache)([\\/]|$)/;

const EXCLUDE_FILE_RE =
  /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb|composer\.lock|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$/;

const EXTENSIONS = {
  prettier: new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.css', '.scss', '.sass', '.less',
    '.html', '.htm',
    '.json', '.json5', '.jsonc',
    '.yaml', '.yml',
    '.md', '.mdx',
    '.vue', '.svelte',
    '.graphql', '.gql',
  ]),
  ruff: new Set(['.py', '.pyi']),
  gofmt: new Set(['.go']),
  rustfmt: new Set(['.rs']),
  clang: new Set([
    '.c', '.cpp', '.cc', '.cxx',
    '.h', '.hpp', '.hh', '.hxx',
    '.m', '.mm',
  ]),
};

function languageFor(file) {
  const base = path.basename(file);
  if (EXCLUDE_FILE_RE.test(base)) return null;
  const ext = path.extname(file).toLowerCase();
  for (const [lang, exts] of Object.entries(EXTENSIONS)) {
    if (exts.has(ext)) return lang;
  }
  return null;
}

function main(p) {
  const tool = p.tool_name || '';
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return;

  const filePath = p.tool_input?.file_path || p.tool_input?.notebook_path;
  if (!filePath || typeof filePath !== 'string') return;
  // Claude Code всегда шлёт абсолютные пути для Edit/Write; защита от деградации протокола.
  if (!path.isAbsolute(filePath)) return;

  const abs = filePath;
  let lstat;
  try {
    lstat = fs.lstatSync(abs);
  } catch {
    return; // файл удалён или нет доступа
  }
  // Symlink не форматируем — иначе можно перезаписать таргет за пределами проекта.
  if (lstat.isSymbolicLink()) return;
  if (!lstat.isFile()) return;
  if (EXCLUDE_DIR_RE.test(abs)) return;

  const lang = languageFor(abs);
  if (!lang) return;

  const result = formatFile(lang, abs);
  if (!result || result.kind === 'success') return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: result.message,
      },
    }),
  );
}

function formatFile(lang, file) {
  const dir = path.dirname(file);
  switch (lang) {
    case 'prettier':
      return runFormatter({
        bin: findLocalBin(dir, 'prettier') || 'prettier',
        args: ['--write', file],
        cwd: dir,
        file,
        toolName: 'prettier',
        installer: () => prettierInstaller(file),
      });

    case 'ruff': {
      const ruff = findLocalPyBin(dir, 'ruff') || 'ruff';
      const r = runFormatter({
        bin: ruff,
        args: ['format', file],
        cwd: dir,
        file,
        toolName: 'ruff',
        suppressMissing: true,
      });
      if (r && r.kind !== 'missing') return r;

      const black = findLocalPyBin(dir, 'black') || 'black';
      return runFormatter({
        bin: black,
        args: ['--quiet', file],
        cwd: dir,
        file,
        toolName: 'ruff or black',
        installer: () => pythonInstaller(file),
      });
    }

    case 'gofmt':
      return runFormatter({
        bin: 'gofmt',
        args: ['-w', file],
        cwd: dir,
        file,
        toolName: 'gofmt',
        installer: () => goInstaller(),
      });

    case 'rustfmt':
      return runFormatter({
        bin: 'rustfmt',
        args: [file],
        cwd: dir,
        file,
        toolName: 'rustfmt',
        installer: () => rustfmtInstaller(),
      });

    case 'clang':
      return runFormatter({
        bin: 'clang-format',
        args: ['-i', file],
        cwd: dir,
        file,
        toolName: 'clang-format',
        installer: () => clangInstaller(),
      });
  }
  return null;
}

function runFormatter({ bin, args, cwd, file, toolName, installer, suppressMissing, timeoutMs = 10_000 }) {
  try {
    execFileSync(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    return { kind: 'success' };
  } catch (e) {
    const rel = relPath(file);

    if (e.code === 'ENOENT') {
      if (suppressMissing) return { kind: 'missing' };
      const installCmd = installer ? installer() : null;
      return { kind: 'missing', message: missingMessage(toolName, installCmd) };
    }
    if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
      return {
        kind: 'failed',
        message: `[main-skill auto-format] ${toolName} превысил timeout ${Math.round(timeoutMs / 1000)}s на ${rel}. Файл сохранён без переформатирования.`,
      };
    }
    const stderr = sanitizeStderr(e.stderr || e.stdout || '');
    return {
      kind: 'failed',
      message:
        `[main-skill auto-format] ${toolName} упал на ${rel}.\n` +
        `<formatter-stderr>\n${stderr}\n</formatter-stderr>\n` +
        `Файл сохранён в исходном виде. Не правь форматирование вручную — почини причину (битый синтаксис / конфликт конфига).`,
    };
  }
}

// Защита от prompt-injection через stderr форматтера: ANSI escape убираем,
// control chars вырезаем, каждую строку обрезаем до 200 символов, всего ≤8 строк.
function sanitizeStderr(raw, maxLines = 8, maxLineChars = 200) {
  return String(raw || '')
    .trim()
    .split('\n')
    .slice(0, maxLines)
    .map((line) =>
      line
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
        .slice(0, maxLineChars),
    )
    .join('\n');
}

function missingMessage(toolName, installCmd) {
  const lines = [
    `[main-skill auto-format] Форматтер «${toolName}» не установлен — файл НЕ отформатирован.`,
    `Не правь форматирование вручную; установи форматтер и повтори последнюю правку файла.`,
  ];
  if (installCmd) lines.push(`Установи: ${installCmd}`);
  return lines.join('\n');
}

function relPath(p) {
  try {
    return path.relative(process.cwd(), p) || p;
  } catch {
    return p;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Поиск локального бинаря / lockfile walk-up — ограничено project-root маркером
// (.git, package.json, pyproject.toml, Cargo.toml, go.mod, Pipfile, Gemfile),
// иначе атакующий может подсунуть `/tmp/node_modules/.bin/prettier` и
// получить RCE на multi-user / CI-машине.
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ROOT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml',
  'Cargo.toml', 'go.mod', 'Pipfile', 'Gemfile',
];

function isProjectRoot(dir) {
  for (const m of PROJECT_ROOT_MARKERS) {
    if (fs.existsSync(path.join(dir, m))) return true;
  }
  return false;
}

function findLocalBin(startDir, name) {
  return walkUp(startDir, (dir) => {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (!fs.existsSync(candidate)) return null;
    // symlink-бинарь не доверяем, если он указывает наружу (защита от
    // подброшенного `/tmp/node_modules/.bin/prettier -> /bin/sh`)
    try {
      const lst = fs.lstatSync(candidate);
      if (lst.isSymbolicLink()) {
        const real = fs.realpathSync(candidate);
        if (!real.startsWith(dir)) return null;
      }
    } catch {
      return null;
    }
    return candidate;
  });
}

function findLocalPyBin(startDir, name) {
  return walkUp(startDir, (dir) => {
    for (const venv of ['.venv', 'venv']) {
      const candidate = path.join(dir, venv, 'bin', name);
      if (!fs.existsSync(candidate)) continue;
      try {
        const lst = fs.lstatSync(candidate);
        if (lst.isSymbolicLink()) {
          const real = fs.realpathSync(candidate);
          if (!real.startsWith(dir)) continue;
        }
      } catch {
        continue;
      }
      return candidate;
    }
    return null;
  });
}

function findUp(startDir, names) {
  return walkUp(startDir, (dir) => {
    for (const n of names) {
      if (fs.existsSync(path.join(dir, n))) return { dir, file: n };
    }
    return null;
  });
}

function walkUp(startDir, predicate) {
  let dir = path.resolve(startDir);
  while (true) {
    const hit = predicate(dir);
    if (hit) return hit;
    // Достигли project-root → выше не идём (после проверки текущего уровня).
    if (isProjectRoot(dir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Install-команды (детект пакет-менеджера от файла вверх)
// ─────────────────────────────────────────────────────────────────────────────

function prettierInstaller(file) {
  const dir = path.dirname(file);
  if (findUp(dir, ['bun.lockb', 'bun.lock'])) return 'bun add -d prettier';
  if (findUp(dir, ['pnpm-lock.yaml'])) return 'pnpm add -D prettier';
  if (findUp(dir, ['yarn.lock'])) return 'yarn add -D prettier';
  return 'npm install -D prettier';
}

function pythonInstaller(file) {
  const dir = path.dirname(file);
  if (findUp(dir, ['uv.lock'])) return 'uv add --dev ruff';
  if (findUp(dir, ['poetry.lock'])) return 'poetry add --group dev ruff';
  if (findUp(dir, ['Pipfile'])) return 'pipenv install --dev ruff';
  return 'pip install ruff';
}

function goInstaller() {
  return 'gofmt входит в Go SDK — установи Go (https://go.dev/doc/install или `brew install go`).';
}

function rustfmtInstaller() {
  return 'rustup component add rustfmt';
}

function clangInstaller() {
  if (process.platform === 'darwin') return 'brew install clang-format';
  if (process.platform === 'linux') return 'установи пакет clang-format системным пакетным менеджером (apt/dnf/pacman)';
  return 'установи clang-format системным пакетным менеджером';
}

module.exports = {
  main,
  languageFor,
  findLocalBin,
  findLocalPyBin,
  findUp,
  walkUp,
  isProjectRoot,
  prettierInstaller,
  pythonInstaller,
  goInstaller,
  rustfmtInstaller,
  clangInstaller,
  runFormatter,
  missingMessage,
  sanitizeStderr,
  EXCLUDE_DIR_RE,
  EXCLUDE_FILE_RE,
  EXTENSIONS,
  PROJECT_ROOT_MARKERS,
};
