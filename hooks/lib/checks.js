const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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

const TEST_FILE_RE =
  /(^|\/)(__tests__|tests?|spec)\/|(\.|_)(test|spec|e2e)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|rb|exs?|ml|fs|fsx)$|_spec\.(rb|js|ts|tsx)$|(Test|Tests|Spec|Specs)\.(java|kt|kts|scala|swift|cs|fs|php|js|ts|tsx)$/i;

function isTestFile(fp) {
  return TEST_FILE_RE.test(String(fp || ""));
}

const DOC_FILE_RE = /\.(md|mdx|rst|adoc|txt)$|(^|\/)(docs?|documentation)\//i;

function isDocFile(fp) {
  return DOC_FILE_RE.test(String(fp || ""));
}

// Не менять, потому что стили и разметка исключены осознанно: unit-тест на сам
// .css/.html не пишут, там визуальная верификация (триггер M).
const CODE_FILE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rs|rb|java|kt|kts|scala|php|cs|fs|fsx|ex|exs|clj|cljs|erl|hs|ml|mli|swift|dart|lua|sh|bash|zsh|fish|ps1|sql)$/i;

function isCodeFile(fp) {
  return CODE_FILE_RE.test(String(fp || ""));
}

function isPublicSurface(fp) {
  const f = String(fp || "");
  if (/(^|\/)\.claude-plugin\/plugin\.json$/i.test(f)) return true;
  if (/(^|\/)(skills|agents|commands)\/[^/]+\/SKILL\.md$/i.test(f)) return true;
  if (/(^|\/)(bin|cli)\/[^/]+\.(js|ts|mjs|cjs|sh|py)$/i.test(f)) return true;
  if (
    /(^|\/)(src|lib|pkg)\/[^/]*(index|main|api|public|exports|cli)\.(js|ts|mjs|cjs|py|go|rs)$/i.test(
      f,
    )
  )
    return true;
  if (/(^|\/)(schema|config)\.(json|ya?ml|toml)$/i.test(f)) return true;
  return false;
}

function isControllerOrRoute(fp) {
  const f = String(fp || "");
  if (isTestFile(f)) return false;
  if (
    /(^|\/)(controllers?|routes?|handlers?|endpoints?)\/[^/]+\.(ts|js|mjs|py|rb|go|rs|java|kt|php|cs)$/i.test(
      f,
    )
  )
    return true;
  if (/(^|\/)app\/api\/.*\/route\.(ts|js|mjs)$/i.test(f)) return true;
  if (/(^|\/)pages\/api\/.*\.(ts|js|mjs)$/i.test(f)) return true;
  if (/(^|\/)server\/api\/.*\.(ts|js|mjs)$/i.test(f)) return true;
  if (/_controller\.(ts|js|mjs|rb|php|py|go|cs)$/i.test(f)) return true;
  if (/Controller\.(ts|js|mjs|rb|php|py|go|cs|kt|java)$/i.test(f)) return true;
  return false;
}

// Не менять, потому что расширение набора включает e2e-форс на каждый роут:
// generic-маркеры (api|sql|crypto|hash) исключены именно поэтому, а короткие
// токены (acl|sso|otp) стоят с границами — иначе `oracle` матчится на `acl`.
const CRITICAL_ENDPOINT_RE =
  /(auth|login|logout|signin|signup|session|password|token|oauth|saml|ldap|permission|role|access|admin|payment|billing|checkout|charge|payout|transfer|withdraw|refund|invoice|subscription|wallet)|(^|[^a-z0-9])(acl|sso|otp|2fa|mfa)(?![a-z0-9])/i;

function isCriticalEndpoint(fp) {
  return CRITICAL_ENDPOINT_RE.test(String(fp || ""));
}

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

// Не менять, потому что это единственная копия набора метасимволов: вторая
// разъедется, и недоверенная строка попадёт в new RegExp неэкранированной.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function globToRegex(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
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

// Не менять, потому что голое `**/*.ts` обязано считаться широким: разреши его —
// и гард обходится дописыванием дефолтного расширения.
function isBroadIgnoreGlob(glob) {
  const g = String(glob || "")
    .trim()
    .replace(/\/+$/, "");
  if (!g) return false;
  const last = g.split("/").pop();
  const rest = last.replace(/^[*?]+/, "");
  if (rest === "") return true;
  if (/^\.[A-Za-z0-9_*?-]+$/.test(rest)) return true;
  return false;
}

const SKIP_PATH_PATTERNS = [
  /(^|\/)migrations?\//i,
  /(^|\/)migrate\//i,
  /(^|\/)alembic\//i,
  /(^|\/)seed(ers|s)?\//i,
  /(^|\/)fixtures?\//i,
  /(^|\/)(locales?|i18n|translations?)\//i,
  /(^|\/)(__generated__|\.generated)\//i,
  /(^|\/)(start|bootstrap)\//i,
  // Не менять, потому что скип идёт по имени файла, а не по каталогу: голый
  // providers/ спрятал бы логику NestJS/React/Flutter.
  /(^|\/)providers\/[\w-]{1,64}_provider\.(ts|js)$/i,
  // Не менять, потому что рядом стоящие config/ и deploy/ сюда намеренно НЕ
  // добавлены: в них бывает реальная логика, проект глушит их ignore-глобом.
  /(^|\/)(infra|infrastructure)\//i,
  /(^|\/)__mocks__\//i,
];

const SKIP_FILENAME_PATTERNS = [
  /^\d{10,17}_[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|sql|rb)$/i,
  /\.d\.ts$/i,
  /\.generated\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i,
  /\.gen\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i,
  /\.pb\.go$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.sql\.go$/i,
  /(^|\/)(vite|next|nuxt|svelte|astro|tailwind|postcss|babel|jest|vitest|rollup|tsup|webpack|esbuild|drizzle|playwright)\.config\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /(^|\/)adonisrc\.(ts|js)$/i,
  // Не менять, потому что перечислены ровно три имени, а не bin/**: в
  // generic-проектах bin/ несёт CLI-логику.
  /(^|\/)bin\/(server|console|test)\.(ts|js)$/i,
  /(^|\/)ace\.js$/i,
  // Не менять, потому что run.sh / entrypoint.sh / healthcheck.sh сюда не входят:
  // слишком generic, за такими именами бывает реальная логика.
  /(^|\/)(install|deploy|bootstrap|setup|provision|teardown|sync[-_]config)([-_][\w-]{1,40})?\.sh$/i,
  // Не менять, потому что .mdx-stories отфильтровываются раньше (classify → docs)
  // и здесь их быть не должно.
  /\.stories\.(tsx|jsx|ts|js)$/i,
];

