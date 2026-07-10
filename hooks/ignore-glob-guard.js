#!/usr/bin/env node
"use strict";

// PreToolUse-хук: гард против ШИРОКОГО MAIN_SKILL_VERIFY_IGNORE_GLOBS. Когда
// Claude пишет в env-carrier-файл (.env / .claude/settings.json / *.sh / rc) или
// в Bash-команду присваивание MAIN_SKILL_VERIFY_IGNORE_GLOBS с каталог-глобом
// (`dir/**`, `**/scripts/**`), возвращает permissionDecision:deny с требованием
// сузить. Широкий глоб глушит триггер D и для тестируемой логики в той же папке.
// Дизайн, инварианты и known-gap — в CLAUDE.md «PreToolUse ignore-glob-guard».
//
// Env: MAIN_SKILL_IGNORE_GLOB_CHECK=0 — выкл.

const fs = require("fs");
const path = require("path");
const { isBroadIgnoreGlob } = require("./lib/checks");
const { isDisabled } = require("./lib/session-disabled");

const VAR = "MAIN_SKILL_VERIFY_IGNORE_GLOBS";
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// env-carrier-файлы, где IGNORE_GLOBS реально СТАВИТСЯ как рантайм-переменная.
// Гардим только их, чтобы не бить по докам (.md с примером — в т.ч. под .claude/,
// напр. commands/*.md) и по исходникам плагина (verify-changes.js с пример-строкой).
// Match по lower-case basename — регистр не значим (dotfiles всегда lowercase).
function isEnvCarrierFile(fp) {
  if (typeof fp !== "string") return false;
  const base = path.basename(fp.replace(/\\/g, "/")).toLowerCase();
  if (/^\.env(\.[\w.-]+)?$/.test(base)) return true; // .env, .env.local, .env.production
  // shell rc / profile (bash + zsh, включая .zshenv / .zprofile) + direnv.
  if (
    /^\.(bashrc|zshrc|zshenv|bash_profile|zprofile|profile|envrc)$/.test(base)
  )
    return true;
  if (base === "settings.json" || base === "settings.local.json") return true;
  if (base === ".mcp.json") return true;
  if (base.endsWith(".sh")) return true;
  return false;
}

// Все присваивания VAR в тексте → плоский список отдельных глобов.
// Формы: `.env` bare (VAR=a/**:b/**), shell (export VAR="a/**:b/**"),
// JSON (`"VAR": "a/**:b/**"`), одинарные кавычки. Значение — до закрывающей
// кавычки либо до конца строки / комментария `#`. Разделитель списка — `:`.
// Защиты: (1) lookbehind `(?<![\w])` — не матчить var-префиксы вроде
// `LEGACY_…_IGNORE_GLOBS`; (2) skip, если присваивание в закомментированной
// строке (в префиксе строки до матча есть `#`) — инструктивный пример не deny-ит.
function extractIgnoreGlobs(content) {
  if (typeof content !== "string" || !content) return [];
  const re = new RegExp(
    "(?<![\\w])" +
      VAR +
      "[\"']?\\s*[:=]\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\n#]*))",
    "g",
  );
  const globs = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    const lineStart = content.lastIndexOf("\n", m.index - 1) + 1;
    if (content.slice(lineStart, m.index).includes("#")) continue; // закомментировано
    const raw = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || "";
    for (const g of raw.split(":")) {
      const t = g.trim();
      if (t) globs.push(t);
    }
  }
  return globs;
}

// Широкие глобы, которые правка НОВО вводит (Edit/MultiEdit — против old_string;
// Write — против содержимого файла на диске; Bash — вся команда, «старого» нет).
// Диф обязателен: без него правка, лишь эхо-ящая уже существующий широкий глоб
// (или полный Write файла с ним), ложно отклонялась бы навсегда.
function addedBroadGlobs(toolName, input, readFile) {
  if (!input || typeof input !== "object") return [];
  let newContent = null;
  let oldContent = "";
  if (toolName === "Bash") {
    newContent = typeof input.command === "string" ? input.command : null;
  } else if (toolName === "Write") {
    newContent = typeof input.content === "string" ? input.content : null;
    if (newContent != null) oldContent = readFile(input.file_path) || "";
  } else if (toolName === "Edit") {
    newContent = typeof input.new_string === "string" ? input.new_string : null;
    oldContent = typeof input.old_string === "string" ? input.old_string : "";
  } else if (toolName === "MultiEdit") {
    if (!Array.isArray(input.edits)) return [];
    newContent = input.edits
      .map((e) => (e && typeof e.new_string === "string" ? e.new_string : ""))
      .join("\n");
    oldContent = input.edits
      .map((e) => (e && typeof e.old_string === "string" ? e.old_string : ""))
      .join("\n");
  }
  if (newContent == null) return [];
  const oldSet = new Set(extractIgnoreGlobs(oldContent));
  return extractIgnoreGlobs(newContent).filter(
    (g) => isBroadIgnoreGlob(g) && !oldSet.has(g),
  );
}

