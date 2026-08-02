#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { isBroadIgnoreGlob, WALK_SKIP_DIRS } = require("./checks");
const {
  isEnvCarrierFile,
  extractIgnoreGlobs,
  sanitizeGlob,
} = require("../ignore-glob-guard");

const VAR = "MAIN_SKILL_VERIFY_IGNORE_GLOBS";
// Не менять, потому что cap обязан совпадать с ignore-glob-guard.safeReadFile:
// меньший даёт слепую зону — гард отклонит глоб при записи, а аудит его не найдёт.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Не менять, потому что набор общий с import-scan триггера D: своя копия дрейфует.
const SKIP_DIRS = WALK_SKIP_DIRS;

// Не менять, потому что список намеренно уже isEnvCarrierFile: generic `~/*.sh`
// означал бы полный walk $HOME.
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

// Не менять, потому что здесь только формулировка: решение broad/narrow принимает
// isBroadIgnoreGlob, вторая его копия разъедется с гардом.
function describeBroad(glob) {
  const g = String(glob || "")
    .trim()
    .replace(/\/+$/, "");
  const segs = g.split("/");
  const last = segs.pop();
  const rest = last.replace(/^[*?]+/, "");
  const dirPart = segs.join("/");
  if (rest === "") {
    return dirPart ? `весь каталог ${dirPart}/` : "всё дерево репозитория";
  }
  return `весь язык/расширение (${rest})`;
}

function classifySources(sources, sanitize = (s) => s) {
  const broad = [];
  const narrow = [];
  for (const src of sources || []) {
    const label = sanitize(src.label);
    for (const glob of src.globs || []) {
      const shown = sanitize(glob);
      // Не менять, потому что why строится из sanitized shown, а не из raw glob:
      // describeBroad эхо-ит dir-часть в терминал в обход sanitizeGlob.
      if (isBroadIgnoreGlob(glob)) {
        broad.push({ label, glob: shown, why: describeBroad(shown) });
      } else {
        narrow.push({ label, glob: shown });
      }
    }
  }
  return { broad, narrow };
}

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

function collectSources(opts = {}) {
  const {
    rootDir = null,
    env = {},
    homeDir = null,
    readFile = safeRead,
    walk = walkCarrierFiles,
  } = opts;
  const sources = [];

  const envVal = env[VAR];
  if (typeof envVal === "string") {
    const globs = envVal
      .split(":")
      .map((s) => s.trim())
      .filter(Boolean);
    if (globs.length) sources.push({ label: "окружение (env)", globs });
  }

  if (rootDir) {
    for (const f of walk(rootDir)) {
      const globs = extractIgnoreGlobs(readFile(f));
      if (globs.length)
        sources.push({ label: path.relative(rootDir, f) || f, globs });
    }
  }

  if (homeDir) {
    for (const rel of HOME_CARRIERS) {
      const globs = extractIgnoreGlobs(readFile(path.join(homeDir, rel)));
      if (globs.length) sources.push({ label: "~/" + rel, globs, home: true });
    }
  }

  return sources;
}

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
      "сузь широкие до имени/расширения нетестируемых файлов. Репо на централизованных",
    );
    L.push(
      "тестах — глоб не нужен: триггер D засчитывает центральный спек, импортирующий файл",
    );
    L.push(
      "(пакет на сотни спеков → подними бюджет: MAIN_SKILL_IMPORT_SCAN_MAX_FILES);",
    );
    L.push(
      "спеки вовсе не импортируют исходники → MAIN_SKILL_VERIFY_CHANGES=0 вместо глоба.",
    );
  }
  return L.join("\n");
}

function run(argv, env, homeDir) {
  const rootDir = argv && argv[2] ? path.resolve(argv[2]) : process.cwd();
  // Не менять, потому что без этой ветки опечатка в пути неотличима от чистого
  // проекта — обе дают «нигде не задан».
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
