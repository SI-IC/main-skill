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
// Конфиги (.json/.yml/.toml), Docker/Make-файлы, ассеты, стили (.css/.scss/.html)
// — не считаются. Стили проверяются визуально / через snapshot на уровне
// компонентов, а не unit-тестами на сам файл стилей.
const CODE_FILE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rs|rb|java|kt|kts|scala|php|cs|fs|fsx|ex|exs|clj|cljs|erl|hs|ml|mli|swift|dart|lua|sh|bash|zsh|fish|ps1|sql)$/i;

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

// Критичный endpoint (доступ / деньги) — единственный класс роутов, для которого
// триггер E требует endpoint-level тест. Рядовой controller/route покрывается
// триггером D (парный тест любого слоя): e2e-форс на каждый роут раздувает suite
// (e2e-пролиферация — причина получасовых прогонов). Substring-матч в стиле
// SECURITY_SENSITIVE_RE; generic-маркеры security-КОДА (api|sql|crypto|hash|...)
// сюда намеренно НЕ входят — иначе каждый app/api/**-роут считался бы критичным.
// Короткие токены (acl/sso/otp/2fa/mfa) — с границами не-alnum, иначе substring
// ложно матчит обычные слова: oracle→«acl», associate→«sso». Длинные — substring
// (auth ловит и authenticate; FP вида authors_controller — принятый trade-off).
const CRITICAL_ENDPOINT_RE =
  /(auth|login|logout|signin|signup|session|password|token|oauth|saml|ldap|permission|role|access|admin|payment|billing|checkout|charge|payout|transfer|withdraw|refund|invoice|subscription|wallet)|(^|[^a-z0-9])(acl|sso|otp|2fa|mfa)(?![a-z0-9])/i;

