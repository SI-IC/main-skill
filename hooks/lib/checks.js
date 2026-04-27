// Хелперы для verify-changes.js — новые триггеры D/E/F/G/H.
// Все функции pure-ish: принимают данные/пути, возвращают результат, не пишут в stdout/exit.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ────────────────────────────────────────────────────────────────────────────
// Сбор edits из транскрипта
// ────────────────────────────────────────────────────────────────────────────

// Собирает все Edit/Write/MultiEdit вызовы из транскрипта.
// Возвращает массив { idx, file_path } в порядке появления.
function collectFileEdits(lines) {
  const out = [];
  lines.forEach((e, idx) => {
    if (e.type !== 'assistant') return;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      if (!['Edit', 'Write', 'MultiEdit'].includes(b.name || '')) continue;
      const fp = String(b.input?.file_path || '');
      if (fp) out.push({ idx, file_path: fp });
    }
  });
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Классификаторы файлов
// ────────────────────────────────────────────────────────────────────────────

const TEST_FILE_RE =
  /(^|\/)(__tests__|tests?|spec)\/|(\.|_)(test|spec|e2e)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;

function isTestFile(fp) {
  return TEST_FILE_RE.test(String(fp || ''));
}

const DOC_FILE_RE = /\.(md|mdx|rst|adoc|txt)$|(^|\/)(docs?|documentation)\//i;

function isDocFile(fp) {
  return DOC_FILE_RE.test(String(fp || ''));
}

// Файлы с кодом, для которых имеет смысл искать парный unit-тест (триггер D).
// Конфиги (.json/.yml/.toml), Docker/Make-файлы, ассеты — не считаются.
const CODE_FILE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rs|rb|java|kt|kts|scala|php|cs|fs|fsx|ex|exs|clj|cljs|erl|hs|ml|mli|swift|dart|lua|sh|bash|zsh|fish|ps1|sql|html|htm|css|scss|sass|less)$/i;

function isCodeFile(fp) {
  return CODE_FILE_RE.test(String(fp || ''));
}

// Public-surface маркеры: то что обязано быть отражено в доках при изменении.
function isPublicSurface(fp) {
  const f = String(fp || '');
  // SKILL.md frontmatter / agents / commands / plugin manifest — поведенческий surface.
  if (/(^|\/)\.claude-plugin\/plugin\.json$/i.test(f)) return true;
  if (/(^|\/)(skills|agents|commands)\/[^/]+\/SKILL\.md$/i.test(f)) return true;
  // Точки входа CLI / public API.
  if (/(^|\/)(bin|cli)\/[^/]+\.(js|ts|mjs|cjs|sh|py)$/i.test(f)) return true;
  if (/(^|\/)(src|lib|pkg)\/[^/]*(index|main|api|public|exports|cli)\.(js|ts|mjs|cjs|py|go|rs)$/i.test(f))
    return true;
  // Конфиг-схемы.
  if (/(^|\/)(schema|config)\.(json|ya?ml|toml)$/i.test(f)) return true;
  return false;
}

