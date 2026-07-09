#!/usr/bin/env node
"use strict";

// CLI + модуль: аудит MAIN_SKILL_VERIFY_IGNORE_GLOBS в проекте. Ищет, где
// переменная реально задана (carrier-файлы проекта: .env* / .claude/settings*.json
// / .mcp.json / *.sh; home-конфиги; текущее окружение), классифицирует каждый глоб
// узкий/широкий через ту же isBroadIgnoreGlob, что и PreToolUse-гард, и печатает
// отчёт с широкими глобами (глушат Stop-триггер D по целым папкам/языкам) для
// последующего сужения. Стоит за слэш-командой /main-skill:check-ignore-globs.
//
// Standalone: node hooks/lib/audit-ignore-globs.js [dir]
//
// Логика «широты» НЕ дублируется — переиспользует isBroadIgnoreGlob (checks.js);
// поиск присваиваний / carrier-детект / sanitize — из ignore-glob-guard.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { isBroadIgnoreGlob } = require("./checks");
const {
  isEnvCarrierFile,
  extractIgnoreGlobs,
  sanitizeGlob,
} = require("../ignore-glob-guard");

const VAR = "MAIN_SKILL_VERIFY_IGNORE_GLOBS";
// Паритет с ignore-glob-guard.safeReadFile (5MB): меньший cap создал бы слепую
// зону — carrier-файл 2–5MB с широким глобом гард бы отклонил при записи, а этот
// ретро-аудит молча пропустил (ровно та дыра, которую он призван закрывать).
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Дир-ы, куда не спускаемся при walk — деривативы/vendored, там carrier-файлы
// либо не наши (node_modules/.env пакета), либо не про этот проект.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  "coverage",
  ".cache",
  ".uploads",
  ".venv",
  "venv",
  "__pycache__",
]);

// Home-level carrier-файлы: глоб, заданный тут, действует на ВСЕ проекты.
// Намеренно ПОДмножество isEnvCarrierFile: без `~/.mcp.json` (MCP-конфиг не ставит
// эту env) и без generic `~/*.sh` (полный walk $HOME недопустим) — только
// стандартные места, где юзер реально экспортит переменную (Claude settings + shell-rc).
const HOME_CARRIERS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".zshrc",
  ".bashrc",
  ".zshenv",
  ".zprofile",
  ".bash_profile",
  ".profile",
  ".envrc",
];

function safeRead(fp) {
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(fp, "utf8");
  } catch {
    return "";
  }
}

function existsSafe(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Человеко-читаемое «почему широкий» — cosmetic-объяснение для отчёта. Ветвление
// зеркалит isBroadIgnoreGlob (каталог-глоб vs один-расширение), но само решение
// broad/narrow остаётся за isBroadIgnoreGlob — здесь только формулировка.
function describeBroad(glob) {
  const g = String(glob || "")
    .trim()
    .replace(/\/+$/, "");
  const segs = g.split("/");
  const last = segs.pop();
  const rest = last.replace(/^[*?]+/, ""); // снять ведущий wildcard-ран
  const dirPart = segs.join("/");
  if (rest === "") {
    return dirPart ? `весь каталог ${dirPart}/` : "всё дерево репозитория";
  }
  return `весь язык/расширение (${rest})`;
}

// Разносит все глобы источников на broad/narrow. sanitize — очистка глоба перед
// эхом в отчёт (глоб недоверенный: читается из файла). Возвращает
// { broad: [{label, glob, why}], narrow: [{label, glob}] }.
function classifySources(sources, sanitize = (s) => s) {
  const broad = [];
  const narrow = [];
  for (const src of sources || []) {
    // label (имя файла) недоверенно — эхо-ится в отчёт; sanitize перед выводом.
    const label = sanitize(src.label);
    for (const glob of src.globs || []) {
      const shown = sanitize(glob);
      // classification — на RAW glob (как в гарде); why строим из УЖЕ sanitized
      // shown, а не из raw glob: describeBroad эхо-ит dir-часть в терминал, сырой
      // control-char протёк бы в обход sanitizeGlob (terminal-injection).
      if (isBroadIgnoreGlob(glob)) {
        broad.push({ label, glob: shown, why: describeBroad(shown) });
      } else {
        narrow.push({ label, glob: shown });
      }
    }
  }
  return { broad, narrow };
}

// Рекурсивно собирает carrier-файлы под rootDir (пропуская SKIP_DIRS и уходя не
// глубже maxDepth). Возвращает массив абсолютных путей.
function walkCarrierFiles(rootDir, opts = {}) {
  const maxDepth = opts.maxDepth ?? 8;
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && isEnvCarrierFile(full)) {
        out.push(full);
      }
    }
  }
  walk(rootDir, 0);
  return out;
}