const GENERATED_HEADER_RE =
  /(^|[\s/*#])(@generated|Code generated by|GENERATED CODE — DO NOT EDIT)/i;

function isTypeOnlyTsFile(content) {
  const stripped = String(content || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  // Не менять, потому что без позитивного свидетельства типа пустой файл и dump
  // данных прошли бы как type-only.
  const hasTypeDecl =
    /\b(type|interface|enum)\s+[A-Z_]\w*/.test(stripped) ||
    /\bexport\s+(type|interface|enum|\*|\{|const\s+enum)/.test(stripped) ||
    /^\s*declare\s+(module|namespace|global)/m.test(stripped);
  if (!hasTypeDecl) return false;
  if (/\b(function|class)\s+\w/.test(stripped)) return false;
  if (/=>/.test(stripped)) return false;
  if (/\bnew\s+[A-Z]\w*/.test(stripped)) return false;
  if (/\b(let|var)\s+\w/.test(stripped)) return false;
  if (/\bconst\s+(?!enum\b)\w+\s*[:=]/.test(stripped)) return false;
  return true;
}

// Не менять, потому что `@Entity` заякорен на начало строки: иначе упоминание
// в строковом литерале («Use @Entity() to…») прошло бы как модель.
const _LUCID_GATE_RE =
  /\bclass(?:\s+[A-Za-z_$][\w$]{0,80})?\s+extends\s+(?:[A-Za-z_$][\w$]{0,80})?BaseModel\b/;
const _TYPEORM_GATE_RE = /(?:^|\n)\s{0,20}@Entity\s*\(/;

const _MODEL_FIELD_RE =
  /@(?:column|hasOne|hasMany|belongsTo|manyToMany|hasManyThrough|Column|PrimaryColumn|PrimaryGeneratedColumn|ObjectIdColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn|OneToOne|OneToMany|ManyToOne|ManyToMany)\b|\bdeclare\s+[A-Za-z_$]/;

// Не менять, потому что нейтрализуются только стрелки в аргументной позиции:
// стрелка после `=` или `:` — это значение/опция, то есть логика.
const _THUNK_TAIL = "(?=\\s{0,10}[),\\]\\r\\n])";
const _THUNK_TYPE_RE = new RegExp(
  "(?<=[(,\\[]\\s{0,20})\\(\\s{0,10}\\)\\s{0,10}=>\\s{0,10}[A-Za-z_$][\\w$]{0,80}(?:\\.[A-Za-z_$][\\w$]{0,80}){0,5}" +
    _THUNK_TAIL,
  "g",
);
const _THUNK_ACCESSOR_RE = new RegExp(
  "(?<=[(,\\[]\\s{0,20})\\(?\\s{0,10}[A-Za-z_$][\\w$]{0,60}(?:\\s{0,10}:\\s{0,10}[A-Za-z_$][\\w$.]{0,80}(?:<[\\w$,.\\s[\\]]{0,80}>)?)?\\s{0,10}\\)?\\s{0,10}=>\\s{0,10}[A-Za-z_$][\\w$]{0,60}(?:\\.[A-Za-z_$][\\w$]{0,60}){1,6}" +
    _THUNK_TAIL,
  "g",
);

const _MODEL_LOGIC_SIGNALS = [
  /=>/,
  /\bfunction\b/,
  /\b(?:get|set)\s+[A-Za-z_$][\w$]{0,60}\s*\(/,
  /@computed\b/,
  /@(?:[bB]efore|[aA]fter)[A-Z][A-Za-z]{0,40}\b/,
  /\bserializeExtras\b/,
  /\bscope\s*\(/,
  /\b(?:if|for|while|switch)\s*\(/,
  /\btry\s*\{/,
  /\b(?:await|async|throw|yield|return)\b/,
  /\bthis\b/,
  /\bnew\s+[A-Za-z_$]/,
  /\b(?:let|var)\s+[A-Za-z_$]/,
  /=\s{0,10}[A-Za-z_$][\w$.]{0,80}\s*\(/,
  // Не менять, потому что паттерн имя-агностичен намеренно: он ловит
  // многострочные сигнатуры и computed/unicode/#private-имена.
  /\)\s*\{/,
  /\bstatic\s*\{/,
  /\.(?:map|filter|reduce|reduceRight|forEach|find|findIndex|some|every|flatMap|sort)\s*\(/,
  /\$\{/,
];

function isDeclarativeModelFile(content) {
  const stripped = stripBlockComments(String(content || ""));
  const isLucid = _LUCID_GATE_RE.test(stripped);
  const isTypeOrm =
    _TYPEORM_GATE_RE.test(stripped) && /\bclass\b/.test(stripped);
  if (!isLucid && !isTypeOrm) return false;
  if (!_MODEL_FIELD_RE.test(stripped)) return false;
  const neutral = stripped
    .replace(_THUNK_TYPE_RE, "__thunk__")
    .replace(_THUNK_ACCESSOR_RE, "__thunk__");
  for (const re of _MODEL_LOGIC_SIGNALS) if (re.test(neutral)) return false;
  return true;
}

function extractScriptSource(content) {
  const c = String(content || "");
  const parts = [];
  for (const m of c.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    parts.push(m[1]);
  }
  const fm = c.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) parts.push(fm[1]);
  return parts.join("\n");
}

// Не менять, потому что баунд обязателен: без `{0,240}` списки аргументов дают
// катастрофический backtracking на подобранном входе (замерено: 60KB → 1.8s,
// 200KB → ~60s). Расширять можно, снимать баунд — нет.
const _ARG = "[^)]{0,240}";

// Не менять, потому что arrow ловится только в позиции значения или коллбэка:
// иначе типовая аннотация `onClick: () => void` считалась бы логикой, и
// презентационный компонент требовал бы теста.
const _SFC_LOGIC_SIGNALS = [
  /\b(?:ref|shallowRef|customRef|toRef|toRefs|reactive|shallowReactive|readonly|computed|watch|watchEffect|watchPostEffect|watchSyncEffect|effect|inject|provide)\s*\(/,
  /\b(?:onMounted|onBeforeMount|onUnmounted|onBeforeUnmount|onUpdated|onBeforeUpdate|onActivated|onDeactivated|onErrorCaptured|onRenderTracked|onRenderTriggered)\s*\(/,
  /\b(?:methods|computed|watch)\s*:\s*\{/,
  /\b(?:data|created|mounted|beforeCreate|beforeMount|updated|beforeUpdate|destroyed|beforeDestroy|setup|render)\s*\(/,
  /\bfunction\b/,
  /\b(?:if|for|while|switch)\s*\(/,
  /\btry\s*\{/,
  /\b(?:await|async|throw|yield)\b/,
  /\.(?:map|filter|reduce|reduceRight|forEach|find|findIndex|findLast|some|every|flatMap|sort)\s*\(/,
  // Не менять, потому что паттерн имя-агностичен намеренно: ловит `data() {`,
  // `defineExpose({ focus() {} })` и многострочные сигнатуры.
  /\)\s*\{/,
  /\bstatic\s*\{/,
  new RegExp(`=\\s*(?:async\\s+)?\\(${_ARG}\\)\\s*=>`),
  /=\s*(?:async\s+)?[A-Za-z_$][\w$]{0,60}\s*=>/,
  new RegExp(`\\(\\s*(?:async\\s+)?\\(${_ARG}\\)\\s*=>`),
  /(?:^|\n)\s*\$:\s/,
  /\$(?:state|derived|effect)\s*\(/,
];

function isPresentationalSFC(content) {
  const src = extractScriptSource(content);
  if (!src.trim()) return true;
  // Не менять, потому что без стрипа закомментированный код считается логикой.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const re of _SFC_LOGIC_SIGNALS) if (re.test(stripped)) return false;
  return true;
}

// Не менять, потому что файла вне repoRoot или уже удалённого в сессии больше
// нет в проекте — требовать для него тест бессмысленно.
function existsInsideRepo(fp, repoRoot) {
  try {
    if (typeof fp !== "string" || !fp || typeof repoRoot !== "string")
      return false;
    const abs = path.isAbsolute(fp) ? fp : path.join(repoRoot, fp);
    const rel = path.relative(repoRoot, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
      return false;
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

function shouldSkipForTestPairing(srcPath, repoRoot = null) {
  const fp = String(srcPath || "").replace(/\\/g, "/");
  for (const re of SKIP_PATH_PATTERNS) if (re.test(fp)) return true;
  for (const re of SKIP_FILENAME_PATTERNS) if (re.test(fp)) return true;

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
  const head = body.split("\n").slice(0, 10).join("\n");
  if (GENERATED_HEADER_RE.test(head)) return true;
  // Не менять, потому что пре-стрип сканером гасит квадратичный lazy-regex
  // внутри isTypeOnlyTsFile на adversarial-входе.
  if (/\.(ts|tsx)$/i.test(fp) && isTypeOnlyTsFile(stripBlockComments(body)))
    return true;
  if (/\.(ts|js)$/i.test(fp) && isDeclarativeModelFile(body)) return true;
  if (/\.(vue|svelte|astro)$/i.test(fp) && isPresentationalSFC(body))
    return true;
  return false;
}

const SCRIPT_RUNNERS = new Set(["node", "bun", "deno", "tsx", "ts-node"]);
const SCRIPT_EXT_RE = /\.(m?js|cjs|mts|ts)$/i;
const BROWSER_DRIVER_IMPORT_RE =
  /["'](playwright|playwright-core|puppeteer|puppeteer-core|@playwright\/[\w-]{1,30})["']/;
const MAX_SCRIPT_PROBE_BYTES = 200_000;
const MAX_CMD_SCAN_CHARS = 4000;
const MAX_CMD_TOKENS = 400;
const MAX_SCRIPT_PROBES = 20;

function unquote(s) {
  const t = String(s || "");
  if (t.length >= 2 && /^["']/.test(t) && t[0] === t[t.length - 1]) {
    return t.slice(1, -1);
  }
  return t;
}

function extractRunnerScript(cmd) {
  const c = String(cmd || "");
  if (!c || c.length > MAX_CMD_SCAN_CHARS) return null;
  const tokens = c.split(/\s+/).slice(0, MAX_CMD_TOKENS);
  for (let i = 0; i < tokens.length - 1; i++) {
    const runner = path.basename(unquote(tokens[i]).replace(/[;&|]+$/, ""));
    if (!SCRIPT_RUNNERS.has(runner)) continue;
    for (let j = i + 1; j < Math.min(tokens.length, i + 12); j++) {
      const t = unquote(tokens[j]);
      if (!t || t.startsWith("-") || t === "run") continue;
      return SCRIPT_EXT_RE.test(t) ? t : null;
    }
  }
  return null;
}

function extractCdTarget(cmd) {
  const m = String(cmd || "").match(
    /^\s*cd\s+("[^"]{1,400}"|'[^']{1,400}'|\S{1,400})\s*(?:&&|;)/,
  );
  return m ? unquote(m[1]) : null;
}

// Не менять, потому что isFile-guard обязателен: readFileSync виснет на FIFO.
function readScriptSafe(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_SCRIPT_PROBE_BYTES) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// Не менять, потому что playwright, запущенный через свой скрипт, в командной строке не виден.
function cmdRunsBrowserScript(cmd, ctx) {
  if (!ctx || typeof ctx !== "object") return false;
  const rel = extractRunnerScript(cmd);
  if (!rel) return false;
  const cwd = extractCdTarget(cmd) || ctx.cwd;
  if (!cwd && !path.isAbsolute(rel)) return false;
  const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
  const cache = ctx.cache || (ctx.cache = new Map());
  if (cache.has(abs)) return cache.get(abs);
  if (cache.size >= MAX_SCRIPT_PROBES) return false;
  const body = readScriptSafe(abs);
  const hit = body != null && BROWSER_DRIVER_IMPORT_RE.test(body);
  cache.set(abs, hit);
  return hit;
}

// Не менять, потому что unit-раннеры сюда не входят: jsdom не рендерит, и
// внешний https:// тоже — прод-URL не проверяет локальную правку.
function isRenderVerifyCmd(cmd, ctx) {
  const c = String(cmd || "");
  return (
    cmdRunsBrowserScript(c, ctx) ||
    /\bcurl\b[^|;&\n]{0,300}(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(c) ||
    /\bwget\b[^|;&\n]{0,300}(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(c) ||
    /\b(playwright|puppeteer)\b[^\n]{0,300}\b(test|run|open|screenshot|goto|click)/i.test(
      c,
    ) ||
    /chrom(e|ium)[^\n]{0,300}--headless/i.test(c) ||
    /\bnpx\s+playwright\s+(test|open|screenshot)/i.test(c) ||
    // Не менять, потому что cypress признан e2e-стеком в триггере E: не засчитать
    // его в M — внутренняя нестыковка.
    /\bcypress\s+(run|open)\b/i.test(c) ||
    // Не менять, потому что засчитывается только `--browser`: голый `vitest run`
    // живёт в jsdom и рендером не является.
    /\bvitest\b[^\n]{0,300}--browser/i.test(c)
  );
}

const COMMENT_FAMILIES = [
  [
    /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|go|rs|java|kt|kts|scala|php|cs|fs|fsx|swift|dart)$/i,
    "slash",
  ],
  [/\.(py|rb|sh|bash|zsh|fish|ps1|ex|exs|pl|r)$/i, "hash"],
  [/\.(lua|sql|hs)$/i, "dash"],
];

function commentFamilyFor(fp) {
  const f = String(fp || "");
  for (const [re, fam] of COMMENT_FAMILIES) if (re.test(f)) return fam;
  return null;
}

// Не менять, потому что: (1) regex вместо посимвольного скана квадратичен на
// входе из множества незакрытых `/*` — и lazy `[\s\S]*?`, и unrolled-альтернация;
// (2) без учёта строк (' " ` и python-тройных) и regex-литералов токен внутри
// литерала (`// paths like /api/*`, docstring с `# заголовком`, бэктик в
// /```[a-z]*/) открывает мнимый комментарий и съедает файл до EOF вместе с
// кодом-дисквалификатором — обход type-only exempt в триггере M и ложный deny
// в comment-guard. Остаточный mis-parse оставляет мусор → детекторы дают «не
// exempt», гард — deny: fail toward требования.
function scanComments(src, family) {
  const s = String(src || "");
  const fam = family || "slash";
  const lineTok = fam === "slash" ? "//" : fam === "dash" ? "--" : "#";
  const hasBlock = fam === "slash";
  const spans = [];
  const n = s.length;
  let i = 0;
  let codeTail = "";
  // Не менять, потому что бюджет — единственное, что держит скан линейным:
  // неудачная попытка regex-литерала откатывает курсор на один символ, и без
  // бюджета строка из `=/[` даёт O(n²) (замерено: 180KB → 13.6s, при дефолтном
  // таймауте хука в 60s это снятие enforcement).
  let regexBudget = 4 * n;
  const remember = (c) => {
    codeTail = (codeTail + c).slice(-16);
  };
  while (i < n) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || (fam === "slash" && ch === "`")) {
      remember(ch);
      if (fam === "hash" && s[i + 1] === ch && s[i + 2] === ch) {
        const q = ch + ch + ch;
        const end = s.indexOf(q, i + 3);
        i = end === -1 ? n : end + 3;
        continue;
      }
      i++;
      while (i < n) {
        const c = s[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === ch) {
          i++;
          break;
        }
        if (c === "\n" && ch !== "`") break;
        i++;
      }
      continue;
    }
    if (hasBlock && ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      spans.push({
        start: i,
        end: stop,
        text: s.slice(i, stop),
        kind: "block",
      });
      i = stop;
      continue;
    }
    if (s.startsWith(lineTok, i)) {
      let end = s.indexOf("\n", i);
      if (end === -1) end = n;
      spans.push({ start: i, end, text: s.slice(i, end), kind: "line" });
      i = end;
      continue;
    }
    if (
      fam === "slash" &&
      ch === "/" &&
      regexBudget > 0 &&
      startsRegexLiteral(codeTail)
    ) {
      const r = skipRegexLiteral(s, i);
      regexBudget -= r.scanned;
      if (r.end > i) {
        i = r.end;
        codeTail = "/";
        continue;
      }
    }
    if (!/\s/.test(ch)) remember(ch);
    i++;
  }
  return spans;
}

const REGEX_PREV_PUNCT = /[([{,;:=!&|?+\-*%~^<>]$/;
const REGEX_PREV_KEYWORD =
  /\b(return|typeof|case|in|of|new|delete|void|do|else|yield|await)$/;

// Не менять, потому что различение regex-литерала и деления держится только на
// предыдущем значимом токене: после идентификатора / числа / `)` / `]` слэш —
// деление, в остальных позициях — regex. Точка перед ключевым словом обязана
// снимать keyword-ветку: `obj.do / 2` — деление, а принятый за regex слэш съест
// строку до `//` и спрячет от comment-guard реальный комментарий.
function startsRegexLiteral(codeTail) {
  const t = codeTail.replace(/\s+$/, "");
  if (t === "") return true;
  if (REGEX_PREV_PUNCT.test(t)) return true;
  const kw = t.match(REGEX_PREV_KEYWORD);
  if (!kw) return false;
  return t[t.length - kw[0].length - 1] !== ".";
}

// { end, scanned }: end — индекс за концом regex-литерала либо start при неудаче.
// Не менять, потому что: (1) перенос строки означает «это было деление», иначе
// одиночный слэш съедал бы файл до следующего слэша; (2) `scanned` возвращается
// и при неудаче — из него вычитается бюджет в scanComments, без этого учёта скан
// снова становится квадратичным.
function skipRegexLiteral(s, start) {
  let i = start + 1;
  let inClass = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return { end: start, scanned: i - start };
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i++;
      while (i < s.length && /[a-z]/i.test(s[i])) i++;
      return { end: i, scanned: i - start };
    }
    i++;
  }
  return { end: start, scanned: i - start };
}

// Не менять, потому что: спан line-комментария кончается ДО `\n` (перенос
// остаётся в выводе — построчные проверки триггера M живут), а спан блочного
// включает `*/` целиком.
function stripBlockComments(src) {
  const s = String(src || "");
  const spans = scanComments(s, "slash");
  if (spans.length === 0) return s;
  const out = [];
  let prev = 0;
  for (const sp of spans) {
    out.push(s.slice(prev, sp.start));
    prev = sp.end;
  }
  out.push(s.slice(prev));
  return out.join("");
}

// Не менять, потому что путь приходит из транскрипта: без realpath-confinement
// под repoRoot он читает что угодно, а без isFile — виснет на FIFO.
function readRepoFileSafe(fp, repoRoot, maxBytes = 200_000) {
  const f = String(fp || "");
  const abs = path.isAbsolute(f) ? f : path.join(repoRoot || ".", f);
  try {
    const real = fs.realpathSync(abs);
    const rootReal = fs.realpathSync(repoRoot || ".");
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

// Не менять, потому что любая строка вне допустимого набора обязана давать «не
// token-only»: exempt по умолчанию снял бы триггер M с реальных стилей.
function isTokenOnlyCss(content) {
  const stripped = stripBlockComments(content);
  const lines = stripped.split("\n");
  const allowed = [
    /^\s*$/,
    /^\s*\/\/.*$/,
    /^\s*(:root|html)[\s,.:\w[\]="'-]{0,200}\{?\s*$/i,
    /^\s*@(media|supports)\b[^{}]{0,300}\{\s*$/i,
    /^\s*\}\s*;?\s*$/,
    /^\s*--[\w-]+\s*:[^;{}]*;?\s*$/,
    /^\s*\$[\w-]+\s*:[^;{}]*;?\s*$/,
    /^\s*@(import|use|forward|charset|layer)\b[^{}]*;?\s*$/i,
    /^\s*@[\w-]+\s*:[^;{}]*;?\s*$/,
  ];
  const tokenLine =
    /^\s*(--[\w-]+|\$[\w-]+|@(?!(import|use|forward|charset|layer)\b)[\w-]+)\s*:/;
  let sawToken = false;
  for (const line of lines) {
    // Не менять, потому что смежные квантификаторы в allowed квадратичны: гейт
    // длины строки — единственное, что держит их bounded.
    if (line.length > 500) return false;
    if (!allowed.some((re) => re.test(line))) return false;
    if (tokenLine.test(line)) sawToken = true;
  }
  return sawToken;
}

// Не менять, потому что аномалия (нечитаемо / вне repoRoot / >200KB) обязана
// давать «не exempt», а презентационные SFC и .html не exempt никогда — визуал
// именно там.
function isRenderExemptFrontendFile(fp, repoRoot) {
  const f = String(fp || "");
  const body = readRepoFileSafe(f, repoRoot);
  if (body == null) return false;
  const head = body.split("\n").slice(0, 10).join("\n");
  if (GENERATED_HEADER_RE.test(head)) return true;
  // Не менять, потому что стрип сканером идёт до regex-а: он убирает незакрытые
  // `/*`, на которых lazy-regex внутри isTypeOnlyTsFile квадратичен.
  if (/\.(tsx|jsx)$/i.test(f))
    return isTypeOnlyTsFile(stripBlockComments(body));
  if (/\.(css|scss|sass|less|styl|stylus)$/i.test(f))
    return isTokenOnlyCss(body);
  return false;
}

// Не менять, потому что это единственный детект мутаций без говорящего имени
// (/users/:id destroy, /orders POST); квантификаторы bounded — вход недоверенный.
const MUTATING_HANDLER_RES = [
  /\bexport\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/,
  /\.(post|put|patch|delete)\s*\(\s*["'`/]/i,
  /@(Post|Put|Patch|Delete)\s*\(/,
  /\bdef\s+(create|update|destroy)\b/,
  /\bpublic\s+function\s+(store|update|destroy)\b/i,
  /\basync\s+(store|update|destroy)\s*\(/,
];

function hasMutatingHandler(fp, repoRoot) {
  const body = readRepoFileSafe(fp, repoRoot);
  if (body == null) return false;
  const stripped = stripBlockComments(body);
  return MUTATING_HANDLER_RES.some((re) => re.test(stripped));
}

// Не менять, потому что набор шарится с триггером E: functional/integration —
// валидный парный тест логики, а не browser-e2e.
const SHARED_LOGIC_TEST_DIRS = [
  ["tests", "functional"],
  ["tests", "integration"],
];

function getMirrorPrefixReplacements(relFromPackageRoot) {
  const r = relFromPackageRoot.replace(/\\/g, "/");
  const out = [];
  let m = r.match(/^(src\/main\/(java|kotlin|scala|groovy))\//);
  if (m) {
    out.push({ from: m[1], to: ["src/test/" + m[2]] });
    return out;
  }
  m = r.match(/^(Sources\/([^/]+))\//);
  if (m) {
    out.push({ from: m[1], to: [`Tests/${m[2]}Tests`] });
    return out;
  }
  m = r.match(/^(app\/[^/]+)\//);
  if (m) {
    out.push({
      from: m[1],
      to: [m[1].replace(/^app\//, "spec/"), m[1].replace(/^app\//, "test/")],
    });
    return out;
  }
  m = r.match(/^(src|lib|Sources|app)(\/|$)/);
  if (m) {
    const prefix = m[1];
    out.push({
      from: prefix,
      to: ["tests", "test", "spec", "__tests__", `${prefix}/__tests__`],
    });
  }
  return out;
}

function findPairedTestFile(srcPath, repoRoot, sessionEditedFiles = new Set()) {
  if (isTestFile(srcPath)) return srcPath;
  const ext = path.extname(srcPath);
  const dir = path.dirname(srcPath);
  const base = path.basename(srcPath, ext);

  const candidates = [];

  // Не менять, потому что для component-расширений (.vue/.svelte/.astro) кандидаты
  // строятся по ДРУГИМ расширениям: App.spec.vue не существует.
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro)$/i.test(ext)) {
    const isComponent = /\.(vue|svelte|astro)$/i.test(ext);
    const JS_TEST_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
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
        // Не менять, потому что здесь суффикс .test/.spec обязателен: файл без него в
        // tests/ — хелпер, а не доказательство покрытия (в __tests__/ Jest считает всё).
        path.join(dir, "tests", `${base}.test${tExt}`),
        path.join(dir, "tests", `${base}.spec${tExt}`),
        path.join(dir, "test", `${base}.test${tExt}`),
        path.join(dir, "test", `${base}.spec${tExt}`),
      );
    }
    if (isComponent) {
      for (const tExt of JS_TEST_EXTS) {
        candidates.push(
          path.join(dir, `${base}${ext}.test${tExt}`),
          path.join(dir, `${base}${ext}.spec${tExt}`),
        );
      }
    }
  }
  if (ext === ".py") {
    candidates.push(
      path.join(dir, `test_${base}.py`),
      path.join(dir, `${base}_test.py`),
      path.join("tests", `test_${base}.py`),
      path.join("tests", "unit", `test_${base}.py`),
      path.join("test", `test_${base}.py`),
    );
  }
  if (ext === ".go") {
    candidates.push(path.join(dir, `${base}_test.go`));
  }
  if (ext === ".rb") {
    candidates.push(
      path.join(dir, `${base}_test.rb`),
      path.join(dir, `${base}_spec.rb`),
    );
  }
  if (/\.(java|kt|kts|scala|swift|cs|php)$/i.test(ext)) {
    candidates.push(
      path.join(dir, `${base}Test${ext}`),
      path.join(dir, `${base}Tests${ext}`),
      path.join(dir, `${base}Spec${ext}`),
    );
  }
  if (ext === ".rs") {
    candidates.push(path.join("tests", `${base}.rs`));
  }
  // Не менять, потому что это последний шанс для языков без своей конвенции
  // (sh/lua/dart/…): убери — и парный `<name>.test.<ext>` рядом перестанет считаться.
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

  // Не менять, потому что для component-файлов ищется JS/TS-расширение: спек
  // tests/App.vue не существует.
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
    for (const segs of SHARED_LOGIC_TEST_DIRS) {
      candidates.push(
        path.join(...segs, `${base}.test${gExt}`),
        path.join(...segs, `${base}.spec${gExt}`),
      );
    }
  }

  const baseRoots = findPackageRoots(srcPath, repoRoot);

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
      const tail = rel.slice(from.length);
      for (const newPrefix of to) {
        const mirroredDir = path.posix.dirname(newPrefix + tail);
        for (const sfx of mirrorTestSuffixes) {
          const filename = `${base}${sfx}${ext}`;
          const candidatePosix = `${mirroredDir}/${filename}`;
          const candidate = path.join(root, candidatePosix);
          candidates.push(candidate);
        }
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

const CENTRAL_TEST_DIR_NAMES = ["tests", "test", "spec", "specs", "__tests__"];
// Не менять, потому что без всех трёх капов дерево из тысяч не-спековых файлов
// превращает Stop в I/O-DoS.
const IMPORT_SCAN_MAX_FILES = 200;
const IMPORT_SCAN_MAX_LIST = 400;
const IMPORT_SCAN_MAX_VISITED = 20_000;

// Не менять, потому что кап 10000 страхует от опечатки в env-ручке; мусор и ≤0
// обязаны падать на дефолт.
function importScanMaxFiles() {
  const raw = parseInt(process.env.MAIN_SKILL_IMPORT_SCAN_MAX_FILES, 10);
  if (!Number.isFinite(raw) || raw <= 0) return IMPORT_SCAN_MAX_FILES;
  return Math.min(raw, 10_000);
}

// Не менять, потому что набор общий с walkCarrierFiles в audit-ignore-globs.js:
// раздельные копии дрейфуют.
const WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  "target",
  ".cache",
  ".uploads",
]);

// Не менять, потому что `require_relative` вынесен отдельно: `\brequire\b` не
// матчит его из-за `_` в границе слова.
const IMPORT_LINE_RE = /\b(?:import|require(?:_relative)?|from)\b|mock\s*\(/i;

// Не менять, потому что без этого списка любой `../index` давал бы матч, и D
// замолчал бы на непокрытых barrel-файлах.
const GENERIC_BASENAME_RE = /^(index|route|handler|main|mod)$/i;
const GENERIC_PARENT_RE = /^(\.?|src|lib|app|sources?|dist|build)$/i;

// Не менять, потому что basename/parent приходят из транскрипта: без эскейпа и
// капа длины фейковый file_path на десятки KB роняет new RegExp, а вместе с ним
// весь Stop-хук.
function buildImportMatchRes(srcPath) {
  const ext = path.extname(srcPath);
  const base = path.basename(srcPath, ext);
  if (!base || base.length > 200) return null;
  const parentRaw = path.basename(path.dirname(srcPath));
  const parent = parentRaw && parentRaw.length <= 200 ? parentRaw : "";
  const extPat = "(?:\\.[A-Za-z]{1,7})?";
  if (GENERIC_BASENAME_RE.test(base)) {
    // Не менять, потому что для generic-имён матч идёт по родителю, а generic
    // родитель (src/index.ts) скан отключает — иначе массовый false positive.
    if (!parent || GENERIC_PARENT_RE.test(parent)) return null;
    const namePat = `${escapeRegExp(parent)}(?:/${escapeRegExp(base)})?`;
    return [
      new RegExp(`['"\`#/]${namePat}${extPat}['"\`]`, "i"),
      new RegExp(
        `^\\s{0,40}(?:from|import)\\s[\\w.,\\s]{0,300}\\b${escapeRegExp(parent)}\\b`,
        "im",
      ),
    ];
  }
  const basePat = escapeRegExp(base);
  if (parent && !GENERIC_PARENT_RE.test(parent)) {
    const parentPat = escapeRegExp(parent);
    return [
      new RegExp(`['"\`#/]${parentPat}/${basePat}${extPat}['"\`]`, "i"),
      new RegExp(`['"\`#]${basePat}${extPat}['"\`]`, "i"),
      new RegExp(`\\b${parentPat}\\.${basePat}\\b`, "i"),
      new RegExp(
        `\\b${parentPat}\\s{1,40}import\\s{1,40}[\\w.,\\s]{0,200}\\b${basePat}\\b`,
        "i",
      ),
    ];
  }
  return [
    new RegExp(`['"\`#/]${basePat}${extPat}['"\`]`, "i"),
    new RegExp(
      `^\\s{0,40}(?:from|import)\\s[\\w.,\\s]{0,300}\\b${basePat}\\b`,
      "im",
    ),
  ];
}

// Не менять, потому что засчитываются только спек-именованные файлы: хелперы и
// фикстуры в tests/ линк спек→источник не доказывают.
function collectCentralSpecFiles(rootAbs, maxList = IMPORT_SCAN_MAX_LIST) {
  const out = [];
  let visited = 0;
  let truncated = false;
  const walkDir = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxList || visited >= IMPORT_SCAN_MAX_VISITED) {
        truncated = true;
        return;
      }
      visited++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (WALK_SKIP_DIRS.has(e.name)) continue;
        walkDir(full, depth + 1);
      } else if (e.isFile() && isTestFile(e.name)) {
        out.push(full);
      }
    }
  };
  for (const dname of CENTRAL_TEST_DIR_NAMES) {
    walkDir(path.join(rootAbs, dname), 0);
  }
  return { files: out, truncated };
}

// Не менять, потому что порядок решает, найдётся ли покрытый файл до исчерпания
// бюджета чтений: алфавит отрезал бы хвост в пакете на сотни спеков.
function rankSpecCandidates(files, srcPath) {
  const ext = path.extname(srcPath);
  const baseRaw = path.basename(srcPath, ext);
  if (!baseRaw || baseRaw.length > 200) return [...files];
  const base = baseRaw.toLowerCase();
  const parentRaw0 = path.basename(path.dirname(srcPath));
  const parentRaw =
    parentRaw0 && parentRaw0.length <= 200 ? parentRaw0.toLowerCase() : "";
  const isGenericBase = GENERIC_BASENAME_RE.test(base);
  const parent =
    parentRaw && !GENERIC_PARENT_RE.test(parentRaw) ? parentRaw : "";
  const nameSig = isGenericBase ? parent : base;
  const tokens =
    !isGenericBase && base.length >= 3
      ? base.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && t !== base)
      : [];
  const scored = files.map((f, i) => {
    const lower = f.toLowerCase();
    const specBase = path.basename(lower);
    let score = 0;
    if (nameSig.length >= 3 && specBase.includes(nameSig)) score += 4;
    // Не менять, потому что сплит идёт по обоим сепараторам: тесты дают
    // POSIX-литералы, прод — нативные пути из path.join.
    if (parent.length >= 3 && lower.split(/[\\/]/).includes(parent)) score += 2;
    for (const t of tokens) if (specBase.includes(t)) score += 1;
    return { f, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.f);
}

// Не менять, потому что матчатся только import-строки: по всему тексту спека
// упоминание в assert-литерале или описании теста давало бы ложный линк.
function specImportLines(absSpec, repoRoot) {
  const body = readRepoFileSafe(absSpec, repoRoot);
  if (body == null) return "";
  return body
    .split("\n")
    .filter((l) => l.length <= 1000 && IMPORT_LINE_RE.test(l))
    .join("\n");
}

// Не менять, потому что кэш шарится между файлами одного Stop (один скан на
// прогон), а любое исключение обязано давать null — fail toward требования.
function findTestByImportScan(srcPath, repoRoot, cache = {}) {
  cache.lastTruncated = false;
  try {
    return findTestByImportScanInner(srcPath, repoRoot, cache);
  } catch {
    return null;
  }
}

function findTestByImportScanInner(srcPath, repoRoot, cache) {
  const res = buildImportMatchRes(srcPath);
  if (!res) return null;
  if (!cache.rootFiles) cache.rootFiles = new Map();
  if (!cache.importLines) cache.importLines = new Map();
  if (cache.filesRead == null) cache.filesRead = 0;

  // Не менять, потому что список кандидатов масштабируется вместе с бюджетом:
  // иначе поднятая env-ручка упирается в кап списка, а не чтений.
  const cap = importScanMaxFiles();
  const maxList = Math.max(IMPORT_SCAN_MAX_LIST, cap);
  const roots = findPackageRoots(srcPath, repoRoot).sort(
    (a, b) => b.length - a.length,
  );
  for (const root of roots) {
    if (!cache.rootFiles.has(root)) {
      cache.rootFiles.set(root, collectCentralSpecFiles(root, maxList));
    }
    const entry = cache.rootFiles.get(root);
    // Не менять, потому что обрезание списка — тоже обрыв: непроверенный спек
    // означает «покрытие не опровергнуто», даже если бюджет чтений не выбран.
    if (entry.truncated) cache.lastTruncated = true;
    for (const absSpec of rankSpecCandidates(entry.files, srcPath)) {
      if (!cache.importLines.has(absSpec)) {
        if (cache.filesRead >= cap) {
          cache.lastTruncated = true;
          break;
        }
        cache.filesRead++;
        cache.importLines.set(absSpec, specImportLines(absSpec, repoRoot));
      }
      const lines = cache.importLines.get(absSpec);
      if (!lines) continue;
      if (res.some((re) => re.test(lines))) {
        const rel = path.relative(repoRoot, absSpec);
        return rel || absSpec;
      }
    }
  }
  return null;
}

function findE2eFile(srcPath, repoRoot, sessionEditedFiles = new Set()) {
  const ext = path.extname(srcPath);
  const baseFull = path.basename(srcPath, ext);
  const baseStripped = baseFull.replace(/_controller$|Controller$/, "");
  // Не менять, потому что ищутся оба имени — ресурсное и полное: конвенции
  // именования endpoint-тестов в проектах разные.
  const bases =
    baseStripped === baseFull ? [baseFull] : [baseStripped, baseFull];
  // Не менять, потому что при directory-роутинге basename бесполезен (`route`) —
  // имя ресурса живёт в родительской директории.
  if (/^(route|index|handler)$/i.test(baseFull)) {
    const parent = path.basename(path.dirname(srcPath));
    if (parent && parent !== "." && !bases.includes(parent)) bases.push(parent);
  }

  const exts = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|php|cs)$/i.test(
    ext,
  )
    ? [ext]
    : [ext];

  const candidates = [];
  for (const base of bases) {
    for (const e of exts) {
      for (const segs of SHARED_LOGIC_TEST_DIRS) {
        candidates.push(
          path.join(...segs, `${base}.spec${e}`),
          path.join(...segs, `${base}.test${e}`),
        );
      }
      // Не менять, потому что e2e-специфичные дир-ы живут только здесь: в триггере D
      // они дали бы e2e-форс вместо парного unit-теста.
      candidates.push(
        path.join("tests", "e2e", `${base}.test${e}`),
        path.join("tests", "e2e", `${base}.spec${e}`),
        path.join("e2e", `${base}.spec${e}`),
        path.join("e2e", `${base}.test${e}`),
        path.join("cypress", "e2e", `${base}.cy${e}`),
        path.join("playwright", `${base}.spec${e}`),
        path.join("tests", `${base}.e2e${e}`),
      );
    }
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

function parseEdgeCasesBlock(text) {
  if (!text) return null;
  // Не менять, потому что lazy-regex здесь квадратичен на незакрытых тегах — тот
  // же класс, что в findPremortemBlocks.
  const m = extractTagBlocks(text, "edge-cases", 1);
  if (m.length === 0) return null;
  const raw = m[0].trim();
  if (!raw) return { entries: [], raw };
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
    // Не менять, потому что test_name склеивается обратно через `:` — иначе
    // внутренние пробелы лейбла (`main: empty stdin`) теряются.
    const name = segs[0].trim();
    const test_file = segs[1].trim();
    const test_name = segs.slice(2).join(":").trim();
    return { raw: p, name, test_file, test_name, valid: true };
  });
  return { entries, raw };
}

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
    // Не менять, потому что test_file приходит из недоверенного текста: без
    // confinement это traversal, без isFile — висящее чтение FIFO.
    const body = readRepoFileSafe(entry.test_file, repoRoot);
    if (body === null) {
      return {
        entry,
        ok: false,
        reason: `не удалось прочитать ${entry.test_file} (вне repoRoot / не обычный файл / >200KB)`,
      };
    }
    // Не менять, потому что многокилобайтный test_name роняет new RegExp
    // («too large»), а exception = fail-open всего Stop-хука.
    const name =
      entry.test_name.length > 200
        ? entry.test_name.slice(0, 200)
        : entry.test_name;
    const shown = entry.test_name.length > 200 ? name + "…" : name;
    const escaped = escapeRegExp(name);
    const re = new RegExp(
      `(?:^|\\W)(?:it|test|describe|context|specify|t\\.run|test\\.it)\\s*\\(\\s*['"\`][^'"\`]*${escaped}[^'"\`]*['"\`]`,
      "i",
    );
    if (!re.test(body)) {
      const reFn = new RegExp(
        `(?:def|func|test\\s*!|fn)\\s+[a-zA-Z_]*${escaped}[a-zA-Z_0-9]*\\s*\\(`,
        "i",
      );
      if (!reFn.test(body)) {
        // Не менять, потому что гейт на тест-именованный *.sh обязателен: иначе
        // комментарий в самом продакшн-скрипте «доказывал» бы несуществующий тест.
        const isShTest =
          /\.(sh|bash)$/i.test(entry.test_file) &&
          isTestFile(entry.test_file) &&
          name.trim().length >= 3;
        const reShLabel = new RegExp(
          `(?:^|[^A-Za-z0-9])(?:not )?ok - [^\\n]{0,500}${escaped}`,
          "i",
        );
        const reShAssert = new RegExp(
          `(?:^|[^A-Za-z0-9_])assert[A-Za-z_]{0,40}\\b[^\\n]{0,500}${escaped}`,
          "i",
        );
        const reShComment = new RegExp(
          `^[ \\t]{0,8}#(?!!)[^\\n]{0,500}${escaped}`,
          "im",
        );
        if (
          !isShTest ||
          !(
            reShLabel.test(body) ||
            reShAssert.test(body) ||
            reShComment.test(body)
          )
        ) {
          return {
            entry,
            ok: false,
            reason: `в ${entry.test_file} нет теста с именем «${shown}»`,
          };
        }
      }
    }
    return { entry, ok: true };
  });
}

function runLint(repoRoot, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let cmd = null;
  let cwd = repoRoot;

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

  if (!cmd) {
    try {
      const py = path.join(repoRoot, "pyproject.toml");
      if (fs.existsSync(py)) {
        const body = fs.readFileSync(py, "utf8");
        if (/\[tool\.ruff\]/.test(body)) cmd = ["ruff", ["check", "."]];
      }
    } catch {}
  }

  if (!cmd) {
    try {
      if (
        fs.existsSync(path.join(repoRoot, ".golangci.yml")) ||
        fs.existsSync(path.join(repoRoot, ".golangci.yaml"))
      )
        cmd = ["golangci-lint", ["run"]];
    } catch {}
  }

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

const SECURITY_SENSITIVE_RE =
  /(auth|api|sql|crypto|payment|admin|session|token|password|secret|jwt|oauth|cookie|cors|csrf|xss|sanitiz|escape|webhook|hash|cipher|encrypt|decrypt|hmac|signature|signin|signup|login|logout|permission|role|access|sso|saml|ldap)/i;

function hasSecuritySensitivePath(allEdits) {
  for (const e of allEdits || []) {
    if (SECURITY_SENSITIVE_RE.test(String(e.file_path || ""))) return true;
  }
  return false;
}

const COMMENT_ONLY_RE = /^\s*(\/\/|#|\/\*|\*\/|\*|--|<!--|;;|%)/;

// Не менять, потому что ключ нормализуется (trim + whitespace + NFC): без этого
// реформат выравнивания и денормализованный unicode считаются новыми строками.
// Мультимножество, а не Set: дописанный дубликат строки — это добавление.
function _nonTrivialLineKeys(text) {
  if (!text) return [];
  const s0 = String(text);
  const s = s0.length > 1_000_000 ? s0.slice(0, 1_000_000) : s0;
  const keys = [];
  for (const ln of s.split("\n")) {
    const t = ln.trim();
    if (!t) continue;
    if (COMMENT_ONLY_RE.test(ln)) continue;
    keys.push(t.replace(/\s+/g, " ").normalize("NFC"));
  }
  return keys;
}

function _countNonTrivialLines(text) {
  return _nonTrivialLineKeys(text).length;
}

// Не менять, потому что считается дельта, а не весь new_string: Edit несёт
// контекстный якорь, и rename в 25-строчном блоке иначе требовал бы ритуалов.
// LCS отвергнут: O(n·m) на недоверенном транскрипте — DoS Stop-хука.
function _countAddedNonTrivialLines(newText, oldText) {
  if (!oldText) return _countNonTrivialLines(newText);
  // Не менять, потому что за 1MB-капом идёт fallback на полный счёт: дельта на
  // усечённом тексте занулила бы логику за границей капа (обход порога).
  if (String(newText).length > 1_000_000) return _countNonTrivialLines(newText);
  const oldCounts = new Map();
  for (const k of _nonTrivialLineKeys(oldText))
    oldCounts.set(k, (oldCounts.get(k) || 0) + 1);
  let n = 0;
  for (const k of _nonTrivialLineKeys(newText)) {
    const c = oldCounts.get(k) || 0;
    if (c > 0) {
      oldCounts.set(k, c - 1);
      continue;
    }
    n++;
  }
  return n;
}

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
        total += _countAddedNonTrivialLines(
          inp.new_string || "",
          inp.old_string || "",
        );
      } else if (name === "Write") {
        total += _countNonTrivialLines(inp.content || "");
      } else if (name === "MultiEdit") {
        const edits = Array.isArray(inp.edits) ? inp.edits : [];
        for (const ed of edits)
          total += _countAddedNonTrivialLines(
            ed?.new_string || "",
            ed?.old_string || "",
          );
      }
      if (total >= cap) return total;
    }
  }
  return total;
}

// Не менять, потому что диспатч сабагента в разных сборках зовётся Task ИЛИ
// Agent: в Agent-окружении Task отсутствует вовсе.
const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

// Не менять, потому что String(v) на объекте БРОСАЕТ TypeError
// (`{"toString": 1}`), а необёрнутый throw снимает все триггеры A–N разом.
function safeInputStr(v, max = 2000) {
  if (typeof v === "string") return v.slice(0, max);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

// Не менять, потому что матчатся только Anthropic-формы (алиас целиком либо
// сегмент claude-haiku): подстрока `haiku` где угодно даёт FP на чужих
// деплой-именах вроде prod-haiku-router.
function isWeakPremortemModel(model) {
  const s = safeInputStr(model, 200).trim();
  return /^haiku$/i.test(s) || /claude-haiku/i.test(s);
}

// Не менять, потому что матчатся только Anthropic-формы (алиас целиком либо
// сегмент claude-fable / claude-mythos): подстрока где угодно даёт FP на чужих
// именах вроде fable-router.
function isOverCapReviewModel(model) {
  const s = safeInputStr(model, 200).trim();
  return /^(fable|mythos)$/i.test(s) || /claude-(fable|mythos)/i.test(s);
}

function findReviewAgentCalls(lines) {
  let code = false;
  let security = false;
  let edge = false;
  let codeModel = "";
  let securityModel = "";
  let edgeModel = "";
  let codeCallerModel = "";
  let securityCallerModel = "";
  let edgeCallerModel = "";
  for (const e of lines || []) {
    if (e.type !== "assistant") continue;
    const content = e.message?.content || [];
    // Не менять, потому что модель берётся из ТОГО ЖЕ assistant-entry, где лежит
    // вызов: «последняя модель файла» врёт после /model mid-session и на ветвлении.
    const callerModel = safeInputStr(e.message?.model, 200).trim();
    for (const b of content) {
      if (!b || b.type !== "tool_use" || !SUBAGENT_TOOL_NAMES.has(b.name))
        continue;
      const inp = b.input || {};
      const sub = safeInputStr(inp.subagent_type);
      const desc = safeInputStr(inp.description);
      const prompt = safeInputStr(inp.prompt);
      const hay = `${sub}\n${desc}\n${prompt}`;
      if (
        /code[\s-]*review/i.test(sub) ||
        /code[\s-]*reviewer/i.test(sub) ||
        /\bcode[\s-]*review\b/i.test(hay) ||
        /\bревью\s+кода\b/i.test(hay)
      ) {
        code = true;
        codeModel = safeInputStr(inp.model, 200);
        codeCallerModel = callerModel;
      }
      if (
        /security/i.test(sub) ||
        /\b(security[\s-]*review|OWASP|injection|auth[\s-]*bypass|secret[\s-]*leak|XSS|CSRF|SSRF|path\s+traversal|RCE|TOCTOU|weak\s+crypto)\b/i.test(
          hay,
        ) ||
        /\b(секьюрити|безопасност[ьи])\b/i.test(hay)
      ) {
        security = true;
        securityModel = safeInputStr(inp.model, 200);
        securityCallerModel = callerModel;
      }
      // Не менять, потому что hay уже содержит sub — отдельная sub-проверка мертва.
      if (/пре-?мортем|pre-?mortem/i.test(hay)) {
        edge = true;
        edgeModel = safeInputStr(inp.model, 200);
        edgeCallerModel = callerModel;
      }
    }
  }
  return {
    code,
    security,
    edge,
    codeModel,
    securityModel,
    edgeModel,
    codeCallerModel,
    securityCallerModel,
    edgeCallerModel,
  };
}

function parseSelfReview(text) {
  if (!text) return null;
  const m = extractTagBlocks(text, "self-review", 1);
  if (m.length === 0) return null;
  const raw = m[0].trim();
  const out = {
    code: null,
    security: null,
    edge: null,
    skippedTrivial: false,
    raw,
  };
  if (!raw) return out;
  if (/^\s*skipped\s*:\s*trivial\s*$/i.test(raw)) {
    out.skippedTrivial = true;
    return out;
  }
  const parts = raw
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith("#") && !s.startsWith("//"));
  // Не менять, потому что per-section `skipped` — это bypass J/K: валиден только
  // whole-block `<self-review>skipped:trivial</self-review>`.
  for (const p of parts) {
    const m2 = p.match(
      /^(code|security|edge)\s*:\s*(applied|rejected|deferred|none-found|none)\s*:?\s*(.*)$/i,
    );
    if (!m2) {
      const m3 = p.match(
        /^(code|security|edge)\s*:\s*(applied|rejected|deferred|none-found|none)\s*$/i,
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

function parseReviewTriage(text) {
  if (!text) return null;
  const m = extractTagBlocks(text, "review-triage", 1);
  if (m.length === 0) return null;
  const raw = m[0].trim();
  const out = { entries: [], raw };
  if (!raw) return out;
  // Не менять, потому что `;` считается разделителем только перед началом
  // следующей записи: иначе reason с `;` (URL params) ломает парсинг.
  const parts = raw
    .split(/\n|;(?=\s*(?:code|security|edge)\s*:)/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith("#") && !s.startsWith("//"));
  for (const p of parts) {
    const m2 = p.match(
      /^(code|security|edge)\s*:\s*([^:]+?)\s*:\s*(applied|rejected|deferred)\s*:\s*(.+)$/i,
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

// Не менять, потому что вместо `\b` стоит lookaround: JS-`\b` не работает на
// кириллице — границы между двумя \W не существует.
const _NW = "(?<![\\p{L}\\p{N}_])";
const _NWE = "(?![\\p{L}\\p{N}_])";
const SLOP_RE = new RegExp(
  `${_NW}(?:minor|nitpick|nit|несущественн[оы]?е?|не\\s+критичн[оы]?|вне\\s+scope|out\\s+of\\s+scope|стилистик[аио]|косметик[аио]|не\\s*важно|неважн[оы]?е?|мелоч[ьи]|tiny|trivial|cosmetic|not\\s+critical|not\\s+important|petty|чепух[аы]|пустяк|низкий\\s+приоритет|low\\s+priority)${_NWE}`,
  "iu",
);

// Не менять, потому что одиночный слабый сигнал не засчитывается: иначе slop
// обходится словами «версия 2» или упоминанием `null`.
const _STRONG_SIGNALS = [
  /[/\\][\p{L}\p{N}._-]+\.\p{L}{1,8}/u,
  /(?<!\bт)(?<!\bи)(?:[A-Za-z_][A-Za-z0-9_]{2,})\.[A-Za-z_][A-Za-z0-9_]+/,
  new RegExp(
    `${_NW}(?:injection|XSS|CSRF|SSRF|RCE|TOCTOU|owasp|exploit|payload|allowlist|denylist|whitelist|blacklist|rate[\\s-]?limit|throttle|backoff|sanitiz[eaí]|escape|hash|hmac|signature|jwt|oauth|csp|cors|hardcode|secret|credential|leak|bypass|exposes?|приведёт|приведет|нарушит|сломает|breaks|prevents|exposes|allows|leaks|bypasses)${_NWE}`,
    "iu",
  ),
  new RegExp(
    `${_NW}(?:потому\\s+что|так\\s+как|поскольку|из-за|вместо\\s+(?:этого|того)|because|since\\s+(?:it|the)|due\\s+to)${_NWE}`,
    "iu",
  ),
];

// Не менять, потому что баунд общий с _PREMORTEM_SIGNAL_RES: вторая копия
// дрейфует и теряет ReDoS-гарантию.
const _CAMEL_RE = /[a-z][a-zA-Z]{0,30}[A-Z][a-zA-Z]{0,30}/;

const _WEAK_SIGNALS = [
  /:\d+(?:[-–]\d+)?/,
  _CAMEL_RE,
  /[a-z]+(?:_[a-z]+)+/,
  new RegExp(
    `${_NW}(?:class|function|method|interface|struct|module|hook|middleware|handler|endpoint|route|model|schema|migration|query|table|column|reducer|provider|component|service|repository|gateway|adapter|controller)${_NWE}`,
    "iu",
  ),
];

function _hasTechnicalSignal(reason) {
  if (!reason) return false;
  // Не менять, потому что без капа длинный reason ставит хук на колени regex-ами.
  const r = String(reason).slice(0, 4096);
  for (const re of _STRONG_SIGNALS) if (re.test(r)) return true;
  let weak = 0;
  for (const re of _WEAK_SIGNALS) if (re.test(r)) weak++;
  return weak >= 2;
}

function validateReviewTriage(parsed) {
  if (!parsed) return null;
  return (parsed.entries || []).map((entry) => {
    if (!entry.valid) return { entry, ok: false, reason: entry.reason };
    if (entry.status === "applied") {
      // Не менять, потому что минимальный reason требуется и для applied: без него
      // декларация превращается в пустую отписку.
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

// Не менять, потому что lazy `[\s\S]*?` квадратичен на тексте из незакрытых
// тегов: 30k тегов ≈ 1.5s, на 50MB транскрипте — таймаут хука.
function extractTagBlocks(text, tag, maxBlocks = 100) {
  const out = [];
  const s = String(text || "");
  const lower = s.toLowerCase();
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let pos = 0;
  while (out.length < maxBlocks) {
    const i = lower.indexOf(open, pos);
    if (i === -1) break;
    const j = lower.indexOf(close, i + open.length);
    if (j === -1) break;
    out.push(s.slice(i + open.length, j));
    pos = j + close.length;
  }
  return out;
}

const PREMORTEM_MAX_BLOCKS = 100;

function findPremortemBlocks(lines) {
  const out = [];
  const arr = lines || [];
  for (
    let idx = 0;
    idx < arr.length && out.length < PREMORTEM_MAX_BLOCKS;
    idx++
  ) {
    const e = arr[idx];
    if (!e || e.type !== "assistant") continue;
    const content = e.message?.content || [];
    const text = content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join("\n");
    if (!text) continue;
    for (const body of extractTagBlocks(
      text,
      "premortem",
      PREMORTEM_MAX_BLOCKS - out.length,
    )) {
      out.push({ idx, body });
    }
  }
  return out;
}

const PREMORTEM_MAX_BODY = 20_000;
const PREMORTEM_MAX_PARSED = 100;

function parsePremortemBlock(body) {
  const raw = String(body == null ? "" : body).trim();
  const out = { entries: [], raw };
  if (!raw) return out;
  if (raw.length > PREMORTEM_MAX_BODY) {
    out.entries.push({
      raw: raw.slice(0, 200),
      valid: false,
      reason: `тело блока > ${PREMORTEM_MAX_BODY} символов — премортем это 3–7 конкретных гипотез`,
    });
    return out;
  }
  let parts = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith("#") && !s.startsWith("//"));
  let overflow = false;
  if (parts.length > PREMORTEM_MAX_PARSED) {
    overflow = true;
    parts = parts.slice(0, PREMORTEM_MAX_PARSED);
  }
  for (const p of parts) {
    const segments = p.split(/→|->/).map((s) => s.trim());
    if (segments.length < 3 || segments.some((s) => !s)) {
      out.entries.push({
        raw: p,
        valid: false,
        reason:
          "формат: вход/состояние → наблюдаемый отказ → решение (минимум два `→`)",
      });
      continue;
    }
    out.entries.push({ raw: p, segments, valid: true });
  }
  if (overflow) {
    out.entries.push({
      raw: `<записи сверх ${PREMORTEM_MAX_PARSED} обрезаны>`,
      valid: false,
      reason: `блок содержит > ${PREMORTEM_MAX_PARSED} записей — сократи до 3–7 конкретных гипотез`,
    });
  }
  return out;
}

// Не менять, потому что ведущая нумерация стрипуется до проверки: иначе любой
// пронумерованный generic-список проходил бы как сигнал.
const _PREMORTEM_SIGNAL_RES = [
  /\d/,
  _CAMEL_RE,
  /[A-Za-z]{2,60}(?:[_.][A-Za-z0-9]{2,60}){1,20}/,
  /`[^`\n]{1,80}`/,
  // Не менять, потому что хвост словоформы — `[\p{L}]`, а не `\w`: JS-`\w` не
  // включает кириллицу даже с /u, и «идемпотентн-ость» перестала бы матчиться.
  new RegExp(
    `${_NW}(?:идемпотентн[\\p{L}]{0,8}|ретра[йяеи][\\p{L}]{0,6}|retry|таймаут[\\p{L}]{0,3}|timeout|лимит[\\p{L}]{0,4}|limit|rate[\\s-]?limit|квот[аыуе]|кодировк[\\p{L}]{0,3}|encoding|charset|unicode|экраниров[\\p{L}]{0,6}|escap(?:e|ing)|sanitiz[\\p{L}]{0,6}|переполнен[\\p{L}]{0,4}|overflow|дедуп[\\p{L}]{0,10}|dedup[\\p{L}]{0,10}|идентификатор[\\p{L}]{0,3}|конкурентн[\\p{L}]{0,4}|гонк[аиуе]|race|пагинаци[\\p{L}]{0,2}|pagination|backoff|бэкофф[\\p{L}]{0,3}|троттл[\\p{L}]{0,6}|throttl[\\p{L}]{0,4})${_NWE}`,
    "iu",
  ),
];

function _hasPremortemSignal(entryRaw) {
  // Не менять, потому что кап держит стоимость regex-прогонов на запись.
  const s = String(entryRaw || "")
    .slice(0, 2048)
    .replace(
      /^\s*(?:\d{1,3}[.)]\s*|п\.\s?\d{1,3}\s*|шаг\s?\d{1,3}:?\s*)/iu,
      "",
    );
  return _PREMORTEM_SIGNAL_RES.some((re) => re.test(s));
}

function validatePremortem(parsed) {
  if (!parsed) return null;
  return (parsed.entries || []).map((entry) => {
    if (!entry.valid) return { entry, ok: false, reason: entry.reason };
    if (!_hasPremortemSignal(entry.raw)) {
      return {
        entry,
        ok: false,
        reason:
          "generic-гипотеза: нужен точный факт — число (лимит/код ошибки/таймаут) или идентификатор кода",
      };
    }
    return { entry, ok: true };
  });
}

// Не менять, потому что требуются ВСЕ валидные записи: иначе 3 валидных плюс
// пачка generic-шума формально закрывают ритуал.
const PREMORTEM_MIN_ENTRIES = 3;

const _PKG_TOPLEVEL_FIELDS = new Set([
  "name",
  "version",
  "description",
  "main",
  "type",
  "private",
  "license",
  "author",
  "homepage",
  "bugs",
  "repository",
  "keywords",
  "files",
  "bin",
  "scripts",
  "config",
  "browserslist",
  "publishConfig",
  "workspaces",
  "module",
  "types",
  "typings",
  "exports",
  "imports",
  "sideEffects",
  "engines",
  "os",
  "cpu",
  "funding",
  "contributors",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
  "bundleDependencies",
  "resolutions",
  "overrides",
  "packageManager",
]);

const _RUNTIME_NAME_RE =
  /^(node|nodejs|npm|yarn|pnpm|bun|deno|python|python3|ruby|go|golang|rust|java|jdk|kotlin|php|dotnet|swift|elixir|erlang)$/i;

function _parsePackageJson(content) {
  const out = [];
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {}
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const key of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const block = parsed[key];
      if (block && typeof block === "object") {
        for (const [name, version] of Object.entries(block)) {
          if (typeof version === "string")
            out.push({ type: "npm", name, version });
        }
      }
    }
    if (parsed.engines && typeof parsed.engines === "object") {
      for (const [name, version] of Object.entries(parsed.engines)) {
        if (typeof version === "string")
          out.push({ type: "runtime", name, version });
      }
    }
    return out;
  }
  for (const m of String(content).matchAll(
    /"([@a-zA-Z0-9._\-/]+)"\s*:\s*"([^"]+)"/g,
  )) {
    const name = m[1];
    const version = m[2];
    if (_PKG_TOPLEVEL_FIELDS.has(name)) continue;
    if (
      !/^[\^~>=<]?\s*\d/.test(version) &&
      !/^(latest|next|beta|alpha|rc|\*|x)$/i.test(version)
    )
      continue;
    if (_RUNTIME_NAME_RE.test(name)) {
      out.push({ type: "runtime", name, version });
    } else {
      out.push({ type: "npm", name, version });
    }
  }
  return out;
}

function _parsePepReq(s) {
  const m = String(s).match(/^([A-Za-z][A-Za-z0-9._\-]*)/);
  if (!m) return null;
  return { name: m[1], version: s.slice(m[1].length).trim() || "*" };
}

function _parseRequirementsTxt(content) {
  const out = [];
  for (const rawLine of String(content).split("\n")) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    if (
      line.startsWith("-r ") ||
      line.startsWith("-c ") ||
      line.startsWith("--") ||
      line.startsWith("-e ")
    )
      continue;
    const m = line.match(
      /^([A-Za-z][A-Za-z0-9._\-]*)(\[[^\]]+\])?\s*([=<>~!]+\s*[^\s;]+)?/,
    );
    if (!m) continue;
    const name = m[1];
    const version =
      (m[3] || "")
        .replace(/\s+/g, "")
        .replace(/^[=<>~!]+/, "")
        .trim() || "*";
    out.push({ type: "pip", name, version });
  }
  return out;
}

function _parsePyprojectToml(content) {
  const out = [];
  const lines = String(content).split("\n");
  let section = null;
  let inListDeps = false;
  const POETRY_DEP_SECTIONS = new Set([
    "tool.poetry.dependencies",
    "tool.poetry.dev-dependencies",
    "tool.poetry.group.dev.dependencies",
    "tool.poetry.group.test.dependencies",
    "project.dependencies",
    "dependency-groups",
  ]);
  const collectInline = (s) => {
    for (const m of String(s).matchAll(/"([^"]+)"/g)) {
      const dep = _parsePepReq(m[1]);
      if (dep) out.push({ type: "pip", ...dep });
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]/);
    if (sec) {
      section = sec[1];
      inListDeps = false;
      continue;
    }
    if (section === "project" && /^dependencies\s*=\s*\[/.test(line)) {
      const inline = line.match(/=\s*\[(.*?)\]/);
      if (inline) {
        collectInline(inline[1]);
        inListDeps = false;
      } else {
        inListDeps = true;
      }
      continue;
    }
    if (inListDeps) {
      collectInline(line);
      if (/\]/.test(line)) inListDeps = false;
      continue;
    }
    if (POETRY_DEP_SECTIONS.has(section)) {
      const m = line.match(/^([a-zA-Z][a-zA-Z0-9._\-]*)\s*=\s*(.+)$/);
      if (m) {
        const name = m[1];
        const rest = m[2];
        let version = "*";
        const ver = rest.match(/^"([^"]+)"/);
        if (ver) version = ver[1];
        else {
          const ver2 = rest.match(/version\s*=\s*"([^"]+)"/);
          if (ver2) version = ver2[1];
        }
        if (_RUNTIME_NAME_RE.test(name))
          out.push({ type: "runtime", name, version });
        else out.push({ type: "pip", name, version });
      }
    }
  }
  return out;
}

function _parseCargoToml(content) {
  const out = [];
  const lines = String(content).split("\n");
  let section = null;
  const DEP_SECTIONS = new Set([
    "dependencies",
    "dev-dependencies",
    "build-dependencies",
  ]);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]/);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (DEP_SECTIONS.has(section)) {
      const m = line.match(/^([a-zA-Z][a-zA-Z0-9_\-]*)\s*=\s*(.+)$/);
      if (m) {
        const name = m[1];
        const rest = m[2];
        let version = "*";
        const ver = rest.match(/^"([^"]+)"/);
        if (ver) version = ver[1];
        else {
          const ver2 = rest.match(/version\s*=\s*"([^"]+)"/);
          if (ver2) version = ver2[1];
        }
        out.push({ type: "cargo", name, version });
      }
    }
  }
  return out;
}

function _parseGoMod(content) {
  const out = [];
  let inRequireBlock = false;
  for (const rawLine of String(content).split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const goVer = line.match(/^go\s+(\d+(?:\.\d+){0,2})\s*$/);
    if (goVer) {
      out.push({ type: "runtime", name: "go", version: goVer[1] });
      continue;
    }
    if (/^require\s*\(\s*$/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ")") {
      inRequireBlock = false;
      continue;
    }
    const single = line.match(/^require\s+([\w./\-]+)\s+(v[\d.\w\-+]+)/);
    if (single) {
      out.push({ type: "go", name: single[1], version: single[2] });
      continue;
    }
    if (inRequireBlock) {
      const m = line.match(/^([\w./\-]+)\s+(v[\d.\w\-+]+)/);
      if (m) out.push({ type: "go", name: m[1], version: m[2] });
    }
  }
  return out;
}

function _parseDockerfile(content) {
  const out = [];
  for (const rawLine of String(content).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(
      /^FROM\s+(?:--platform=\S+\s+)?([\w.\-]+(?:\/[\w.\-]+)*)(?::([^\s]+))?(?:\s+AS\s+\S+)?\s*$/i,
    );
    if (!m) continue;
    const image = m[1];
    const tag = m[2];
    if (image === "scratch") continue;
    if (!tag) continue;
    if (/^latest$/i.test(tag)) continue;
    if (!/\d/.test(tag)) continue;
    out.push({ type: "docker", name: image, version: tag });
  }
  return out;
}

function _parseToolVersions(content) {
  const out = [];
  for (const rawLine of String(content).split("\n")) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    out.push({ type: "runtime", name: parts[0], version: parts[1] });
  }
  return out;
}

function _parseGhActionsWorkflow(content) {
  const out = [];
  for (const m of String(content).matchAll(
    /uses\s*:\s*([^\s@'"]+)@([^\s'"#]+)/g,
  )) {
    const name = m[1];
    const version = m[2];
    if (name.startsWith("./") || name.startsWith("../")) continue;
    if (name.startsWith("docker://")) continue;
    out.push({ type: "gh-action", name, version });
  }
  return out;
}

function parseManifestDeps(filePath, content) {
  if (!filePath || content == null) return [];
  const fp = String(filePath).replace(/\\/g, "/");
  const c = String(content || "");
  if (!c.trim()) return [];
  if (/(^|\/)package\.json$/.test(fp)) return _parsePackageJson(c);
  if (/(^|\/)(requirements[\w-]*\.txt|constraints\.txt)$/.test(fp))
    return _parseRequirementsTxt(c);
  if (/(^|\/)pyproject\.toml$/.test(fp)) return _parsePyprojectToml(c);
  if (/(^|\/)Cargo\.toml$/.test(fp)) return _parseCargoToml(c);
  if (/(^|\/)go\.mod$/.test(fp)) return _parseGoMod(c);
  if (/(^|\/)Dockerfile(\.[\w-]+)?$/.test(fp)) return _parseDockerfile(c);
  if (/(^|\/)\.nvmrc$/.test(fp)) {
    const v = c.trim();
    return v ? [{ type: "runtime", name: "node", version: v }] : [];
  }
  if (/(^|\/)\.python-version$/.test(fp)) {
    const v = c.trim();
    return v ? [{ type: "runtime", name: "python", version: v }] : [];
  }
  if (/(^|\/)\.tool-versions$/.test(fp)) return _parseToolVersions(c);
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(fp))
    return _parseGhActionsWorkflow(c);
  return [];
}

function _scanUrlsInText(text, map) {
  const t = String(text || "");
  for (const m of t.matchAll(/endoflife\.date\/api\/([a-z0-9_-]+)/gi)) {
    let prod = m[1].toLowerCase();
    if (prod === "nodejs") prod = "node";
    map.runtime.add(prod);
  }
  if (/nodejs\.org\/(dist|download|en\/download)/i.test(t))
    map.runtime.add("node");
  if (/python\.org\/(downloads|ftp\/python)/i.test(t))
    map.runtime.add("python");
  for (const m of t.matchAll(
    /registry\.npmjs\.org\/(@[a-z0-9._\-]+\/[a-z0-9._\-]+|[a-z0-9._\-]+)/gi,
  )) {
    map.npm.add(decodeURIComponent(m[1]).toLowerCase());
  }
  for (const m of t.matchAll(
    /npmjs\.com\/package\/(@[a-z0-9._\-]+\/[a-z0-9._\-]+|[a-z0-9._\-]+)/gi,
  )) {
    map.npm.add(decodeURIComponent(m[1]).toLowerCase());
  }
  for (const m of t.matchAll(
    /pypi\.org\/(?:pypi|project)\/([a-z0-9._\-]+)/gi,
  )) {
    map.pip.add(m[1].toLowerCase());
  }
  for (const m of t.matchAll(
    /crates\.io\/(?:api\/v\d+\/)?crates\/([a-z0-9._\-]+)/gi,
  )) {
    map.cargo.add(m[1].toLowerCase());
  }
  for (const m of t.matchAll(/pkg\.go\.dev\/([\w./\-]+)/gi)) {
    map.go.add(m[1].toLowerCase());
  }
  for (const m of t.matchAll(/proxy\.golang\.org\/([\w./\-]+)/gi)) {
    map.go.add(m[1].toLowerCase());
  }
  for (const m of t.matchAll(
    /hub\.docker\.com\/(?:_|r\/[\w.\-]+)\/([\w.\-]+)/gi,
  )) {
    map.docker.add(m[1].toLowerCase());
  }
  for (const m of t.matchAll(/github\.com\/([\w.\-]+\/[\w.\-]+)\/releases/gi)) {
    const repo = m[1].replace(/\.git$/, "");
    map["gh-action"].add(repo.toLowerCase());
  }
}

function findVersionLookups(lines) {
  const map = {
    npm: new Set(),
    pip: new Set(),
    cargo: new Set(),
    go: new Set(),
    docker: new Set(),
    "gh-action": new Set(),
    runtime: new Set(),
  };
  for (const e of lines || []) {
    if (e.type !== "assistant") continue;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      const name = b.name || "";
      const inp = b.input || {};
      if (name === "Bash") {
        const cmd = String(inp.command || "");
        for (const m of cmd.matchAll(
          /\b(?:npm|pnpm|yarn|bun)\s+(?:view|info|show)\s+([@a-zA-Z0-9._\-/]+)/g,
        )) {
          map.npm.add(m[1].toLowerCase());
        }
        for (const m of cmd.matchAll(/\bdocker\s+pull\s+([\w.\-/]+)/g)) {
          map.docker.add(m[1].split(":")[0].toLowerCase());
        }
        for (const m of cmd.matchAll(
          /\bpip3?\s+(?:index\s+versions|show)\s+([a-zA-Z0-9._\-]+)/g,
        )) {
          map.pip.add(m[1].toLowerCase());
        }
        for (const m of cmd.matchAll(
          /\bcargo\s+search\s+([a-zA-Z0-9._\-]+)/g,
        )) {
          map.cargo.add(m[1].toLowerCase());
        }
        for (const m of cmd.matchAll(
          /\bgo\s+list\s+-m\s+-versions\s+([\w./\-]+)/g,
        )) {
          map.go.add(m[1].toLowerCase());
        }
        for (const m of cmd.matchAll(
          /\bgh\s+api\s+(?:repos\/)?([\w.\-]+\/[\w.\-]+)\/releases/g,
        )) {
          map["gh-action"].add(m[1].toLowerCase());
        }
        for (const m of cmd.matchAll(
          /\bgit\s+ls-remote[^\n]*github\.com[\/:]([\w.\-]+\/[\w.\-]+)/g,
        )) {
          map["gh-action"].add(m[1].replace(/\.git$/, "").toLowerCase());
        }
        for (const m of cmd.matchAll(
          /\bdocker\s+manifest\s+inspect\s+([\w.\-/]+)/g,
        )) {
          map.docker.add(m[1].split(":")[0].toLowerCase());
        }
        _scanUrlsInText(cmd, map);
      }
      if (name === "WebFetch" || name === "WebSearch") {
        _scanUrlsInText(String(inp.url || ""), map);
        _scanUrlsInText(String(inp.query || ""), map);
        _scanUrlsInText(String(inp.prompt || ""), map);
      }
    }
  }
  return map;
}

// Не менять, потому что двойная звезда `(\.0)*(\.0)*` даёт catastrophic
// backtracking на строке `>=0` + `.0`×N + хвост.
const _LOOSE_VERSION_RE =
  /^\s*(latest|next|beta|alpha|rc|\*|x|\.|>=?\s*0(?:\.0)*)\s*$/i;

function getDepsWithoutLookup(deps, lookupMap) {
  if (!Array.isArray(deps) || !lookupMap) return [];
  const out = [];
  for (const d of deps) {
    if (!d || !d.name || !d.type) continue;
    const v = String(d.version || "").trim();
    if (_LOOSE_VERSION_RE.test(v)) continue;
    const set = lookupMap[d.type];
    const lower = d.name.toLowerCase();
    if (set && set.has(lower)) continue;
    // Не менять, потому что docker-образ и runtime — часто один продукт: без
    // cross-type матча FROM node:18 + lookup endoflife/nodejs считался бы непроверенным.
    if (d.type === "docker" && lookupMap.runtime?.has(lower)) continue;
    if (d.type === "runtime" && lookupMap.docker?.has(lower)) continue;
    out.push(d);
  }
  return out;
}

function collectManifestDepsFromEdits(lines) {
  const out = [];
  for (const e of lines || []) {
    if (e.type !== "assistant") continue;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      const name = b.name || "";
      const inp = b.input || {};
      const fp = String(inp.file_path || "");
      if (!fp) continue;
      const collect = (text) => {
        for (const d of parseManifestDeps(fp, text)) {
          out.push({ ...d, file_path: fp });
        }
      };
      if (name === "Edit") collect(String(inp.new_string || ""));
      else if (name === "Write") collect(String(inp.content || ""));
      else if (name === "MultiEdit") {
        const edits = Array.isArray(inp.edits) ? inp.edits : [];
        for (const ed of edits) collect(String(ed?.new_string || ""));
      }
    }
  }
  const seen = new Set();
  const dedup = [];
  for (const d of out) {
    const k = `${d.type}::${d.name.toLowerCase()}::${d.version}::${d.file_path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(d);
  }
  return dedup;
}

function resolveRepoRoot(envProjectDir, fallbackEdits = []) {
  if (envProjectDir && fs.existsSync(envProjectDir)) return envProjectDir;
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
  isCriticalEndpoint,
  CRITICAL_ENDPOINT_RE,
  isRenderVerifyCmd,
  isRenderExemptFrontendFile,
  hasMutatingHandler,
  readRepoFileSafe,
  stripBlockComments,
  scanComments,
  commentFamilyFor,
  isTokenOnlyCss,
  shouldSkipForTestPairing,
  isDeclarativeModelFile,
  isPresentationalSFC,
  extractScriptSource,
  matchAnyGlob,
  isBroadIgnoreGlob,
  existsInsideRepo,
  findPackageRoots,
  findPairedTestFile,
  findTestByImportScan,
  rankSpecCandidates,
  importScanMaxFiles,
  findE2eFile,
  WALK_SKIP_DIRS,
  parseEdgeCasesBlock,
  validateEdgeCases,
  runLint,
  resolveRepoRoot,
  hasSecuritySensitivePath,
  countNonTrivialDiffLines,
  findReviewAgentCalls,
  isWeakPremortemModel,
  isOverCapReviewModel,
  safeInputStr,
  parseSelfReview,
  parseReviewTriage,
  validateReviewTriage,
  SECURITY_SENSITIVE_RE,
  extractTagBlocks,
  findPremortemBlocks,
  parsePremortemBlock,
  validatePremortem,
  PREMORTEM_MIN_ENTRIES,
  PREMORTEM_MAX_PARSED,
  PREMORTEM_MAX_BODY,
  parseManifestDeps,
  findVersionLookups,
  getDepsWithoutLookup,
  collectManifestDepsFromEdits,
};