// Controller / route handler / api-handler — кандидат на e2e/functional тест.
function isControllerOrRoute(fp) {
  const f = String(fp || '');
  if (isTestFile(f)) return false;
  if (
    /(^|\/)(controllers?|routes?|handlers?|endpoints?)\/[^/]+\.(ts|js|mjs|py|rb|go|rs|java|kt|php|cs)$/i.test(f)
  )
    return true;
  // Next.js / Nuxt / SvelteKit api routes.
  if (/(^|\/)app\/api\/.*\/route\.(ts|js|mjs)$/i.test(f)) return true;
  if (/(^|\/)pages\/api\/.*\.(ts|js|mjs)$/i.test(f)) return true;
  if (/(^|\/)server\/api\/.*\.(ts|js|mjs)$/i.test(f)) return true;
  // AdonisJS / Laravel / Rails-like controllers.
  if (/_controller\.(ts|js|mjs|rb|php|py|go|cs)$/i.test(f)) return true;
  if (/Controller\.(ts|js|mjs|rb|php|py|go|cs|kt|java)$/i.test(f)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Триггер D: поиск парного test-файла
// ────────────────────────────────────────────────────────────────────────────

// Возвращает relative-path найденного парного test-файла, либо null.
// Ищет в репо (existsSync) и среди session-edits (если test ещё не на диске).
function findPairedTestFile(srcPath, repoRoot, sessionEditedFiles = new Set()) {
  if (isTestFile(srcPath)) return srcPath; // тест-файл сам себе парный
  const ext = path.extname(srcPath);
  const dir = path.dirname(srcPath);
  const base = path.basename(srcPath, ext);

  const candidates = [];

  // JS/TS conventions.
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/i.test(ext)) {
    candidates.push(
      path.join(dir, `${base}.test${ext}`),
      path.join(dir, `${base}.spec${ext}`),
      path.join(dir, '__tests__', `${base}${ext}`),
      path.join(dir, '__tests__', `${base}.test${ext}`),
      path.join(dir, '__tests__', `${base}.spec${ext}`),
    );
  }
  // Python.
  if (ext === '.py') {
    candidates.push(
      path.join(dir, `test_${base}.py`),
      path.join('tests', `test_${base}.py`),
      path.join('tests', 'unit', `test_${base}.py`),
    );
  }
  // Go: <name>_test.go рядом.
  if (ext === '.go') {
    candidates.push(path.join(dir, `${base}_test.go`));
  }
  // Generic test directories.
  candidates.push(
    path.join('tests', 'unit', `${base}${ext}`),
    path.join('tests', 'unit', `${base}.test${ext}`),
    path.join('tests', 'unit', `${base}.spec${ext}`),
    path.join('tests', `${base}.test${ext}`),
    path.join('tests', `${base}.spec${ext}`),
    path.join('test', `${base}.test${ext}`),
    path.join('spec', `${base}_spec${ext}`),
  );

  for (const c of candidates) {
    const abs = path.isAbsolute(c) ? c : path.join(repoRoot, c);
    if (sessionEditedFiles.has(abs) || sessionEditedFiles.has(c)) return c;
    try {
      if (fs.existsSync(abs)) return c;
    } catch {}
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Триггер E: e2e/functional парный
// ────────────────────────────────────────────────────────────────────────────

function findE2eFile(srcPath, repoRoot, sessionEditedFiles = new Set()) {
  const ext = path.extname(srcPath);
  const base = path.basename(srcPath, ext).replace(/_controller$|Controller$/, '');

  const exts = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|php|cs)$/i.test(ext) ? [ext] : [ext];

  const candidates = [];
  for (const e of exts) {
    candidates.push(
      path.join('tests', 'functional', `${base}.spec${e}`),
      path.join('tests', 'functional', `${base}.test${e}`),
      path.join('tests', 'e2e', `${base}.test${e}`),
      path.join('tests', 'e2e', `${base}.spec${e}`),
      path.join('tests', 'integration', `${base}.test${e}`),
      path.join('tests', 'integration', `${base}.spec${e}`),
      path.join('e2e', `${base}.spec${e}`),
      path.join('e2e', `${base}.test${e}`),
      path.join('cypress', 'e2e', `${base}.cy${e}`),
      path.join('playwright', `${base}.spec${e}`),
      path.join('tests', `${base}.e2e${e}`),
    );
  }

  for (const c of candidates) {
    const abs = path.isAbsolute(c) ? c : path.join(repoRoot, c);
    if (sessionEditedFiles.has(abs) || sessionEditedFiles.has(c)) return c;
    try {
      if (fs.existsSync(abs)) return c;
    } catch {}
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Триггер F: парсинг и валидация <edge-cases> блока
// ────────────────────────────────────────────────────────────────────────────

// Возвращает { entries, raw } или null если блока нет.
// Формат: <edge-cases>name1:path/to/test.ts:test_name1; name2:path/to/other.ts:test_name2</edge-cases>
// Также принимает многострочный формат с переносами/перечислением.
function parseEdgeCasesBlock(text) {
  if (!text) return null;
  const m = text.match(/<edge-cases>([\s\S]*?)<\/edge-cases>/i);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return { entries: [], raw };
  // Разделители: ; или \n
  const parts = raw
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith('#') && !s.startsWith('//'));
  const entries = parts.map((p) => {
    const segs = p.split(':').map((s) => s.trim());
    if (segs.length < 3) return { raw: p, valid: false, reason: 'формат должен быть name:test_file:test_name' };
    const [name, ...rest] = segs;
    // test_name может содержать `:` обратно (хотя редко); берём последний сегмент как имя теста, остальные склеиваем как путь.
    const test_name = rest.pop();
    const test_file = rest.join(':');
    return { raw: p, name, test_file, test_name, valid: true };
  });
  return { entries, raw };
}

// Проверяет, что test_file существует и содержит it/test/describe с test_name.
// Возвращает массив { entry, ok, reason } для каждой записи.
function validateEdgeCases(parsed, repoRoot) {
  if (!parsed) return null;
  return parsed.entries.map((entry) => {
    if (!entry.valid) return { entry, ok: false, reason: entry.reason };
    const abs = path.isAbsolute(entry.test_file)
      ? entry.test_file
      : path.join(repoRoot, entry.test_file);
    if (!fs.existsSync(abs)) {
      return { entry, ok: false, reason: `test_file не найден: ${entry.test_file}` };
    }
    let body;
    try {
      body = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      return { entry, ok: false, reason: `не удалось прочитать ${entry.test_file}: ${e.message}` };
    }
    // Ищем it('...test_name...') / test('...test_name...') / describe('...') — гибко по подстроке.
    // test_name может быть как точная строка, так и snake/camel-вариант.
    const escaped = entry.test_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\W)(?:it|test|describe|context|specify|t\\.run|test\\.it)\\s*\\(\\s*['"\`][^'"\`]*${escaped}[^'"\`]*['"\`]`, 'i');
    if (!re.test(body)) {
      // fallback: function-like Python/Go test_name
      const reFn = new RegExp(`(?:def|func|test\\s*!|fn)\\s+[a-zA-Z_]*${escaped}[a-zA-Z_0-9]*\\s*\\(`, 'i');
      if (!reFn.test(body)) {
        return { entry, ok: false, reason: `в ${entry.test_file} нет теста с именем «${entry.test_name}»` };
      }
    }
    return { entry, ok: true };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Триггер G: auto-lint
// ────────────────────────────────────────────────────────────────────────────

// Возвращает { ran: bool, ok: bool, cmd, output, reason } либо null если лайнтер не настроен.
function runLint(repoRoot, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let cmd = null;
  let cwd = repoRoot;

  // package.json scripts.lint
  try {
    const pkgPath = path.join(repoRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg?.scripts?.lint) {
        const runner = fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))
          ? 'pnpm'
          : fs.existsSync(path.join(repoRoot, 'yarn.lock'))
            ? 'yarn'
            : 'npm';
        cmd = [runner, ['run', '--silent', 'lint']];
      }
    }
  } catch {}

  // pyproject.toml + ruff
  if (!cmd) {
    try {
      const py = path.join(repoRoot, 'pyproject.toml');
      if (fs.existsSync(py)) {
        const body = fs.readFileSync(py, 'utf8');
        if (/\[tool\.ruff\]/.test(body)) cmd = ['ruff', ['check', '.']];
      }
    } catch {}
  }

  // golangci-lint
  if (!cmd) {
    try {
      if (
        fs.existsSync(path.join(repoRoot, '.golangci.yml')) ||
        fs.existsSync(path.join(repoRoot, '.golangci.yaml'))
      )
        cmd = ['golangci-lint', ['run']];
    } catch {}
  }

  // cargo clippy
  if (!cmd) {
    try {
      if (fs.existsSync(path.join(repoRoot, 'Cargo.toml'))) cmd = ['cargo', ['clippy', '--quiet']];
    } catch {}
  }

  if (!cmd) return null;

  try {
    const out = execFileSync(cmd[0], cmd[1], {
      cwd,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ran: true, ok: true, cmd: `${cmd[0]} ${cmd[1].join(' ')}`, output: out };
  } catch (e) {
    const output = `${e.stdout || ''}\n${e.stderr || ''}`.trim();
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') {
      return { ran: true, ok: null, cmd: `${cmd[0]} ${cmd[1].join(' ')}`, output, reason: 'timeout' };
    }
    if (e.code === 'ENOENT') {
      return { ran: false, ok: null, cmd: `${cmd[0]} ${cmd[1].join(' ')}`, output, reason: 'lint-tool not installed' };
    }
    return { ran: true, ok: false, cmd: `${cmd[0]} ${cmd[1].join(' ')}`, output, reason: 'exit≠0' };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Resolve repo root.
// ────────────────────────────────────────────────────────────────────────────

function resolveRepoRoot(envProjectDir, fallbackEdits = []) {
  if (envProjectDir && fs.existsSync(envProjectDir)) return envProjectDir;
  // Поднимаемся от первой Edit-локации до .git
  for (const e of fallbackEdits) {
    let cur = path.dirname(e.file_path);
    for (let i = 0; i < 10 && cur && cur !== '/'; i++) {
      try {
        if (fs.existsSync(path.join(cur, '.git'))) return cur;
      } catch {}
      cur = path.dirname(cur);
    }
  }
  return process.cwd();
}

module.exports = {
  collectFileEdits,
  isTestFile,
  isDocFile,
  isCodeFile,
  isPublicSurface,
  isControllerOrRoute,
  findPairedTestFile,
  findE2eFile,
  parseEdgeCasesBlock,
  validateEdgeCases,
  runLint,
  resolveRepoRoot,
};