// Собирает источники, где задан VAR: env → project carrier-файлы → home carrier-файлы.
// Возвращает [{label, globs, home?}] только для источников с ≥1 глобом.
function collectSources(opts = {}) {
  const {
    rootDir = null,
    env = {},
    homeDir = null,
    readFile = safeRead,
    walk = walkCarrierFiles,
  } = opts;
  const sources = [];

  // 1. Текущее окружение (эффективное значение, действующее в рантайме).
  const envVal = env[VAR];
  if (typeof envVal === "string") {
    const globs = envVal
      .split(":")
      .map((s) => s.trim())
      .filter(Boolean);
    if (globs.length) sources.push({ label: "окружение (env)", globs });
  }

  // 2. Carrier-файлы проекта.
  if (rootDir) {
    for (const f of walk(rootDir)) {
      const globs = extractIgnoreGlobs(readFile(f));
      if (globs.length)
        sources.push({ label: path.relative(rootDir, f) || f, globs });
    }
  }

  // 3. Home-level carrier-файлы (действуют на все проекты).
  if (homeDir) {
    for (const rel of HOME_CARRIERS) {
      const globs = extractIgnoreGlobs(readFile(path.join(homeDir, rel)));
      if (globs.length) sources.push({ label: "~/" + rel, globs, home: true });
    }
  }

  return sources;
}

// Группировка элементов отчёта по label с сохранением порядка появления.
function groupByLabel(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.label)) map.set(it.label, []);
    map.get(it.label).push(it);
  }
  return map;
}

function formatReport(sources, rootDir, sanitize = (s) => s) {
  const { broad, narrow } = classifySources(sources, sanitize);
  const L = [];
  L.push(`main-skill: аудит ${VAR}`);
  if (rootDir) L.push(`корень: ${rootDir}`);
  L.push("");

  if (!broad.length && !narrow.length) {
    L.push(`${VAR} нигде не задан — сужать нечего.`);
    return L.join("\n");
  }

  if (broad.length) {
    L.push(
      "⚠ ШИРОКИЕ глобы (глушат Stop-триггер D по целым папкам/языкам) — сузь:",
    );
    for (const [label, items] of groupByLabel(broad)) {
      L.push(`  [${label}]`);
      for (const it of items) L.push(`    ${it.glob}   — ${it.why}`);
    }
    L.push("");
  }

  if (narrow.length) {
    L.push("✓ узкие глобы (ок, литеральный якорь):");
    for (const [label, items] of groupByLabel(narrow)) {
      L.push(`  [${label}]`);
      for (const it of items) L.push(`    ${it.glob}`);
    }
    L.push("");
  }

  L.push(`итого: ${broad.length} широких, ${narrow.length} узких.`);
  if (broad.length) {
    L.push(
      "сузь широкие до имени/расширения нетестируемых файлов; если весь репо на",
    );
    L.push(
      "централизованных тестах — вместо глоба на всю папку ставь MAIN_SKILL_VERIFY_CHANGES=0.",
    );
  }
  return L.join("\n");
}

function run(argv, env, homeDir) {
  const rootDir = argv && argv[2] ? path.resolve(argv[2]) : process.cwd();
  // Опечатка в пути дала бы тот же «нигде не задан», что и чистый проект — различаем.
  if (!existsSafe(rootDir)) {
    return `main-skill: аудит ${VAR}\nпуть не найден: ${sanitizeGlob(rootDir)}`;
  }
  const sources = collectSources({ rootDir, env, homeDir });
  return formatReport(sources, rootDir, sanitizeGlob);
}

if (require.main === module) {
  process.stdout.write(run(process.argv, process.env, os.homedir()) + "\n");
}

module.exports = {
  describeBroad,
  classifySources,
  walkCarrierFiles,
  collectSources,
  formatReport,
  run,
  sanitizeGlob,
};
