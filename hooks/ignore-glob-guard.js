#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { isBroadIgnoreGlob } = require("./lib/checks");
const { isDisabled } = require("./lib/session-disabled");

const VAR = "MAIN_SKILL_VERIFY_IGNORE_GLOBS";
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Не менять, потому что гардить можно только файлы, где переменная реально
// ставится: расширь список на .md или на `.claude/*` — и гард словит сам себя на
// примере в доках и в исходниках плагина.
function isEnvCarrierFile(fp) {
  if (typeof fp !== "string") return false;
  const base = path.basename(fp.replace(/\\/g, "/")).toLowerCase();
  if (/^\.env(\.[\w.-]+)?$/.test(base)) return true;
  if (
    /^\.(bashrc|zshrc|zshenv|bash_profile|zprofile|profile|envrc)$/.test(base)
  )
    return true;
  if (base === "settings.json" || base === "settings.local.json") return true;
  if (base === ".mcp.json") return true;
  if (base.endsWith(".sh")) return true;
  return false;
}

// Не менять, потому что оба фильтра гасят ложный deny: lookbehind отсекает чужие
// переменные с тем же хвостом (`LEGACY_…_IGNORE_GLOBS`), а skip закомментированной
// строки — инструктивный пример в .env/.sh.
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
    if (content.slice(lineStart, m.index).includes("#")) continue;
    const raw = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || "";
    for (const g of raw.split(":")) {
      const t = g.trim();
      if (t) globs.push(t);
    }
  }
  return globs;
}

// Не менять, потому что без дифа против старого содержимого правка, лишь
// эхо-ящая уже существующий широкий глоб, отклонялась бы вечно.
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

// Не менять, потому что глоб эхо-ится в терминал юзера: без C0/C1 (U+009B = 8-bit
// CSI → line-erase) и BiDi-overrides это канал подмены вывода. Набор — строго как
// sanitize в verify-changes.js.
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
    "    нужен: триггер D сам засчитывает центральный спек, импортирующий файл",
    "    (пакет на сотни спеков → подними бюджет скана: MAIN_SKILL_IMPORT_SCAN_MAX_FILES);",
    "    спеки вовсе не импортируют исходники (чистый HTTP-flow) — тогда",
    "    MAIN_SKILL_VERIFY_CHANGES=0 на проект, не глоб.",
    "Осознанно нужен именно широкий глоб → MAIN_SKILL_IGNORE_GLOB_CHECK=0.",
  ].join("\n");
}

function evaluate(payload, deps) {
  const env = (deps && deps.env) || {};
  if (isDisabled(env)) return null;
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

// Не менять, потому что isFile-guard спасает от зависания на FIFO/сокете, а
// аномалия обязана давать "" — Write-диф тогда считает содержимое новым.
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
