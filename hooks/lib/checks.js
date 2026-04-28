// Хелперы для verify-changes.js — новые триггеры D/E/F/G/H.
// Все функции pure-ish: принимают данные/пути, возвращают результат, не пишут в stdout/exit.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ────────────────────────────────────────────────────────────────────────────
// Сбор edits из транскрипта
// ────────────────────────────────────────────────────────────────────────────

// Собирает все Edit/Write/MultiEdit вызовы из транскрипта.
// Возвращает массив { idx, file_path } в порядке появления.
function collectFileEdits(lines) {
  const out = [];
  lines.forEach((e, idx) => {
    if (e.type !== "assistant") return;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      if (!["Edit", "Write", "MultiEdit"].includes(b.name || "")) continue;
      const fp = String(b.input?.file_path || "");
      if (fp) out.push({ idx, file_path: fp });
    }
  });
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Классификаторы файлов
// ────────────────────────────────────────────────────────────────────────────

const TEST_FILE_RE =
  /(^|\/)(__tests__|tests?|spec)\/|(\.|_)(test|spec|e2e)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|rb|exs?|ml|fs|fsx)$|_spec\.(rb|js|ts|tsx)$|(Test|Tests|Spec|Specs)\.(java|kt|kts|scala|swift|cs|fs|php|js|ts|tsx)$/i;

function isTestFile(fp) {
  return TEST_FILE_RE.test(String(fp || ""));
}

const DOC_FILE_RE = /\.(md|mdx|rst|adoc|txt)$|(^|\/)(docs?|documentation)\//i;

function isDocFile(fp) {
  return DOC_FILE_RE.test(String(fp || ""));
}

// Файлы с кодом, для которых имеет смысл искать парный unit-тест (триггер D).
// Конфиги (.json/.yml/.toml), Docker/Make-файлы, ассеты — не считаются.
const CODE_FILE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rs|rb|java|kt|kts|scala|php|cs|fs|fsx|ex|exs|clj|cljs|erl|hs|ml|mli|swift|dart|lua|sh|bash|zsh|fish|ps1|sql|html|htm|css|scss|sass|less)$/i;

function isCodeFile(fp) {
  return CODE_FILE_RE.test(String(fp || ""));
}

// Public-surface маркеры: то что обязано быть отражено в доках при изменении.
function isPublicSurface(fp) {
  const f = String(fp || "");
  // SKILL.md frontmatter / agents / commands / plugin manifest — поведенческий surface.
  if (/(^|\/)\.claude-plugin\/plugin\.json$/i.test(f)) return true;
  if (/(^|\/)(skills|agents|commands)\/[^/]+\/SKILL\.md$/i.test(f)) return true;
  // Точки входа CLI / public API.
  if (/(^|\/)(bin|cli)\/[^/]+\.(js|ts|mjs|cjs|sh|py)$/i.test(f)) return true;
  if (
    /(^|\/)(src|lib|pkg)\/[^/]*(index|main|api|public|exports|cli)\.(js|ts|mjs|cjs|py|go|rs)$/i.test(
      f,
    )
  )
    return true;
  // Конфиг-схемы.
  if (/(^|\/)(schema|config)\.(json|ya?ml|toml)$/i.test(f)) return true;
  return false;
}

