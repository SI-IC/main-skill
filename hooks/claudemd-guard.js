#!/usr/bin/env node
"use strict";

// PreToolUse-хук: гард против раздувания CLAUDE.md. На Edit/Write/MultiEdit по
// basename `CLAUDE.md` считает net-прирост строк правки; дописывание в существующий
// файл >= порога → permissionDecision:deny с дистиллятом правил claude-md-management.
// Дизайн, инварианты и known-gap — в CLAUDE.md «PreToolUse claude-md-guard».
//
// Env: MAIN_SKILL_CLAUDEMD_CHECK=0 — выкл; MAIN_SKILL_CLAUDEMD_MAXADD=<n> — порог.

const fs = require("fs");
const path = require("path");
const { readSettings, enabledPluginNames } = require("./lib/plugin-check");
const { isDisabled } = require("./lib/session-disabled");

const DEFAULT_MAXADD = 20;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Число строк в тексте. Пустая строка / не-строка → 0. Trailing `\n` даёт +1
// сегмент. Для Edit/MultiEdit это симметрично (old/new — подстроки одного файла).
// Для Write возможна асимметрия ±1: disk-файл обычно с trailing `\n`, а content
// от Claude — нет. Для эвристики-порога погрешность в 1 строку приемлема.
function countLines(s) {
  if (typeof s !== "string" || s === "") return 0;
  return s.split("\n").length;
}

// { netAdded, isCreation } для правки, либо null если форму входа не распознали.
// readFile(path) → содержимое существующего файла или null (нет файла / ошибка).
function netAddedLines(toolName, input, readFile) {
  if (!input || typeof input !== "object") return null;

  if (toolName === "Write") {
    if (typeof input.content !== "string") return null;
    const existing = readFile(input.file_path);
    const isCreation = existing === null || existing.trim() === "";
    return {
      netAdded: countLines(input.content) - countLines(existing || ""),
      isCreation,
    };
  }

  if (toolName === "Edit") {
    if (typeof input.new_string !== "string") return null;
    const oldS = typeof input.old_string === "string" ? input.old_string : "";
    return {
      netAdded: countLines(input.new_string) - countLines(oldS),
      isCreation: false,
    };
  }

  if (toolName === "MultiEdit") {
    if (!Array.isArray(input.edits)) return null;
    let net = 0;
    for (const e of input.edits) {
      if (!e || typeof e.new_string !== "string") continue;
      const oldS = typeof e.old_string === "string" ? e.old_string : "";
      net += countLines(e.new_string) - countLines(oldS);
    }
    return { netAdded: net, isCreation: false };
  }

  return null;
}

// Гардим только дописывание в существующий файл, перешедшее порог.
function decide(metrics, threshold) {
  if (!metrics || metrics.isCreation) return { guard: false };
  return { guard: metrics.netAdded >= threshold };
}

function resolveThreshold(env) {
  const n = parseInt((env && env.MAIN_SKILL_CLAUDEMD_MAXADD) || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAXADD;
}

function isClaudeMd(filePath) {
  return (
    typeof filePath === "string" && path.basename(filePath) === "CLAUDE.md"
  );
}

// Дистиллят правил claude-md-management (update-guidelines «What NOT to add» +
// quality-criteria conciseness). НИКАКОГО недоверенного ввода в reason — только
// статичный текст и целые числа (netAdded/threshold), поэтому ANSI-санитизация
// не нужна (ср. инвариант plugin-check.js formatBanner).
function buildReason(netAdded, threshold, improverAvailable) {
  const lines = [
    `[main-skill claude-md-guard] Эта правка добавляет в CLAUDE.md ~${netAdded} строк (порог ${threshold}).`,
    "CLAUDE.md грузится в контекст каждой сессии — прежде чем переиздать, выкинь то, что запрещает claude-md-management:",
    "  • очевидное из кода (имя класса/функции уже говорит, что он делает);",
    "  • generic best-practices («пишите тесты», «понятные имена») — это не про проект;",
    "  • разовые фиксы («починили баг в commit abc123») — не повторится, мусор;",
    "  • многословные объяснения — ужимай до одной плотной строки.",
    "Оставляй только: команды/воркфлоу, не-очевидные паттерны и gotchas, связи модулей, конфиг-квирки.",
  ];
  lines.push(
    improverAvailable
      ? "Переиздай Edit с ужатым содержимым, либо сначала прогони `claude-md-management:claude-md-improver` для полного аудита."
      : "Переиздай Edit с ужатым содержимым. Не нужное по делу — не добавляй вовсе.",
  );
  lines.push(
    "Осознанно дописываешь много и это оправдано → MAIN_SKILL_CLAUDEMD_MAXADD=<n> или MAIN_SKILL_CLAUDEMD_CHECK=0.",
  );
  return lines.join("\n");
}

// Чистое ядро: payload + инъецируемые зависимости → {decision,reason} | null.
function evaluate(payload, deps) {
  const env = (deps && deps.env) || {};
  if (isDisabled(env)) return null; // /main-skill:off или MAIN_SKILL_OFF=1 — плагин выкл на сессию.
  if (env.MAIN_SKILL_CLAUDEMD_CHECK === "0") return null;

  const tool = (payload && payload.tool_name) || "";
  if (!/^(Edit|Write|MultiEdit)$/.test(tool)) return null;

  const input = payload.tool_input;
  if (!isClaudeMd(input && input.file_path)) return null;

  const threshold = resolveThreshold(env);
  const metrics = netAddedLines(tool, input, deps.readFile);
  if (!decide(metrics, threshold).guard) return null;

  // Постороннее исключение improverAvailable не должно ронять deny — гард важнее
  // упоминания improver в тексте.
  let improver = false;
  try {
    improver = deps.improverAvailable();
  } catch {
    improver = false;
  }
  return {
    decision: "deny",
    reason: buildReason(metrics.netAdded, threshold, improver),
  };
}

// ─── IO-обёртка ──────────────────────────────────────────────────────────────

// isFile-guard обязателен: без него readFileSync завис бы на FIFO/сокете. Cap —
// страховка от раздутого файла. ENOENT (создание) и любая ошибка → null (fail-soft).
// statSync намеренно СЛЕДУЕТ симлинку (в отличие от lstat в auto-format / realpath
// в verify-changes): нам нужен счёт строк реального целевого файла. Leak-safe —
// в reason уходит только целое netAdded, НЕ содержимое; читать «наружу» нечем
// поживиться. Если reason когда-то начнёт эхо-ить содержимое — вернуть lstat-guard.
function safeReadFile(fp) {
  try {
    if (typeof fp !== "string" || !path.isAbsolute(fp)) return null;
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
}

function improverAvailable() {
  try {
    return enabledPluginNames(readSettings()).has("claude-md-management");
  } catch {
    return false;
  }
}

function main(payload) {
  const out = evaluate(payload, {
    env: process.env,
    readFile: safeReadFile,
    improverAvailable,
  });
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
  countLines,
  netAddedLines,
  decide,
  resolveThreshold,
  isClaudeMd,
  buildReason,
  evaluate,
  safeReadFile,
  improverAvailable,
  main,
};
