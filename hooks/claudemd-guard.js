#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { readSettings, enabledPluginNames } = require("./lib/plugin-check");
const { isDisabled } = require("./lib/session-disabled");

const DEFAULT_MAXADD = 20;
const DEFAULT_MAXBYTES = 40 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function countLines(s) {
  if (typeof s !== "string" || s === "") return 0;
  return s.split("\n").length;
}

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

// Не менять, потому что порог не применяется к созданию с нуля: плотный новый
// CLAUDE.md — не раздувание, deny должен ловить только дописывание.
function decide(metrics, threshold) {
  if (!metrics || metrics.isCreation) return { guard: false };
  return { guard: metrics.netAdded >= threshold };
}

function resolveThreshold(env) {
  const n = parseInt((env && env.MAIN_SKILL_CLAUDEMD_MAXADD) || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAXADD;
}

function resolveMaxBytes(env) {
  const n = parseInt((env && env.MAIN_SKILL_CLAUDEMD_MAXBYTES) || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAXBYTES;
}

// Размер файла ПОСЛЕ правки. Не менять, потому что счёт в символах (`s.length`)
// занижает кириллицу вдвое (UTF-8: 2 байта на символ) — кап в 40KB не сработал
// бы никогда на русскоязычном CLAUDE.md.
function projectedBytes(toolName, input, readFile) {
  if (!input || typeof input !== "object") return null;
  const b = (s) => Buffer.byteLength(String(s || ""), "utf8");

  if (toolName === "Write") {
    if (typeof input.content !== "string") return null;
    return b(input.content);
  }

  const base = b(readFile(input.file_path) || "");
  if (toolName === "Edit") {
    if (typeof input.new_string !== "string") return null;
    return base - b(input.old_string) + b(input.new_string);
  }
  if (toolName === "MultiEdit") {
    if (!Array.isArray(input.edits)) return null;
    let size = base;
    for (const e of input.edits) {
      if (!e || typeof e.new_string !== "string") continue;
      size += b(e.new_string) - b(e.old_string);
    }
    return size;
  }
  return null;
}

function isClaudeMd(filePath) {
  return (
    typeof filePath === "string" && path.basename(filePath) === "CLAUDE.md"
  );
}

// Не менять, потому что в reason идут только статичный текст и числа: любой
// недоверенный ввод потребует ANSI-санитизации (инвариант formatBanner).
function buildReason(netAdded, threshold, improverAvailable) {
  const lines = [
    `[main-skill claude-md-guard] Эта правка добавляет в CLAUDE.md ~${netAdded} строк (порог ${threshold}).`,
    "CLAUDE.md грузится в контекст каждой сессии — прежде чем переиздать, выкинь то, что выводится",
    "из самого проекта:",
    "  • очевидное из кода (имя класса/функции уже говорит, что он делает);",
    "  • то, что утверждает тест или проверяет хук — они и есть источник истины,",
    "    а копия в доке протухает молча; нет теста/хука, но он уместен → напиши его вместо абзаца;",
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

function buildCapReason(projected, cap) {
  return [
    `[main-skill claude-md-guard] После этой правки CLAUDE.md весит ~${Math.round(projected / 1024)}KB при капе ${Math.round(cap / 1024)}KB.`,
    "Кап жёсткий: файл целиком грузится в контекст каждой сессии, вытесняя рабочий материал.",
    "Правка, которая файл УМЕНЬШАЕТ, проходит и над капом — ужимай сколько нужно заходов.",
    "Эта — не уменьшает. Что выкидывать в первую очередь:",
    "  • перечисления, выводимые из кода (списки паттернов, пороги, форматы) — источник истины в коде;",
    "  • то, что уже утверждает тест или проверяет хук; нет такого теста/хука, но он уместен →",
    "    создай его, и абзац станет не нужен;",
    "  • инвариант «почему именно так» — его место рядом с кодом как `Не менять, потому что …`;",
    "  • историю правок и разовые решения — их хранит git.",
    "Остаётся то, что не выводится ниоткуда: команды, связи модулей, осознанные компромиссы.",
    `Кап осознанно другой → MAIN_SKILL_CLAUDEMD_MAXBYTES=<байты> или MAIN_SKILL_CLAUDEMD_CHECK=0.`,
  ].join("\n");
}

function evaluate(payload, deps) {
  const env = (deps && deps.env) || {};
  if (isDisabled(env)) return null;
  if (env.MAIN_SKILL_CLAUDEMD_CHECK === "0") return null;

  const tool = (payload && payload.tool_name) || "";
  if (!/^(Edit|Write|MultiEdit)$/.test(tool)) return null;

  const input = payload.tool_input;
  if (!isClaudeMd(input && input.file_path)) return null;

  // Не менять, потому что кап идёт раньше порога и без исключения для создания:
  // 50KB одним Write вытесняют контекст ровно так же, как дописанные по строчке.
  // Уменьшающая правка пропускается даже над капом — иначе легаси-файл за капом
  // невозможно ужать инкрементально, только переписать целиком.
  const cap = resolveMaxBytes(env);
  const projected = projectedBytes(tool, input, deps.readFile);
  const current = Buffer.byteLength(
    deps.readFile(input.file_path) || "",
    "utf8",
  );
  if (projected != null && projected > cap && projected >= current) {
    return { decision: "deny", reason: buildCapReason(projected, cap) };
  }

  const threshold = resolveThreshold(env);
  const metrics = netAddedLines(tool, input, deps.readFile);
  if (!decide(metrics, threshold).guard) return null;

  // Не менять, потому что исключение improverAvailable не должно ронять deny.
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

// Не менять, потому что: isFile-guard спасает от зависания на FIFO/сокете, а
// statSync здесь СЛЕДУЕТ симлинку намеренно (нужен размер целевого файла) —
// это безопасно лишь пока в reason уходят только числа; начнёт эхо-ить
// содержимое — верни lstat-guard.
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
  projectedBytes,
  decide,
  resolveThreshold,
  resolveMaxBytes,
  buildCapReason,
  isClaudeMd,
  buildReason,
  evaluate,
  safeReadFile,
  improverAvailable,
  main,
};