// Controller / route handler / api-handler — кандидат на e2e/functional тест.
function isControllerOrRoute(fp) {
  const f = String(fp || "");
  if (isTestFile(f)) return false;
  if (
    /(^|\/)(controllers?|routes?|handlers?|endpoints?)\/[^/]+\.(ts|js|mjs|py|rb|go|rs|java|kt|php|cs)$/i.test(
      f,
    )
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
// Workspace / package-root discovery
// ────────────────────────────────────────────────────────────────────────────

// Маркеры «корня пакета» — директорий, относительно которых принято раскладывать
// tests/, tests/unit/, tests/functional/ и т.п. в monorepo-структурах.
const PACKAGE_MARKERS = [
  "package.json",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
];

function existsSafe(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Возвращает массив абсолютных путей base-roots для поиска тестов:
// repoRoot + любая директория с маркером пакета между srcPath и repoRoot.
// Дедуплицирован, repoRoot всегда включён.
function findPackageRoots(srcPath, repoRoot) {
  const roots = new Set([repoRoot]);
  const absSrcDir = path.isAbsolute(srcPath)
    ? path.dirname(srcPath)
    : path.dirname(path.join(repoRoot, srcPath));
  let cur = absSrcDir;
  for (let i = 0; i < 30; i++) {
    if (!cur) break;
    const parsed = path.parse(cur);
    if (cur === parsed.root) break;
    const rel = path.relative(repoRoot, cur);
    if (rel.startsWith("..") || path.isAbsolute(rel)) break;
    for (const m of PACKAGE_MARKERS) {
      if (existsSafe(path.join(cur, m))) {
        roots.add(cur);
        break;
      }
    }
    if (cur === repoRoot) break;
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return [...roots];
}

// ────────────────────────────────────────────────────────────────────────────
// Mini glob matcher (без зависимостей). Поддерживает **, *, ?.
// ────────────────────────────────────────────────────────────────────────────

function globToRegex(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** — любое количество сегментов (включая 0)
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^$()|{}[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

function matchAnyGlob(filePath, globs) {
  if (!globs || !globs.length) return false;
  // Нормализуем — пути в POSIX, без leading "./" и абсолютного префикса не делаем.
  const norm = String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  for (const g of globs) {
    if (!g) continue;
    try {
      if (globToRegex(g).test(norm)) return true;
    } catch {}
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Skip-rules: файлы, для которых требование «парный unit-тест» не имеет смысла
// ────────────────────────────────────────────────────────────────────────────

// Универсальные path-паттерны (любая глубина).
const SKIP_PATH_PATTERNS = [
  /(^|\/)migrations?\//i,
  /(^|\/)migrate\//i,
  /(^|\/)alembic\//i, // Python Alembic: alembic/versions/...
  /(^|\/)seed(ers|s)?\//i,
  /(^|\/)fixtures?\//i,
  /(^|\/)(locales?|i18n|translations?)\//i,
  /(^|\/)(__generated__|\.generated)\//i,
  /(^|\/)(start|bootstrap)\//i,
];

// Filename-паттерны.
const SKIP_FILENAME_PATTERNS = [
  // Timestamped migration filenames (Knex, Adonis, Django, Rails-ish).
  /^\d{10,17}_[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|sql|rb)$/i,
  // Type-only declarations.
  /\.d\.ts$/i,
  // Codegen.
  /\.generated\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i,
  /\.gen\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i,
  /\.pb\.go$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.sql\.go$/i,
  // Framework configs (без логики, для них тестов не пишут).
  /(^|\/)(vite|next|nuxt|svelte|astro|tailwind|postcss|babel|jest|vitest|rollup|tsup|webpack|esbuild|drizzle)\.config\.(ts|tsx|js|jsx|mjs|cjs)$/i,
];

const GENERATED_HEADER_RE =
  /(^|[\s/*#])(@generated|Code generated by|GENERATED CODE — DO NOT EDIT)/i;

function isTypeOnlyTsFile(content) {
  const stripped = String(content || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  // Должно быть хотя бы одно type-объявление, иначе не type-only
  // (пустой файл / dump-данные / one-liner — НЕ type-only).
  const hasTypeDecl =
    /\b(type|interface|enum)\s+[A-Z_]\w*/.test(stripped) ||
    /\bexport\s+(type|interface|enum|\*|\{|const\s+enum)/.test(stripped) ||
    /^\s*declare\s+(module|namespace|global)/m.test(stripped);
  if (!hasTypeDecl) return false;
  if (/\b(function|class)\s+\w/.test(stripped)) return false;
  if (/=>/.test(stripped)) return false;
  if (/\bnew\s+[A-Z]\w*/.test(stripped)) return false;
  if (/\b(let|var)\s+\w/.test(stripped)) return false;
  // const X = ... (но НЕ `const enum X`)
  if (/\bconst\s+(?!enum\b)\w+\s*[:=]/.test(stripped)) return false;
  return true;
}

// Возвращает true если для srcPath не нужен парный unit-тест.
// Универсально по стекам. repoRoot опционален для content-чтения.
function shouldSkipForTestPairing(srcPath, repoRoot = null) {
  const fp = String(srcPath || "").replace(/\\/g, "/");
  for (const re of SKIP_PATH_PATTERNS) if (re.test(fp)) return true;
  for (const re of SKIP_FILENAME_PATTERNS) if (re.test(fp)) return true;

  // Content-based проверки (если файл на диске и небольшой).
  const abs = path.isAbsolute(fp)
    ? fp
    : repoRoot
      ? path.join(repoRoot, fp)
      : null;
  if (!abs) return false;
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > 200_000) return false;
  let body;
  try {
    body = fs.readFileSync(abs, "utf8");
  } catch {
    return false;
  }
  // Проверяем «@generated» / «Code generated by» в первых ~10 строках.
  const head = body.split("\n").slice(0, 10).join("\n");
  if (GENERATED_HEADER_RE.test(head)) return true;
  // TS type-only.
  if (/\.(ts|tsx)$/i.test(fp) && isTypeOnlyTsFile(body)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Триггер D: поиск парного test-файла
// ────────────────────────────────────────────────────────────────────────────

// Mirror-discovery: src-prefix → test-prefixes (внутри того же package-root).
// Возвращает массив { fromRel, toReplacements: string[] } — список замен src-сегмента.
function getMirrorPrefixReplacements(relFromPackageRoot) {
  const r = relFromPackageRoot.replace(/\\/g, "/");
  const out = [];
  // Maven/Gradle: src/main/<lang>/ → src/test/<lang>/
  let m = r.match(/^(src\/main\/(java|kotlin|scala|groovy))\//);
  if (m) {
    out.push({ from: m[1], to: ["src/test/" + m[2]] });
    return out;
  }
  // Swift SPM: Sources/<Module>/ → Tests/<Module>Tests/
  m = r.match(/^(Sources\/([^/]+))\//);
  if (m) {
    out.push({ from: m[1], to: [`Tests/${m[2]}Tests`] });
    return out;
  }
  // Ruby: app/<group>/ → spec/<group>/, test/<group>/
  m = r.match(/^(app\/[^/]+)\//);
  if (m) {
    out.push({
      from: m[1],
      to: [m[1].replace(/^app\//, "spec/"), m[1].replace(/^app\//, "test/")],
    });
    return out;
  }
  // Generic src/lib/Sources/app на верхнем уровне → tests/, test/, spec/, __tests__/,
  // ИЛИ внутрь самого src как __tests__-поддиректория (Jest-style).
  m = r.match(/^(src|lib|Sources|app)(\/|$)/);
  if (m) {
    const prefix = m[1];
    out.push({
      from: prefix,
      to: [
        "tests",
        "test",
        "spec",
        "__tests__",
        `${prefix}/__tests__`, // Jest in-source convention
      ],
    });
  }
  return out;
}

// Возвращает relative-path найденного парного test-файла, либо null.
// Ищет в репо (existsSync) и среди session-edits (если test ещё не на диске).
function findPairedTestFile(srcPath, repoRoot, sessionEditedFiles = new Set()) {
  if (isTestFile(srcPath)) return srcPath; // тест-файл сам себе парный
  const ext = path.extname(srcPath);
  const dir = path.dirname(srcPath);
  const base = path.basename(srcPath, ext);

  const candidates = [];

  // JS/TS conventions.
  // Component-расширения (.vue/.svelte/.astro) тестируются ФАЙЛАМИ С ДРУГИМ расширением
  // (Vue+Vitest: App.spec.ts, Svelte: Button.spec.ts), поэтому строим candidates
  // по списку tested-extensions, а не по ext исходника.
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro)$/i.test(ext)) {
    const isComponent = /\.(vue|svelte|astro)$/i.test(ext);
    // JS/TS-расширения, на которых пишутся тесты (в порядке популярности).
    const JS_TEST_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
    // Для component-файла сам ext — не валиден для теста (App.spec.vue не существует).
    // Для .ts/.tsx/.js/... добавляем сначала свой ext, затем JS/TS fallback.
    const testExts = isComponent
      ? JS_TEST_EXTS
      : [
          ext,
          ...JS_TEST_EXTS.filter((e) => e.toLowerCase() !== ext.toLowerCase()),
        ];

    for (const tExt of testExts) {
      candidates.push(
        path.join(dir, `${base}.test${tExt}`),
        path.join(dir, `${base}.spec${tExt}`),
        path.join(dir, `${base}Test${tExt}`),
        path.join(dir, `${base}Tests${tExt}`),
        path.join(dir, `${base}Spec${tExt}`),
        path.join(dir, `${base}_test${tExt}`),
        path.join(dir, `${base}_spec${tExt}`),
        path.join(dir, "__tests__", `${base}${tExt}`),
        path.join(dir, "__tests__", `${base}.test${tExt}`),
        path.join(dir, "__tests__", `${base}.spec${tExt}`),
      );
    }
    // vitest-plugin-svelte / Vue паттерн: Card.svelte.test.ts / App.vue.spec.ts —
    // тест-файл сохраняет component-ext в имени и добавляет .test.<jsext>.
    if (isComponent) {
      for (const tExt of JS_TEST_EXTS) {
        candidates.push(
          path.join(dir, `${base}${ext}.test${tExt}`),
          path.join(dir, `${base}${ext}.spec${tExt}`),
        );
      }
    }
  }
  // Python.
  if (ext === ".py") {
    candidates.push(
      path.join(dir, `test_${base}.py`),
      path.join(dir, `${base}_test.py`),
      path.join("tests", `test_${base}.py`),
      path.join("tests", "unit", `test_${base}.py`),
      path.join("test", `test_${base}.py`),
    );
  }
  // Go: <name>_test.go рядом.
  if (ext === ".go") {
    candidates.push(path.join(dir, `${base}_test.go`));
  }
  // Ruby: <name>_test.rb / <name>_spec.rb рядом.
  if (ext === ".rb") {
    candidates.push(
      path.join(dir, `${base}_test.rb`),
      path.join(dir, `${base}_spec.rb`),
    );
  }
  // Java/Kotlin/Scala/Swift/C#/PHP — same-dir CamelCase suffix.
  if (/\.(java|kt|kts|scala|swift|cs|php)$/i.test(ext)) {
    candidates.push(
      path.join(dir, `${base}Test${ext}`),
      path.join(dir, `${base}Tests${ext}`),
      path.join(dir, `${base}Spec${ext}`),
    );
  }
  // Rust integration-тесты: crate/tests/<base>.rs (но НЕ inline #[cfg(test)]).
  if (ext === ".rs") {
    candidates.push(path.join("tests", `${base}.rs`));
  }
  // Generic same-dir fallback для языков без специфической поддержки выше
  // (sh/bash/zsh/lua/dart/exs/erl/hs/html/css/sql/...). Универсальная конвенция
  // `<name>.test.<ext>` / `<name>.spec.<ext>` рядом с src — документирована в
  // сообщении триггера D первой строкой; без неё трейлинг-extensions ловили
  // false-positive D даже когда тесты лежат корректно рядом.
  const HANDLED_LANG_EXT_RE =
    /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rb|java|kt|kts|scala|swift|cs|php|rs)$/i;
  if (isCodeFile(srcPath) && !HANDLED_LANG_EXT_RE.test(ext)) {
    candidates.push(
      path.join(dir, `${base}.test${ext}`),
      path.join(dir, `${base}.spec${ext}`),
      path.join(dir, `${base}_test${ext}`),
      path.join(dir, `${base}_spec${ext}`),
    );
  }

  // Generic test directories.
  // Для component-файлов {base}{ext} в tests/ (например tests/App.vue) бессмысленно —
  // используем JS/TS-расширения как и в same-dir секции.
  const isComponent = /\.(vue|svelte|astro)$/i.test(ext);
  const genericExts = isComponent
    ? [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
    : [ext];
  for (const gExt of genericExts) {
    candidates.push(
      path.join("tests", "unit", `${base}${gExt}`),
      path.join("tests", "unit", `${base}.test${gExt}`),
      path.join("tests", "unit", `${base}.spec${gExt}`),
      path.join("tests", `${base}.test${gExt}`),
      path.join("tests", `${base}.spec${gExt}`),
      path.join("test", `${base}.test${gExt}`),
      path.join("spec", `${base}_spec${gExt}`),
    );
  }

  const baseRoots = findPackageRoots(srcPath, repoRoot);

  // Mirror discovery: src/<rel>/X.ext ↔ <test-prefix>/<rel>/X.<test-suffix>.<ext>
  // относительно каждого package-root.
  const absSrc = path.isAbsolute(srcPath)
    ? srcPath
    : path.join(repoRoot, srcPath);
  const mirrorTestSuffixes = [
    "",
    ".test",
    ".spec",
    "Test",
    "Tests",
    "Spec",
    "_test",
    "_spec",
  ];
  for (const root of baseRoots) {
    const rel = path.relative(root, absSrc).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) continue;
    const replacements = getMirrorPrefixReplacements(rel);
    for (const { from, to } of replacements) {
      const tail = rel.slice(from.length); // включает leading '/'
      // tail = '/<rel>/<base>.<ext>'
      for (const newPrefix of to) {
        const mirroredDir = path.posix.dirname(newPrefix + tail);
        for (const sfx of mirrorTestSuffixes) {
          const filename = `${base}${sfx}${ext}`;
          const candidatePosix = `${mirroredDir}/${filename}`;
          const candidate = path.join(root, candidatePosix);
          candidates.push(candidate);
        }
        // Для PHP-стиля tests/Unit|Feature|Integration/<rel>/<Base>Test.php
        if (/\.php$/i.test(ext)) {
          for (const phpDir of ["Unit", "Feature", "Integration"]) {
            const phpMirroredDir = path.posix.join(
              newPrefix,
              phpDir,
              path.posix.dirname(tail.replace(/^\/+/, "")) || ".",
            );
            const phpCandidate = path.join(
              root,
              phpMirroredDir,
              `${base}Test${ext}`,
            );
            candidates.push(phpCandidate);
          }
        }
      }
    }
  }

  const toRelative = (abs) => {
    const rel = path.relative(repoRoot, abs);
    return rel || abs;
  };
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (sessionEditedFiles.has(c) || existsSafe(c)) return toRelative(c);
      continue;
    }
    if (sessionEditedFiles.has(c)) return c;
    for (const root of baseRoots) {
      const abs = path.join(root, c);
      if (sessionEditedFiles.has(abs) || existsSafe(abs))
        return toRelative(abs);
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Триггер E: e2e/functional парный
// ────────────────────────────────────────────────────────────────────────────

function findE2eFile(srcPath, repoRoot, sessionEditedFiles = new Set()) {
  const ext = path.extname(srcPath);
  const base = path
    .basename(srcPath, ext)
    .replace(/_controller$|Controller$/, "");

  const exts = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|php|cs)$/i.test(
    ext,
  )
    ? [ext]
    : [ext];

  const candidates = [];
  for (const e of exts) {
    candidates.push(
      path.join("tests", "functional", `${base}.spec${e}`),
      path.join("tests", "functional", `${base}.test${e}`),
      path.join("tests", "e2e", `${base}.test${e}`),
      path.join("tests", "e2e", `${base}.spec${e}`),
      path.join("tests", "integration", `${base}.test${e}`),
      path.join("tests", "integration", `${base}.spec${e}`),
      path.join("e2e", `${base}.spec${e}`),
      path.join("e2e", `${base}.test${e}`),
      path.join("cypress", "e2e", `${base}.cy${e}`),
      path.join("playwright", `${base}.spec${e}`),
      path.join("tests", `${base}.e2e${e}`),
    );
  }

  const baseRoots = findPackageRoots(srcPath, repoRoot);
  const toRelative = (abs) => {
    const rel = path.relative(repoRoot, abs);
    return rel || abs;
  };
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (sessionEditedFiles.has(c) || existsSafe(c)) return toRelative(c);
      continue;
    }
    if (sessionEditedFiles.has(c)) return c;
    for (const root of baseRoots) {
      const abs = path.join(root, c);
      if (sessionEditedFiles.has(abs) || existsSafe(abs))
        return toRelative(abs);
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Триггер F: парсинг и валидация <edge-cases> блока
// ────────────────────────────────────────────────────────────────────────────

// Возвращает { entries, raw } или null если блока нет.
// Формат: <edge-cases>name1:path/to/test.ts:test_name1; name2:path/to/other.ts:test_name2</edge-cases>
// Также принимает многострочный формат с переносами/перечислением.
// Семантика разбора: первый сегмент — name, второй — test_file (или 'N/A'),
// весь остаток (склеенный через `:`) — test_name. Это позволяет test_name
// содержать `:` (типичный node:test/Jest стиль с вложенными группами).
// POSIX-пути в репо `:` не содержат, так что test_file как ровно один сегмент — безопасно.
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
    .filter((s) => !s.startsWith("#") && !s.startsWith("//"));
  const entries = parts.map((p) => {
    const segs = p.split(":");
    if (segs.length < 3)
      return {
        raw: p,
        valid: false,
        reason: "формат должен быть name:test_file:test_name",
      };
    // trim только name и test_file; test_name склеиваем обратно через `:`,
    // чтобы внутренние пробелы (`main: empty stdin`) сохранились.
    const name = segs[0].trim();
    const test_file = segs[1].trim();
    const test_name = segs.slice(2).join(":").trim();
    return { raw: p, name, test_file, test_name, valid: true };
  });
  return { entries, raw };
}

// Проверяет, что test_file существует и содержит it/test/describe с test_name.
// Спец-кейс: test_file === 'N/A' означает что кейс реально неприменим;
// требуется непустой test_name (он же причина). См. SKILL.md §edge-cases.
// Возвращает массив { entry, ok, reason, na? } для каждой записи.
function validateEdgeCases(parsed, repoRoot) {
  if (!parsed) return null;
  return parsed.entries.map((entry) => {
    if (!entry.valid) return { entry, ok: false, reason: entry.reason };
    if (entry.test_file === "N/A") {
      if (!entry.test_name) {
        return {
          entry,
          ok: false,
          reason: "N/A требует непустую причину после второго `:`",
        };
      }
      return { entry, ok: true, na: true };
    }
    const abs = path.isAbsolute(entry.test_file)
      ? entry.test_file
      : path.join(repoRoot, entry.test_file);
    if (!fs.existsSync(abs)) {
      return {
        entry,
        ok: false,
        reason: `test_file не найден: ${entry.test_file}`,
      };
    }
    let body;
    try {
      body = fs.readFileSync(abs, "utf8");
    } catch (e) {
      return {
        entry,
        ok: false,
        reason: `не удалось прочитать ${entry.test_file}: ${e.message}`,
      };
    }
    // Ищем it('...test_name...') / test('...test_name...') / describe('...') — гибко по подстроке.
    // test_name может быть как точная строка, так и snake/camel-вариант.
    const escaped = entry.test_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(?:^|\\W)(?:it|test|describe|context|specify|t\\.run|test\\.it)\\s*\\(\\s*['"\`][^'"\`]*${escaped}[^'"\`]*['"\`]`,
      "i",
    );
    if (!re.test(body)) {
      // fallback: function-like Python/Go test_name
      const reFn = new RegExp(
        `(?:def|func|test\\s*!|fn)\\s+[a-zA-Z_]*${escaped}[a-zA-Z_0-9]*\\s*\\(`,
        "i",
      );
      if (!reFn.test(body)) {
        return {
          entry,
          ok: false,
          reason: `в ${entry.test_file} нет теста с именем «${entry.test_name}»`,
        };
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
    const pkgPath = path.join(repoRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg?.scripts?.lint) {
        const runner = fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))
          ? "pnpm"
          : fs.existsSync(path.join(repoRoot, "yarn.lock"))
            ? "yarn"
            : "npm";
        cmd = [runner, ["run", "--silent", "lint"]];
      }
    }
  } catch {}

  // pyproject.toml + ruff
  if (!cmd) {
    try {
      const py = path.join(repoRoot, "pyproject.toml");
      if (fs.existsSync(py)) {
        const body = fs.readFileSync(py, "utf8");
        if (/\[tool\.ruff\]/.test(body)) cmd = ["ruff", ["check", "."]];
      }
    } catch {}
  }

  // golangci-lint
  if (!cmd) {
    try {
      if (
        fs.existsSync(path.join(repoRoot, ".golangci.yml")) ||
        fs.existsSync(path.join(repoRoot, ".golangci.yaml"))
      )
        cmd = ["golangci-lint", ["run"]];
    } catch {}
  }

  // cargo clippy
  if (!cmd) {
    try {
      if (fs.existsSync(path.join(repoRoot, "Cargo.toml")))
        cmd = ["cargo", ["clippy", "--quiet"]];
    } catch {}
  }

  if (!cmd) return null;

  try {
    const out = execFileSync(cmd[0], cmd[1], {
      cwd,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return {
      ran: true,
      ok: true,
      cmd: `${cmd[0]} ${cmd[1].join(" ")}`,
      output: out,
    };
  } catch (e) {
    const output = `${e.stdout || ""}\n${e.stderr || ""}`.trim();
    if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
      return {
        ran: true,
        ok: null,
        cmd: `${cmd[0]} ${cmd[1].join(" ")}`,
        output,
        reason: "timeout",
      };
    }
    if (e.code === "ENOENT") {
      return {
        ran: false,
        ok: null,
        cmd: `${cmd[0]} ${cmd[1].join(" ")}`,
        output,
        reason: "lint-tool not installed",
      };
    }
    return {
      ran: true,
      ok: false,
      cmd: `${cmd[0]} ${cmd[1].join(" ")}`,
      output,
      reason: "exit≠0",
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Триггеры J / K: self-review + триаж замечаний ревьюеров
// ────────────────────────────────────────────────────────────────────────────

// Security-sensitive paths — для них self-review обязателен даже на маленьких diff'ах.
const SECURITY_SENSITIVE_RE =
  /(auth|api|sql|crypto|payment|admin|session|token|password|secret|jwt|oauth|cookie|cors|csrf|xss|sanitiz|escape|webhook|hash|cipher|encrypt|decrypt|hmac|signature|signin|signup|login|logout|permission|role|access|sso|saml|ldap)/i;

function hasSecuritySensitivePath(allEdits) {
  for (const e of allEdits || []) {
    if (SECURITY_SENSITIVE_RE.test(String(e.file_path || ""))) return true;
  }
  return false;
}

// Считает строки нетривиальных изменений в Edit/Write/MultiEdit за всю сессию.
// Чисто-пустые / whitespace / comment-only — не считаются.
const COMMENT_ONLY_RE = /^\s*(\/\/|#|\/\*|\*\/|\*|--|<!--|;;|%)/;

function _countNonTrivialLines(text) {
  if (!text) return 0;
  // Cap для больших Write/Edit — > 1MB новых данных всё равно будут считаться как
  // «много», точное число не важно для порога 20.
  const s =
    String(text).length > 1_000_000
      ? String(text).slice(0, 1_000_000)
      : String(text);
  let n = 0;
  for (const ln of s.split("\n")) {
    const t = ln.trim();
    if (!t) continue;
    if (COMMENT_ONLY_RE.test(ln)) continue;
    n++;
  }
  return n;
}

// `filterFn(file_path)` — опциональный фильтр (например, считать только observable
// исходники). `cap` — early-return когда total достиг порога; для J это 20.
function countNonTrivialDiffLines(lines, filterFn = null, cap = Infinity) {
  let total = 0;
  for (const e of lines || []) {
    if (e.type !== "assistant") continue;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      const name = b.name || "";
      const inp = b.input || {};
      if (!["Edit", "Write", "MultiEdit"].includes(name)) continue;
      const fp = String(inp.file_path || "");
      if (filterFn && !filterFn(fp)) continue;
      if (name === "Edit") {
        total += _countNonTrivialLines(inp.new_string || "");
      } else if (name === "Write") {
        total += _countNonTrivialLines(inp.content || "");
      } else if (name === "MultiEdit") {
        const edits = Array.isArray(inp.edits) ? inp.edits : [];
        for (const ed of edits)
          total += _countNonTrivialLines(ed?.new_string || "");
      }
      if (total >= cap) return total;
    }
  }
  return total;
}

// Собирает все Task-вызовы из транскрипта и категоризирует по типу review.
// Возвращает { code: bool, security: bool }.
function findReviewAgentCalls(lines) {
  let code = false;
  let security = false;
  for (const e of lines || []) {
    if (e.type !== "assistant") continue;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== "tool_use" || b.name !== "Task") continue;
      const inp = b.input || {};
      const sub = String(inp.subagent_type || "");
      const desc = String(inp.description || "");
      const prompt = String(inp.prompt || "").slice(0, 2000);
      const hay = `${sub}\n${desc}\n${prompt}`;
      // code review: subagent_type явно code-reviewer ИЛИ описание/промпт упоминает code review.
      if (
        /code[\s-]*review/i.test(sub) ||
        /code[\s-]*reviewer/i.test(sub) ||
        /\bcode[\s-]*review\b/i.test(hay) ||
        /\bревью\s+кода\b/i.test(hay)
      ) {
        code = true;
      }
      // security review: явные маркеры из OWASP/security-prompt.
      if (
        /security/i.test(sub) ||
        /\b(security[\s-]*review|OWASP|injection|auth[\s-]*bypass|secret[\s-]*leak|XSS|CSRF|SSRF|path\s+traversal|RCE|TOCTOU|weak\s+crypto)\b/i.test(
          hay,
        ) ||
        /\b(секьюрити|безопасност[ьи])\b/i.test(hay)
      ) {
        security = true;
      }
    }
  }
  return { code, security };
}

// Парсит блок <self-review>. Возвращает { code, security, skippedTrivial, raw } или null.
// Каждое поле code/security: { status, reason } | null.
// status ∈ { applied, rejected, deferred, 'none-found' }.
function parseSelfReview(text) {
  if (!text) return null;
  const m = text.match(/<self-review>([\s\S]*?)<\/self-review>/i);
  if (!m) return null;
  const raw = m[1].trim();
  const out = { code: null, security: null, skippedTrivial: false, raw };
  if (!raw) return out;
  // Может быть `skipped:trivial` целиком — без code/security секций.
  if (/^\s*skipped\s*:\s*trivial\s*$/i.test(raw)) {
    out.skippedTrivial = true;
    return out;
  }
  const parts = raw
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith("#") && !s.startsWith("//"));
  // Per-section `skipped` намеренно НЕ принимается — это был bypass для J/K
  // (`code:skipped`/`security:skipped` обходили fake-decl и triage). Только
  // whole-block `<self-review>skipped:trivial</self-review>` валиден; см. raw-check выше.
  for (const p of parts) {
    const m2 = p.match(
      /^(code|security)\s*:\s*(applied|rejected|deferred|none-found|none)\s*:?\s*(.*)$/i,
    );
    if (!m2) {
      const m3 = p.match(
        /^(code|security)\s*:\s*(applied|rejected|deferred|none-found|none)\s*$/i,
      );
      if (!m3) continue;
      const sec = m3[1].toLowerCase();
      let st = m3[2].toLowerCase();
      if (st === "none") st = "none-found";
      out[sec] = { status: st, reason: "" };
      continue;
    }
    const sec = m2[1].toLowerCase();
    let st = m2[2].toLowerCase();
    if (st === "none") st = "none-found";
    const reason = (m2[3] || "").trim();
    out[sec] = { status: st, reason };
  }
  return out;
}

// Парсит блок <review-triage>. Возвращает { entries, raw } или null.
// Запись: <source>:<id>:<status>:<reason>; source ∈ { code, security };
// status ∈ { applied, rejected, deferred }.
function parseReviewTriage(text) {
  if (!text) return null;
  const m = text.match(/<review-triage>([\s\S]*?)<\/review-triage>/i);
  if (!m) return null;
  const raw = m[1].trim();
  const out = { entries: [], raw };
  if (!raw) return out;
  // Разделитель: \n ИЛИ `;` перед началом следующей записи (`code:` / `security:`).
  // Так reason может содержать `;` (URL params, fragments) без поломки парсинга.
  const parts = raw
    .split(/\n|;(?=\s*(?:code|security)\s*:)/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith("#") && !s.startsWith("//"));
  for (const p of parts) {
    // <source>:<id>:<status>:<reason>
    // id может содержать буквы; reason может содержать `:`.
    const m2 = p.match(
      /^(code|security)\s*:\s*([^:]+?)\s*:\s*(applied|rejected|deferred)\s*:\s*(.+)$/i,
    );
    if (!m2) {
      out.entries.push({
        raw: p,
        valid: false,
        reason: "формат должен быть source:id:status:reason",
      });
      continue;
    }
    out.entries.push({
      raw: p,
      valid: true,
      source: m2[1].toLowerCase(),
      id: m2[2].trim(),
      status: m2[3].toLowerCase(),
      reason: m2[4].trim(),
    });
  }
  return out;
}

// Slop-фразы — чистые отмазки без технического содержания.
// Используем lookaround вместо `\b`, потому что `\b` в JS не работает на кириллице
// (граница между \W и \W не существует, а кириллица — это \W без флага u).
const _NW = "(?<![\\p{L}\\p{N}_])";
const _NWE = "(?![\\p{L}\\p{N}_])";
const SLOP_RE = new RegExp(
  `${_NW}(?:minor|nitpick|nit|несущественн[оы]?е?|не\\s+критичн[оы]?|вне\\s+scope|out\\s+of\\s+scope|стилистик[аио]|косметик[аио]|не\\s*важно|неважн[оы]?е?|мелоч[ьи]|tiny|trivial|cosmetic|not\\s+critical|not\\s+important|petty|чепух[аы]|пустяк|низкий\\s+приоритет|low\\s+priority)${_NWE}`,
  "iu",
);

// Сильные tech-сигналы — конкретность, специфичные security-термины,
// явная аргументация. Слабые сигналы (одна цифра, общий keyword) не считаются —
// иначе slop тривиально обходится «версия 2» / упоминанием `null`.
const _STRONG_SIGNALS = [
  // file path with ext — самый надёжный признак
  /[/\\][\p{L}\p{N}._-]+\.\p{L}{1,8}/u,
  // <ident>.<ident> при отсутствии русских аббревиатур
  /(?<!\bт)(?<!\bи)(?:[A-Za-z_][A-Za-z0-9_]{2,})\.[A-Za-z_][A-Za-z0-9_]+/,
  // безопасностные / архитектурные термины — сильные
  new RegExp(
    `${_NW}(?:injection|XSS|CSRF|SSRF|RCE|TOCTOU|owasp|exploit|payload|allowlist|denylist|whitelist|blacklist|rate[\\s-]?limit|throttle|backoff|sanitiz[eaí]|escape|hash|hmac|signature|jwt|oauth|csp|cors|hardcode|secret|credential|leak|bypass|exposes?|приведёт|приведет|нарушит|сломает|breaks|prevents|exposes|allows|leaks|bypasses)${_NWE}`,
    "iu",
  ),
  // явная аргументация-связка
  new RegExp(
    `${_NW}(?:потому\\s+что|так\\s+как|поскольку|из-за|вместо\\s+(?:этого|того)|because|since\\s+(?:it|the)|due\\s+to)${_NWE}`,
    "iu",
  ),
];

// Слабые сигналы — поодиночке не засчитываются, но в паре дают tech-signal.
const _WEAK_SIGNALS = [
  // line:number стиль `:42-58`
  /:\d+(?:[-–]\d+)?/,
  // camelCase идентификатор — ограничен 60 chars против ReDoS
  /[a-z][a-zA-Z]{0,30}[A-Z][a-zA-Z]{0,30}/,
  // snake_case
  /[a-z]+(?:_[a-z]+)+/,
  // common code-структуры
  new RegExp(
    `${_NW}(?:class|function|method|interface|struct|module|hook|middleware|handler|endpoint|route|model|schema|migration|query|table|column|reducer|provider|component|service|repository|gateway|adapter|controller)${_NWE}`,
    "iu",
  ),
];

// Технический индикатор — конкретный сигнал в обосновании.
// Возвращает true, если есть >= 1 strong сигнал ИЛИ >= 2 weak.
function _hasTechnicalSignal(reason) {
  if (!reason) return false;
  // ReDoS-защита: обрезаем длинные reason — semantically всё что > 4KB подозрительно
  // и не должно ставить hook на колени regex'ами.
  const r = String(reason).slice(0, 4096);
  for (const re of _STRONG_SIGNALS) if (re.test(r)) return true;
  let weak = 0;
  for (const re of _WEAK_SIGNALS) if (re.test(r)) weak++;
  return weak >= 2;
}

// Возвращает массив { entry, ok, reason } для каждой записи.
// rejected/deferred с slop-only обоснованием → ok=false.
function validateReviewTriage(parsed) {
  if (!parsed) return null;
  return (parsed.entries || []).map((entry) => {
    if (!entry.valid) return { entry, ok: false, reason: entry.reason };
    if (entry.status === "applied") {
      // applied — тоже требуем минимальный reason (>=10 символов), иначе декларация бесполезна.
      if ((entry.reason || "").length < 10) {
        return {
          entry,
          ok: false,
          reason:
            "applied без описания изменения (укажи file:line или суть правки)",
        };
      }
      return { entry, ok: true };
    }
    // rejected / deferred — slop-detector
    const reason = entry.reason || "";
    if (reason.length < 15) {
      return {
        entry,
        ok: false,
        reason: `${entry.status} с обоснованием < 15 символов — недостаточно`,
      };
    }
    const hasSlop = SLOP_RE.test(reason);
    const hasTech = _hasTechnicalSignal(reason);
    if (hasSlop && !hasTech) {
      return {
        entry,
        ok: false,
        reason: `${entry.status} с slop-обоснованием без технического содержания (раскрой: file:line, конкретный риск, метрика)`,
      };
    }
    return { entry, ok: true };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Resolve repo root.
// ────────────────────────────────────────────────────────────────────────────

function resolveRepoRoot(envProjectDir, fallbackEdits = []) {
  if (envProjectDir && fs.existsSync(envProjectDir)) return envProjectDir;
  // Поднимаемся от первой Edit-локации до .git
  for (const e of fallbackEdits) {
    let cur = path.dirname(e.file_path);
    for (let i = 0; i < 10 && cur && cur !== "/"; i++) {
      try {
        if (fs.existsSync(path.join(cur, ".git"))) return cur;
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
  shouldSkipForTestPairing,
  matchAnyGlob,
  findPackageRoots,
  findPairedTestFile,
  findE2eFile,
  parseEdgeCasesBlock,
  validateEdgeCases,
  runLint,
  resolveRepoRoot,
  // J / K
  hasSecuritySensitivePath,
  countNonTrivialDiffLines,
  findReviewAgentCalls,
  parseSelfReview,
  parseReviewTriage,
  validateReviewTriage,
  SECURITY_SENSITIVE_RE,
};