function isCriticalEndpoint(fp) {
  return CRITICAL_ENDPOINT_RE.test(String(fp || ""));
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

// Общий escape для вставки недоверенных строк в new RegExp (import-scan,
// edge-cases matcher) — единственная копия, чтобы набор метасимволов не дрейфовал.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// Широкий ignore-глоб = матчит целый подкаталог/язык без узкого якоря. Смотрим
// последний path-сегмент и снимаем ведущий wildcard-ран (`*`/`**`/`?`):
//   • остаток пуст (`**`, `dir/*`, `config/*`) → broad (вся папка);
//   • остаток — ОДНО расширение (`*.ts`, `*.*`, `**/*.py`, `src/**/*.*`) → broad
//     (весь язык/все файлы по дереву — по эффекту шире каталог-глоба);
//   • иначе есть литеральный якорь: имя (`schema.ts`, `Button.tsx`,
//     `build-*.sh`) или СОСТАВНОЕ расширение (`*.gen.ts`, `*.pb.go`, `*.d.ts`,
//     `*.config.ts`) → narrow.
// Такой глоб глушит триггер D. Используется ignore-glob-guard (PreToolUse) для
// deny широких глобов в момент записи MAIN_SKILL_VERIFY_IGNORE_GLOBS.
function isBroadIgnoreGlob(glob) {
  const g = String(glob || "")
    .trim()
    .replace(/\/+$/, "");
  if (!g) return false;
  const last = g.split("/").pop();
  const rest = last.replace(/^[*?]+/, ""); // снять ведущий wildcard-ран
  if (rest === "") return true; // **, *, dir/* — вся папка
  // одно расширение после wildcard (один dot-токен, без второго `.`) → broad
  if (/^\.[A-Za-z0-9_*?-]+$/.test(rest)) return true;
  return false; // литеральное имя / составное расширение → narrow
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
  // AdonisJS providers/ — IoC-wiring (аналог start/), но НЕ каталогом: голый
  // providers/ скипал бы логику NestJS/React/Flutter. Только Adonis-конвенция
  // snake_case *_provider.(ts|js) прямым потомком; commands/ (ace) намеренно
  // не включён — там бывает логика. Остаточный FN: логика в boot()/ready().
  /(^|\/)providers\/[\w-]{1,64}_provider\.(ts|js)$/i,
  // Infra-as-code / operational scripts directory (almost универсально не
  // покрывается unit-тестами). config/ и deploy/ намеренно НЕ включены —
  // там бывает реальная логика; для них юзер ставит MAIN_SKILL_VERIFY_IGNORE_GLOBS.
  /(^|\/)(infra|infrastructure)\//i,
  // Jest module mocks — конвенция, не application-код.
  /(^|\/)__mocks__\//i,
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
  /(^|\/)(vite|next|nuxt|svelte|astro|tailwind|postcss|babel|jest|vitest|rollup|tsup|webpack|esbuild|drizzle|playwright)\.config\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  // AdonisJS 6 framework-config (не следует схеме <name>.config.<ext>;
  // .adonisrc.json из v5 — JSON, до триггера D не доходит через isCodeFile).
  /(^|\/)adonisrc\.(ts|js)$/i,
  // AdonisJS bin/-entrypoints — тонкие Ignitor-обёртки. ТОЧЕЧНО три имени,
  // не bin/**: в generic-проектах bin/ может нести CLI-логику.
  /(^|\/)bin\/(server|console|test)\.(ts|js)$/i,
  // AdonisJS ace.js — корневая JIT-обёртка; v6-шаблоны генерят только .js.
  /(^|\/)ace\.js$/i,
  // Operational shell-scripts по любому пути. Имена выбраны однозначные:
  // run.sh / entrypoint.sh / healthcheck.sh намеренно НЕ включены — слишком
  // generic, может содержать реальную логику. Опц. [-_]суффикс bounded
  // {1,40} (deploy-server.sh).
  /(^|\/)(install|deploy|bootstrap|setup|provision|teardown|sync[-_]config)([-_][\w-]{1,40})?\.sh$/i,
  // Storybook stories — визуальные fixtures, не unit-тестируются как код.
  // .mdx-stories здесь намеренно отсутствуют — они отфильтровываются раньше
  // через DOC_FILE_RE / classify()='docs' до достижения triggera D.
  /\.stories\.(tsx|jsx|ts|js)$/i,
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

// ────────────────────────────────────────────────────────────────────────────
// Декларативная ORM-модель (Lucid / TypeORM): только колонки / relations /
// declare-поля / static-константы — content-skip для триггера D (стоп-лист
// testing-strategy: DTO/декларации не тестировать). Консервативен как
// isPresentationalSFC: skip только при НУЛЕ сигналов логики; relation-thunk-и
// (`() => Model`, `(x) => x.prop`) — единственные легальные стрелки, и только
// в аргументной позиции (после `(`/`,`/`[`); всё остальное → логика → тест.
// `extends compose(BaseModel, Mixin)` гейт НЕ проходит: миксин несёт поведение.
// ────────────────────────────────────────────────────────────────────────────

// Суффикс-конвенция `*BaseModel` пропускает кастомную базу (AppBaseModel);
// сигналы всё равно сторожат логику. `@Entity` заякорен на начало строки —
// иначе упоминание в строковом литерале («Use @Entity() to…») проходило гейт.
const _LUCID_GATE_RE =
  /\bclass(?:\s+[A-Za-z_$][\w$]{0,80})?\s+extends\s+(?:[A-Za-z_$][\w$]{0,80})?BaseModel\b/;
const _TYPEORM_GATE_RE = /(?:^|\n)\s{0,20}@Entity\s*\(/;

// Позитивное свидетельство модели: хотя бы одно column/relation/declare-поле.
const _MODEL_FIELD_RE =
  /@(?:column|hasOne|hasMany|belongsTo|manyToMany|hasManyThrough|Column|PrimaryColumn|PrimaryGeneratedColumn|ObjectIdColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn|OneToOne|OneToMany|ManyToOne|ManyToMany)\b|\bdeclare\s+[A-Za-z_$]/;

// Декларативные thunk-формы в АРГУМЕНТНОЙ позиции (lookbehind `(`/`,`/`[`):
// стрелка после `=` или `:` (значение/опция) остаётся и даёт сигнал логики.
// Хвостовой lookahead ПОЗИТИВНЫЙ — после цепочки обязан идти разделитель
// аргументной позиции (`)`, `,`, `]`, перенос): `() => User.query()` не
// нейтрализуется (после цепочки `(`), и частичный ретрит идентификатора
// (`query.whereNul` + остаток `l`) тоже не проходит — negative-blacklist
// здесь пропускал бы word-остаток. Все квантификаторы bounded — ReDoS-грабли
// репо (см. _SFC_LOGIC_SIGNALS).
const _THUNK_TAIL = "(?=\\s{0,10}[),\\]\\r\\n])";
// `() => Model` / `() => Model.Sub` — lazy type-reference (Lucid + TypeORM).
const _THUNK_TYPE_RE = new RegExp(
  "(?<=[(,\\[]\\s{0,20})\\(\\s{0,10}\\)\\s{0,10}=>\\s{0,10}[A-Za-z_$][\\w$]{0,80}(?:\\.[A-Za-z_$][\\w$]{0,80}){0,5}" +
    _THUNK_TAIL,
  "g",
);
// `(photo) => photo.user` / `photo => photo.user` / `(p: Photo) => p.user` —
// inverse-side accessor (TypeORM): тело — чистая property-цепочка без вызова.
const _THUNK_ACCESSOR_RE = new RegExp(
  "(?<=[(,\\[]\\s{0,20})\\(?\\s{0,10}[A-Za-z_$][\\w$]{0,60}(?:\\s{0,10}:\\s{0,10}[A-Za-z_$][\\w$.]{0,80}(?:<[\\w$,.\\s[\\]]{0,80}>)?)?\\s{0,10}\\)?\\s{0,10}=>\\s{0,10}[A-Za-z_$][\\w$]{0,60}(?:\\.[A-Za-z_$][\\w$]{0,60}){1,6}" +
    _THUNK_TAIL,
  "g",
);

const _MODEL_LOGIC_SIGNALS = [
  /=>/, // любая не-нейтрализованная стрелка (значения, serialize/prepare/onQuery)
  /\bfunction\b/,
  /\b(?:get|set)\s+[A-Za-z_$][\w$]{0,60}\s*\(/, // get fullName() / set locale()
  /@computed\b/,
  // Lucid hooks (@beforeSave/@afterFetch/…) + TypeORM listeners (@BeforeInsert/@AfterLoad/…).
  /@(?:[bB]efore|[aA]fter)[A-Z][A-Za-z]{0,40}\b/,
  /\bserializeExtras\b/,
  /\bscope\s*\(/, // Lucid query scope
  /\b(?:if|for|while|switch)\s*\(/,
  /\btry\s*\{/,
  /\b(?:await|async|throw|yield|return)\b/,
  /\bthis\b/,
  /\bnew\s+[A-Za-z_$]/,
  /\b(?:let|var)\s+[A-Za-z_$]/,
  /=\s{0,10}[A-Za-z_$][\w$.]{0,80}\s*\(/, // присваивание вызова: static x = f(…)
  // Тело метода: `)` + `{` через любой whitespace (переносы включительно).
  // Имя-агностично НАМЕРЕННО: ловит многострочные сигнатуры (Prettier-перенос
  // параметров), computed/unicode/#private-имена — в отличие от
  // `ident(args){`-формы (_SFC_LOGIC_SIGNALS), которую ревью обходило.
  // В чисто декларативной модели `){` не встречается: после `)` декоратора
  // идёт поле/декоратор, а у `class … {` перед скобкой нет `)`.
  /\)\s*\{/,
  /\bstatic\s*\{/, // static initialization block — исполняется при eval класса
  /\.(?:map|filter|reduce|reduceRight|forEach|find|findIndex|some|every|flatMap|sort)\s*\(/,
  /\$\{/, // template-интерполяция
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

// ────────────────────────────────────────────────────────────────────────────
// Презентационный SFC (Vue/Svelte/Astro): компонент без логики в <script>.
// Аналог isTypeOnlyTsFile — content-based skip. Консервативен: «презентационный»
// (skip) только при НУЛЕ сигналов логики; любое сомнение → логика → тест нужен.
// ────────────────────────────────────────────────────────────────────────────

// Достаёт «исходник логики» из SFC: содержимое всех <script>-блоков (Vue/Svelte)
// + Astro-frontmatter (между ведущими `---`).
function extractScriptSource(content) {
  const c = String(content || "");
  const parts = [];
  for (const m of c.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    parts.push(m[1]);
  }
  // Astro frontmatter: файл начинается с `---\n ... \n---`.
  const fm = c.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) parts.push(fm[1]);
  return parts.join("\n");
}

// Сигналы реальной логики в script-блоке. Любое совпадение → НЕ презентационный.
// Подобраны так, чтобы типовые аннотации (`onClick: () => void`) НЕ считались
// логикой — arrow ловим только в позиции значения/коллбэка (`= (..) =>`, `(() =>`).
//
// ВСЕ квантификаторы внутри скобочных групп ОГРАНИЧЕНЫ ({0,N}) — иначе на
// adversarial SFC (`=((`×N, `f((`×N в пределах 200KB-капа) `[^)]*` + `[\w$]*\s*\(`
// давали catastrophic backtracking O(N²): 60KB → 1.8s, 200KB → ~60s, вешая Stop-хук
// на каждом turn. Bounded-версии линейны (~301 симв./позиция максимум).
// `\n` в _ARG разрешён: Prettier переносит длинные списки параметров, а
// однострочная версия пропускала такие arrow-значения/коллбэки (ревью v1.9.4).
const _ARG = "[^)]{0,240}"; // тело списка аргументов: без `)`, с капом
const _SFC_LOGIC_SIGNALS = [
  // Vue Composition: реактивность / состояние / DI.
  /\b(?:ref|shallowRef|customRef|toRef|toRefs|reactive|shallowReactive|readonly|computed|watch|watchEffect|watchPostEffect|watchSyncEffect|effect|inject|provide)\s*\(/,
  // Vue Composition: lifecycle-хуки (берут коллбэк = логика).
  /\b(?:onMounted|onBeforeMount|onUnmounted|onBeforeUnmount|onUpdated|onBeforeUpdate|onActivated|onDeactivated|onErrorCaptured|onRenderTracked|onRenderTriggered)\s*\(/,
  // Options API: логические блоки + lifecycle/data-методы.
  /\b(?:methods|computed|watch)\s*:\s*\{/,
  /\b(?:data|created|mounted|beforeCreate|beforeMount|updated|beforeUpdate|destroyed|beforeDestroy|setup|render)\s*\(/,
  // function-объявление.
  /\bfunction\b/,
  // control-flow.
  /\b(?:if|for|while|switch)\s*\(/,
  /\btry\s*\{/,
  /\b(?:await|async|throw|yield)\b/,
  // data-transforms (итерация/трансформация коллекций).
  /\.(?:map|filter|reduce|reduceRight|forEach|find|findIndex|findLast|some|every|flatMap|sort)\s*\(/,
  // Тело метода / control-flow с телом: `)` + `{` через любой whitespace.
  // Имя-агностично (как в _MODEL_LOGIC_SIGNALS): ловит `data() {`,
  // `defineExpose({ focus() {} })`, многострочные сигнатуры и
  // computed/unicode-имена. В презентационном script `){` не встречается:
  // `defineProps({...})` даёт `({`/`})`, `withDefaults(x(), {...})` — `), {`,
  // а `) => {` объектного return-type режется стрелкой между `)` и `{`.
  /\)\s*\{/,
  /\bstatic\s*\{/, // static initialization block — исполняется при eval класса
  // arrow-функция как значение: `= (args) =>` / `= async (..) =>`.
  new RegExp(`=\\s*(?:async\\s+)?\\(${_ARG}\\)\\s*=>`),
  // arrow-функция как значение с одним параметром без скобок: `= x =>`.
  /=\s*(?:async\s+)?[A-Za-z_$][\w$]{0,60}\s*=>/,
  // arrow-коллбэк первым аргументом вызова: `(() => ..)` / `((args) => ..)`.
  new RegExp(`\\(\\s*(?:async\\s+)?\\(${_ARG}\\)\\s*=>`),
  // Svelte: реактивные statements `$:` и руны $state/$derived/$effect.
  /(?:^|\n)\s*\$:\s/,
  /\$(?:state|derived|effect)\s*\(/,
];

// Возвращает true, если SFC-контент презентационный (template/markup без логики
// в script). Базируется на <script> (Vue/Svelte) или frontmatter (Astro).
function isPresentationalSFC(content) {
  const src = extractScriptSource(content);
  if (!src.trim()) return true; // нет script → чистый template/markup
  // Стрипаем комментарии (как isTypeOnlyTsFile), чтобы закомментированный код
  // не считался логикой.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const re of _SFC_LOGIC_SIGNALS) if (re.test(stripped)) return false;
  return true;
}

// Правка релевантна мехчекам Stop-хука (D/E/F/A), только если файл (а) внутри
// repoRoot и (б) существует к моменту Stop. Throwaway-скрипты в /tmp и файлы,
// удалённые в ходе сессии, не требуют тестов — их больше нет в проекте
// (dogfooding-кейс v1.9.11: репро-скрипты сессии ложно триггерили D).
// Компромисс: «удалить перед Stop, вернуть после» формально обходит D — тот же
// документированный потолок teeth, что текстовый матч render-команд в M.
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
  // TS type-only. Пре-стрип посимвольным сканером нейтрализует квадратичный
  // lazy-regex стрипа `/* */` внутри isTypeOnlyTsFile на adversarial-входе.
  if (/\.(ts|tsx)$/i.test(fp) && isTypeOnlyTsFile(stripBlockComments(body)))
    return true;
  // Декларативная ORM-модель (Lucid/TypeORM): только колонки/relations —
  // тестировать нечего; любой сигнал логики внутри → НЕ skip, тест обязателен.
  if (/\.(ts|js)$/i.test(fp) && isDeclarativeModelFile(body)) return true;
  // Презентационный SFC (Vue/Svelte/Astro): template/markup без логики в script.
  if (/\.(vue|svelte|astro)$/i.test(fp) && isPresentationalSFC(body))
    return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Триггер M: render-verify для фронт-правок
// ────────────────────────────────────────────────────────────────────────────

// Render-класс верификация: то, что реально открывает страницу — headless
// browser / curl|wget по localhost (активный браузер-MCP трекается отдельно
// в verify-changes.js по имени tool_use). Unit-раннеры (vitest/jest, jsdom)
// сюда НАМЕРЕННО не входят — jsdom не рендерит (нет layout-движка). Внешний
// `https?://`-curl — тоже нет: продовый URL не проверяет локальную правку.
// `\n` исключён из curl/wget-квантификаторов: иначе многострочная команда со
// словом «localhost» в ДРУГОЙ строке (echo/коммент) ложно засчиталась бы
// рендером. Квантификаторы ограничены ({0,300}) против квадратичного
// backtracking-а на adversarial-команде из множества anchor-токенов.
function isRenderVerifyCmd(cmd) {
  const c = String(cmd || "");
  return (
    /\bcurl\b[^|;&\n]{0,300}(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(c) ||
    /\bwget\b[^|;&\n]{0,300}(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(c) ||
    /\b(playwright|puppeteer)\b[^\n]{0,300}\b(test|run|open|screenshot|goto|click)/i.test(
      c,
    ) ||
    /chrom(e|ium)[^\n]{0,300}--headless/i.test(c) ||
    /\bnpx\s+playwright\s+(test|open|screenshot)/i.test(c) ||
    // cypress — реальный браузерный рендер; E/reasonE легитимизируют его как
    // e2e-стек, значит и M обязан засчитывать (иначе внутренняя нестыковка).
    /\bcypress\s+(run|open)\b/i.test(c) ||
    // Vitest Browser Mode — реальный браузер через playwright-provider;
    // testing-strategy.md рекомендует его для UI-компонентов, значит M обязан
    // засчитывать. Голый `vitest run` (jsdom) рендером НЕ считается.
    /\bvitest\b[^\n]{0,300}--browser/i.test(c)
  );
}

// Посимвольный однопроходный стрип комментариев — O(n) гарантированно.
// НЕ заменять regex-ом: и lazy `[\s\S]*?`, и unrolled-альтернация квадратичны
// на adversarial-входе из множества незакрытых `/*` (документированные грабли).
// State-machine различает `//`-комментарии и строки (' " `): иначе `/*` внутри
// line-comment-а (`// paths like /api/*`) или строкового литерала открывал бы
// «блок» и съедал файл до EOF вместе с кодом-дисквалификатором — обход
// type-only exempt в триггере M. Mis-parse экзотики (regex-литералы) оставляет
// мусор в выводе → детекторы дают «не exempt» — fail toward требования.
function stripBlockComments(src) {
  const s = String(src || "");
  const out = [];
  let state = "code"; // code | block | line | str
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (state === "block") {
      if (ch === "*" && s[i + 1] === "/") {
        state = "code";
        i++;
      }
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out.push(ch); // перенос сохраняем — построчные проверки живут
      }
      continue;
    }
    if (state === "str") {
      out.push(ch);
      if (ch === "\\") {
        if (i + 1 < s.length) out.push(s[++i]); // escape — копируем как есть
        continue;
      }
      if (ch === quote || (quote !== "`" && ch === "\n")) state = "code";
      continue;
    }
    // state === "code"
    if (ch === "/" && s[i + 1] === "*") {
      state = "block";
      i++;
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") {
      state = "line";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      state = "str";
      quote = ch;
      out.push(ch);
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

// Безопасное чтение файла проекта по пути из транскрипта: symlink-resolve,
// confinement под repoRoot (как hardening transcript_path в verify-changes.js),
// только regular file, size-cap. null при любой аномалии — решает вызывающий
// (exempt-детект трактует null как «не exempt», mutating-детект — как «нет сигнала»).
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

// Token-only stylesheet: только дизайн-токены (custom properties / SCSS-vars /
// @import-статементы) — нечего рендерить. Консервативно: любая строка вне
// допустимого набора → НЕ token-only (fail toward требования рендера).
function isTokenOnlyCss(content) {
  const stripped = stripBlockComments(content);
  const lines = stripped.split("\n");
  const allowed = [
    /^\s*$/,
    /^\s*\/\/.*$/, // однострочный комментарий (SCSS/LESS)
    /^\s*(:root|html)[\s,.:\w[\]="'-]{0,200}\{?\s*$/i, // селектор токен-скоупа (+attr: [data-theme="dark"])
    /^\s*@(media|supports)\b[^{}]{0,300}\{\s*$/i, // dark-mode обёртка вокруг :root
    /^\s*\}\s*;?\s*$/,
    /^\s*--[\w-]+\s*:[^;{}]*;?\s*$/, // CSS custom property
    /^\s*\$[\w-]+\s*:[^;{}]*;?\s*$/, // SCSS variable
    /^\s*@(import|use|forward|charset|layer)\b[^{}]*;?\s*$/i,
    /^\s*@[\w-]+\s*:[^;{}]*;?\s*$/, // LESS variable (`@brand: #f00;`)
  ];
  const tokenLine =
    /^\s*(--[\w-]+|\$[\w-]+|@(?!(import|use|forward|charset|layer)\b)[\w-]+)\s*:/;
  let sawToken = false;
  for (const line of lines) {
    // ReDoS-guard: в allowed есть смежные квантификаторы — квадратичны на
    // длинной adversarial-строке. Легитимные токен-строки короткие →
    // длинная строка = не token-only (fail toward требования рендера).
    if (line.length > 500) return false;
    if (!allowed.some((re) => re.test(line))) return false;
    if (tokenLine.test(line)) sawToken = true;
  }
  return sawToken; // пустой/структурный файл без единого токена — не exempt
}

// Файл, правка которого не требует render-проверки. Fail toward требования:
// нечитаемый / не-файл / вне repoRoot / >200KB → НЕ exempt. Презентационные
// SFC и .html НАМЕРЕННО не exempt — визуал именно там.
function isRenderExemptFrontendFile(fp, repoRoot) {
  const f = String(fp || "");
  const body = readRepoFileSafe(f, repoRoot);
  if (body == null) return false;
  const head = body.split("\n").slice(0, 10).join("\n");
  if (GENERATED_HEADER_RE.test(head)) return true;
  // Type-only .tsx/.jsx (интерфейсы/типы без рендерящего кода). Предварительный
  // посимвольный стрип гасит ReDoS-паттерн внутри isTypeOnlyTsFile на
  // adversarial-входе из незакрытых `/*` (сканер убирает их до regex-а).
  if (/\.(tsx|jsx)$/i.test(f))
    return isTypeOnlyTsFile(stripBlockComments(body));
  if (/\.(css|scss|sass|less|styl|stylus)$/i.test(f))
    return isTokenOnlyCss(body);
  return false;
}

// Контент-сигнал мутирующего endpoint-а — дополнение к path-детекту
// isCriticalEndpoint (CAVEAT бэклога: детект только по имени пути пропускает
// неназванные мутации — /users/:id destroy, /orders POST). Bounded substring-
// якоря по телу controller/route-файла (комментарии предварительно стрипнуты).
// False positive → лишний endpoint-тест (безвредно); false negative →
// остаётся D-парный тест.
const MUTATING_HANDLER_RES = [
  /\bexport\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/, // Next.js app router
  /\.(post|put|patch|delete)\s*\(\s*["'`/]/i, // Express/Fastify/Koa/Adonis router.post('/x')
  /@(Post|Put|Patch|Delete)\s*\(/, // NestJS
  /\bdef\s+(create|update|destroy)\b/, // Rails resource actions
  /\bpublic\s+function\s+(store|update|destroy)\b/i, // Laravel
  /\basync\s+(store|update|destroy)\s*\(/, // AdonisJS resource-методы
];

function hasMutatingHandler(fp, repoRoot) {
  const body = readRepoFileSafe(fp, repoRoot);
  if (body == null) return false; // нечитаемо → сигнала нет; решает path-детект
  const stripped = stripBlockComments(body);
  return MUTATING_HANDLER_RES.some((re) => re.test(stripped));
}

// ────────────────────────────────────────────────────────────────────────────
// Триггер D: поиск парного test-файла
// ────────────────────────────────────────────────────────────────────────────

// Директории, где лежат тесты бизнес-логики, ходящие в реальную БД/сервисы
// (AdonisJS/Japa `tests/functional/`, общая `tests/integration/`). Это валидный
// парный тест логики (не browser-e2e) — поэтому набор шарится между триггером D
// (парный тест) и E (e2e/functional). E дополнительно знает чисто-браузерные
// дир-ы (e2e/, cypress/, playwright/), которые в D намеренно НЕ входят: совпадение
// basename с браузерным e2e не доказывает покрытие логики файла.
const SHARED_LOGIC_TEST_DIRS = [
  ["tests", "functional"],
  ["tests", "integration"],
];

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
        // same-dir tests|test подкаталог (node:test-конвенция src/tests/x.test.ts).
        // Суффикс обязателен: файл без .test/.spec в tests/ — хелпер, не доказательство
        // (в __tests__/ выше суффикс не нужен — там Jest testMatch считает тестом всё).
        path.join(dir, "tests", `${base}.test${tExt}`),
        path.join(dir, "tests", `${base}.spec${tExt}`),
        path.join(dir, "test", `${base}.test${tExt}`),
        path.join(dir, "test", `${base}.spec${tExt}`),
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
    // tests/functional, tests/integration — DB-hitting логика-тесты (Adonis/Japa).
    for (const segs of SHARED_LOGIC_TEST_DIRS) {
      candidates.push(
        path.join(...segs, `${base}.test${gExt}`),
        path.join(...segs, `${base}.spec${gExt}`),
      );
    }
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
// Триггер D, fallback: централизованные спеки, именованные по фиче.
// Кейс ERP_NEW: код покрыт tests/unit/auth_cookies.spec.ts (имя по фиче, не по
// источнику) → findPairedTestFile его не видит → Claude выписывает каталожные
// ignore-глобы. Второй шанс: grep импортов источника по спекам центральных
// тест-дир пакета. False positive (спек импортирует, но не ассертит) —
// осознанно приемлем: лучше, чем толкать к широким глобам / VERIFY_CHANGES=0.
// ────────────────────────────────────────────────────────────────────────────

const CENTRAL_TEST_DIR_NAMES = ["tests", "test", "spec", "specs", "__tests__"];
// Капы I/O-DoS: filesRead — на чтение СОДЕРЖИМОГО спеков (общий на прогон),
// MAX_LIST — на длину списка кандидатов, MAX_VISITED — на просмотренные
// readdir-entries (иначе дерево из тысяч не-спековых файлов walk-ается целиком).
const IMPORT_SCAN_MAX_FILES = 200;
const IMPORT_SCAN_MAX_LIST = 400;
const IMPORT_SCAN_MAX_VISITED = 20_000;

// Лимит чтений конфигурируем per-project (монорепы с сотнями центральных
// спеков): MAIN_SKILL_IMPORT_SCAN_MAX_FILES. Мусор/≤0 → дефолт; кап 10000 —
// защита от опечатки (200KB-кап на файл остаётся вторым эшелоном).
function importScanMaxFiles() {
  const raw = parseInt(process.env.MAIN_SKILL_IMPORT_SCAN_MAX_FILES, 10);
  if (!Number.isFinite(raw) || raw <= 0) return IMPORT_SCAN_MAX_FILES;
  return Math.min(raw, 10_000);
}

// Дир-ы, куда walk не спускается — деривативы/vendored. Общий для import-scan
// и walkCarrierFiles в audit-ignore-globs.js (раздельные копии дрейфуют).
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

// Строки, где упоминание модуля доказывает статический линк спек→источник:
// import/require/from (JS/TS/Python/Java/Ruby) + jest.mock/vi.mock/vi.doMock.
// `require_relative` отдельно: `\brequire\b` не матчит из-за `_` (word char).
const IMPORT_LINE_RE = /\b(?:import|require(?:_relative)?|from)\b|mock\s*\(/i;

// Имена, бессмысленные как матч-таргет сами по себе: почти любой спек
// импортирует какой-нибудь `../index` → массовый false positive, D замолчал бы
// на непокрытых barrel-файлах. Матчим по имени родительской диры (`cart` /
// `cart/index`); родитель тоже generic (src/index.ts) → скан не применяем.
const GENERIC_BASENAME_RE = /^(index|route|handler|main|mod)$/i;
const GENERIC_PARENT_RE = /^(\.?|src|lib|app|sources?|dist|build)$/i;

// Набор bounded-регексов для матча импорта источника в тексте import-строк.
// Basename/parent эскейпятся (недоверенный ввод из транскрипта → литерал) и
// капятся по длине: без капа фейковый file_path на десятки KB из транскрипта
// ронял бы new RegExp («too large») → exception → весь Stop-хук fail-open.
// Все квантификаторы ограничены по конвенции репо.
//
// У файла с содержательным родителем (app/billing/db.ts) ПУТЁВЫЙ импорт обязан
// нести родительский сегмент (`billing/db`, `billing.db`) — иначе одноимённый
// файл чужого модуля (app/auth/db.ts) ложно засчитывался бы спеком про billing.
// Голый импорт имени ('db', '#step_up') принимается: алиас может прятать путь.
function buildImportMatchRes(srcPath) {
  const ext = path.extname(srcPath);
  const base = path.basename(srcPath, ext);
  if (!base || base.length > 200) return null;
  const parentRaw = path.basename(path.dirname(srcPath));
  const parent = parentRaw && parentRaw.length <= 200 ? parentRaw : "";
  const extPat = "(?:\\.[A-Za-z]{1,7})?"; // опц. расширение перед кавычкой
  if (GENERIC_BASENAME_RE.test(base)) {
    // index/route/... сами по себе не идентифицируют модуль — матчим родителя
    // (`cart` / `cart/index`); родитель тоже generic (src/index.ts) → скана нет.
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
      // путёвый кавычечный: '../../app/billing/db' | '#controllers/auth_controller'
      new RegExp(`['"\`#/]${parentPat}/${basePat}${extPat}['"\`]`, "i"),
      // голый кавычечный (без '/'): 'auth_controller' | `#step_up` | "db"
      new RegExp(`['"\`#]${basePat}${extPat}['"\`]`, "i"),
      // dotted-путь: Python `from app.billing.db import x`, Java `import com.app.billing.Db;`
      new RegExp(`\\b${parentPat}\\.${basePat}\\b`, "i"),
      // Python `from app.billing import db` (имя ПОСЛЕ import, списком в т.ч.)
      new RegExp(
        `\\b${parentPat}\\s{1,40}import\\s{1,40}[\\w.,\\s]{0,200}\\b${basePat}\\b`,
        "i",
      ),
    ];
  }
  return [
    // generic/корневой родитель: путь не проверить — кавычечный матч имени…
    new RegExp(`['"\`#/]${basePat}${extPat}['"\`]`, "i"),
    // …и бескавычечный import-стейтмент (Python/Java), включая `from src import utils`
    new RegExp(
      `^\\s{0,40}(?:from|import)\\s[\\w.,\\s]{0,300}\\b${basePat}\\b`,
      "im",
    ),
  ];
}

// Walk центральных тест-дир от root: <root>/tests|test|spec|specs|__tests__.
// Берём только файлы, чьё ИМЯ само по себе спековое (isTestFile по basename:
// *.spec.* / *.test.* / test_*.py / *_test.go / XxxTest.java) — хелперы,
// фикстуры и setup.ts внутри tests/ линк не доказывают. Симлинки не следуем
// (Dirent.isFile()=false), сортировка — детерминизм порядка матча.
// Возвращает {files, truncated}. truncated=true — обход прерван капом (maxList
// или MAX_VISITED) при непройденных entries, т.е. список кандидатов может быть
// неполон; без флага «дочитали список целиком» неотличимо от «обрезали ровно
// по бюджету» (ревью-регресс: при env-cap ≥ 400 maxList == бюджету чтений, и
// цикл чтения в Inner завершается штатно, не увидев обрыва). FP «капы выбраны
// последним entry» безвреден: лишняя ⚠-приписка «не подтверждено» — честна.
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

// Порядок чтения спеков — по релевантности к источнику, не по алфавиту:
// early-exit на первом матче есть, значит покрытый файл находится за единицы
// чтений вместо сотен, и кэп чтений перестаёт отрезать алфавитно-хвостовые
// покрывающие спеки (баг-репорт: пакет >200 спеков → ложный D). Сигналы
// грубые намеренно — ошибка скоринга меняет лишь порядок чтения, не результат:
// имя источника в basename спека (+4; для generic index/route/... — имя
// родителя, как в buildImportMatchRes), родительский сегмент в пути спека
// (+2), токен basename в имени спека (+1). Гейт длины ≥3 — короткие имена
// (db) дают шумные подстрочные матчи; кап длины ≤200 на base/parent зеркалит
// buildImportMatchRes (srcPath из транскрипта недоверен — мегабайтный сегмент
// не должен гоняться по скорингу). Tie → исходный (алфавитный) порядок, вход
// не мутируется; стоимость — includes по списку кандидатов (≤ бюджета, до 10k).
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
    // сплит по обоим сепараторам: юнит-тесты передают POSIX-литералы, прод —
    // нативные пути из path.join; path.basename выше понимает оба сам
    if (parent.length >= 3 && lower.split(/[\\/]/).includes(parent)) score += 2;
    for (const t of tokens) if (specBase.includes(t)) score += 1;
    return { f, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.f);
}

// Контент спека → только import-строки (предфильтр IMPORT_LINE_RE): срезает
// объём матчинга и отсекает упоминания в assert-литералах / test-описаниях.
// Чтение через readRepoFileSafe (realpath + confinement + 200KB-кап).
function specImportLines(absSpec, repoRoot) {
  const body = readRepoFileSafe(absSpec, repoRoot);
  if (body == null) return "";
  return body
    .split("\n")
    .filter((l) => l.length <= 1000 && IMPORT_LINE_RE.test(l))
    .join("\n");
}

// Fallback триггера D: прямой парный тест не найден → ищем спек центральных
// тест-дир, импортирующий источник. `cache` шарится между вызовами одного
// прогона хука (один скан на Stop, не пер-файл): rootFiles — списки спеков по
// package-root, importLines — import-строки по спеку, filesRead — общий бюджет
// чтений (≤ IMPORT_SCAN_MAX_FILES; исчерпан → null, D сработает как раньше —
// fail toward требования теста). Любой exception → null по той же причине:
// улети он выше — уронил бы весь Stop-хук в fail-open. Roots сортируются
// ближайший-пакет-первым (по глубине пути; insertion-order Set-а из
// findPackageRoots этого НЕ гарантирует): пакетный tests/ релевантнее
// монорепного root-tests/ и дешевле по бюджету.
//
// cache.lastTruncated — сигнал ПОСЛЕДНЕГО вызова (сбрасывается на входе):
// true = хотя бы раз упёрлись в бюджет чтений. Осмыслен при null-результате —
// различает «дочитал список, матча нет» (честный D) от «обрезан, покрытие не
// подтверждено» (reasonD дополняется grep-рецептом и ручкой лимита).
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

  // Кандидатов в списки собираем не меньше лимита чтений: поднятая env-ручка
  // без масштабирования maxList упёрлась бы в кап списка, а не бюджета.
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
    // обрезание СПИСКА кандидатов — тоже обрыв: непопавший в список спек
    // непроверяем, «теста нет» не доказано (даже если бюджет чтений не выбран)
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

// ────────────────────────────────────────────────────────────────────────────
// Триггер E: e2e/functional парный
// ────────────────────────────────────────────────────────────────────────────

function findE2eFile(srcPath, repoRoot, sessionEditedFiles = new Set()) {
  const ext = path.extname(srcPath);
  const baseFull = path.basename(srcPath, ext);
  const baseStripped = baseFull.replace(/_controller$|Controller$/, "");
  // Ищем по обоим именам — ресурсному (`auth` ← auth_controller) и полному
  // (`auth_controller`): конвенции именования endpoint-тестов в проектах разные.
  const bases =
    baseStripped === baseFull ? [baseFull] : [baseStripped, baseFull];
  // Directory-based роутинг (Next.js App Router / Nuxt / SvelteKit):
  // app/api/auth/login/route.ts — имя ресурса живёт в родительской директории,
  // basename бесполезен (`route`). Ищем тест и по имени родителя (`login`).
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
      // functional/integration — общий с триггером D набор логика-тест-дир.
      for (const segs of SHARED_LOGIC_TEST_DIRS) {
        candidates.push(
          path.join(...segs, `${base}.spec${e}`),
          path.join(...segs, `${base}.test${e}`),
        );
      }
      // e2e-специфичные дир-ы — только здесь, в D намеренно не входят.
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
    const escaped = escapeRegExp(entry.test_name);
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

// Имена сабагент-инструментов: в разных сборках Claude Code диспатч сабагента
// экспонирован как Task ИЛИ Agent (в Agent-окружении Task отсутствует вовсе).
const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

// Собирает все сабагент-вызовы (Task/Agent) из транскрипта и категоризирует по
// типу review. Возвращает { code: bool, security: bool }.
function findReviewAgentCalls(lines) {
  let code = false;
  let security = false;
  for (const e of lines || []) {
    if (e.type !== "assistant") continue;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== "tool_use" || !SUBAGENT_TOOL_NAMES.has(b.name))
        continue;
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
// Триггер L: парсеры manifest-форматов + сбор version-lookup-ов из transcript
// ────────────────────────────────────────────────────────────────────────────

// Топ-уровневые поля package.json — НЕ являются dependency-ями. Используется
// для фильтрации при regex-парсинге фрагментов (когда JSON.parse целиком не
// проходит).
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
  // Fragment fallback — regex pass.
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
        // docker pull image:tag — эффективно проверяет существование тэга в registry,
        // считаем как lookup. Тэг отбрасываем, ключ — только image-name.
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

// ReDoS-safe: один `(?:\.0)*` вместо `(\.0)*(\.0)*` — двойная звезда давала
// catastrophic backtracking O(N²) на хитро подобранной строке `>=0` + `.0`*N + хвост.
// Семантически эквивалентно: матчит `>=0`, `>=0.0`, `>=0.0.0`, `>=0.0.0.0`...
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
    // Cross-type fallback: docker image и runtime — это часто один и тот же
    // продукт. Lookup на endoflife.date/api/nodejs покрывает и `runtime/node`
    // (.nvmrc), и `docker/node` (FROM node:18). И наоборот: docker manifest
    // inspect node:18 покрывает и runtime/node.
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
  isCriticalEndpoint,
  CRITICAL_ENDPOINT_RE,
  isRenderVerifyCmd,
  isRenderExemptFrontendFile,
  hasMutatingHandler,
  readRepoFileSafe,
  stripBlockComments,
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
  // J / K
  hasSecuritySensitivePath,
  countNonTrivialDiffLines,
  findReviewAgentCalls,
  parseSelfReview,
  parseReviewTriage,
  validateReviewTriage,
  SECURITY_SENSITIVE_RE,
  // L: dep version-lookup enforcement
  parseManifestDeps,
  findVersionLookups,
  getDepsWithoutLookup,
  collectManifestDepsFromEdits,
};