// Глоб — недоверенный Claude-content, эхо-ится в reason (терминал юзера). Стрип
// строго как sanitize в verify-changes.js (источник истины), иначе дрейф:
// - C0 controls + DEL + C1 controls [\x00-\x1f\x7f-\x9f] — U+009B = 8-bit CSI,
//   xterm трактует как ESC [ → cursor-up / line-erase;
// - BiDi overrides (U+202A-202E, U+2066-2069) — спуфинг порядка/расширений.
function sanitizeGlob(s) {
  return String(s == null ? "" : s)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/[‪-‮⁦-⁩]/g, "");
}

function buildReason(broadGlobs) {
  const list = [...new Set(broadGlobs)].map((g) => `  • ${sanitizeGlob(g)}`);
  return [
    `[main-skill ignore-glob-guard] Ты добавляешь ШИРОКИЙ ${VAR}, глушащий тесты по целым папкам:`,
    ...list,
    "Каталог-глоб прячет и тестируемую логику в той же папке — verify-changes триггер D",
    "перестаёт видеть непокрытые src-файлы. Сделай одно из:",
    "  • сузь до конкретных нетестируемых файлов по имени/расширению:",
    "    `dir/**/*.gen.ts`, `src/generated/schema.ts`, `dir/*.pb.go`;",
    "  • папка целиком генерируемая/конфиг? — миграции, *.d.ts, *.gen.*, *.pb.go,",
    "    framework-configs и т.п. и так авто-скипаются; проверь, нужен ли глоб вообще;",
    "  • репо на централизованных тестах (tests/ отдельно, имена по фиче)? — глоб не",
    "    нужен: триггер D сам засчитывает центральный спек, импортирующий файл;",
    "    спеки вовсе не импортируют исходники (чистый HTTP-flow) — тогда",
    "    MAIN_SKILL_VERIFY_CHANGES=0 на проект, не глоб.",
    "Осознанно нужен именно широкий глоб → MAIN_SKILL_IGNORE_GLOB_CHECK=0.",
  ].join("\n");
}

// Чистое ядро: payload + инъецируемые зависимости → {decision,reason} | null.
function evaluate(payload, deps) {
  const env = (deps && deps.env) || {};
  if (isDisabled(env)) return null; // /main-skill:off или MAIN_SKILL_OFF=1.
  if (env.MAIN_SKILL_IGNORE_GLOB_CHECK === "0") return null;

  const tool = (payload && payload.tool_name) || "";
  const input = payload && payload.tool_input;

  if (/^(Edit|Write|MultiEdit)$/.test(tool)) {
    if (!isEnvCarrierFile(input && input.file_path)) return null;
  } else if (tool !== "Bash") {
    return null;
  }

  const readFile = (deps && deps.readFile) || (() => "");
  const broad = addedBroadGlobs(tool, input, readFile);
  if (broad.length === 0) return null;
  return { decision: "deny", reason: buildReason(broad) };
}

// isFile-guard + cap как в claudemd-guard.safeReadFile: ENOENT (создание) и любая
// аномалия → "" (fail-soft, Write-диф просто считает всё содержимое новым).
function safeReadFile(fp) {
  try {
    if (typeof fp !== "string" || !path.isAbsolute(fp)) return "";
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(fp, "utf8");
  } catch {
    return "";
  }
}

function main(payload) {
  const out = evaluate(payload, { env: process.env, readFile: safeReadFile });
  if (!out) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: out.reason,
      },
    }),
  );
}

if (require.main === module) {
  let payload = "";
  let aborted = false;
  process.stdin.on("data", (c) => {
    payload += c;
    if (payload.length > 1024 * 1024) {
      aborted = true;
      process.stdin.destroy();
    }
  });
  process.stdin.on("end", () => {
    if (aborted) return process.exit(0);
    try {
      main(JSON.parse(payload));
    } catch {
      process.exit(0);
    }
  });
}

module.exports = {
  isEnvCarrierFile,
  extractIgnoreGlobs,
  addedBroadGlobs,
  sanitizeGlob,
  buildReason,
  evaluate,
  safeReadFile,
  main,
};
