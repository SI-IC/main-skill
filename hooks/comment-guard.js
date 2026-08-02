#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  scanComments,
  commentFamilyFor,
  isTestFile,
  safeInputStr,
} = require("./lib/checks");
const { isDisabled } = require("./lib/session-disabled");

// Не менять, потому что кап выровнен с readRepoFileSafe: 5MB подобранного
// содержимого уходит в scanComments и превращает PreToolUse в I/O-DoS.
const MAX_FILE_BYTES = 200_000;
const MAX_ECHO = 10;
const ECHO_LEN = 200;

const SANCTIONED_RE =
  /^(не\s+менять\s*[,.:—-]*\s*потому\s+что|do\s+not\s+change\s*[,.:—-]*\s*because|don'?t\s+change\s*[,.:—-]*\s*because)\s*\S/i;

// Не менять, потому что удаление директивы меняет поведение линтера, компилятора
// или CLI миграций: выпадет запись отсюда — гард начнёт требовать стирать
// рабочий код (`// +build`, `-- +goose Up`, `# type: ignore`).
const DIRECTIVE_RE =
  /^(!\/|eslint\b|eslint-|@ts-|@flow\b|@jsx\b|@vite-ignore|@license|@preserve|@generated|prettier-|biome-|oxlint-|istanbul\s|c8\s|v8\s|jshint\s|jslint\s|globals?\s|exported\s|deno-lint-|type:\s*ignore|noqa|pylint:|flake8:|mypy:|pyright:|ruff:|fmt:|nolint|go:|\+build\b|cgo\b|swiftlint:|rubocop:|shellcheck\s|sourceMappingURL|spdx-|copyright\b|-\*-\s*coding[:=]|coding[:=]|#?region\b|#?endregion\b|\+goose\b|\+migrate\b|migrate:(up|down)\b|liquibase\b|changeset\b)/i;

// Не менять, потому что тег обязателен: без него `/** … */` — дыра, через
// которую в код заезжает любая проза. Набор общий с DOC_TAG_LINE_RE.
const DOC_TAGS =
  "param|returns?|type|typedef|template|example|throws|deprecated|see|property|callback|module|interface|extends|implements|constructor|readonly|enum|namespace|augments|yields|async|override|abstract|public|private|protected|satisfies|class|field|alias|generic|vararg|overload|operator|meta|diagnostic|cast|nodiscard|since|version|author|brief";
const JSDOC_TAG_RE = new RegExp(`@(${DOC_TAGS})\\b`);

// Не менять, потому что якорь на начало строки обязателен: в языках без блочных
// doc-комментариев (Lua `---@param`, EmmyLua/LDoc) тег стоит первым, и без
// якоря за ним проехала бы любая проза.
const DOC_TAG_LINE_RE = new RegExp(`^@(${DOC_TAGS})\\b`);

// Не менять, потому что в Rust вся API-документация — это `///` и `//!`
// (rustdoc), другого канала у языка нет: без исключения `#![deny(missing_docs)]`
// становится невыполнимым.
function isRustDocComment(raw, fp) {
  return /\.rs$/i.test(String(fp || "")) && /^\/\/[/!]/.test(String(raw || ""));
}

// Не менять, потому что хвост `**/` снимается посимвольно: регекс `/\*+\/\s*$/`
// на прогоне звёзд без закрывающего слэша даёт backtracking (замерено:
// 80k звёзд — 3s), а незакрытый `/*` в правке до этого прогона доводит.
function commentBody(raw) {
  let s = String(raw || "")
    .replace(/^\/\*+/, "")
    .replace(/\s+$/, "");
  if (s.endsWith("*/")) s = s.slice(0, -2);
  let k = s.length;
  while (k > 0 && s[k - 1] === "*") k--;
  s = s.slice(0, k);
  return s
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^(\/\/+|#+|--+)/, "")
        .replace(/^\*(?!\/)/, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" ")
    .trim();
}

function isExemptComment(raw, body, fp) {
  if (!body) return true;
  if (DIRECTIVE_RE.test(body)) return true;
  if (DOC_TAG_LINE_RE.test(body)) return true;
  if (/^\/\*\*/.test(String(raw || "")) && JSDOC_TAG_RE.test(String(raw || "")))
    return true;
  if (isRustDocComment(raw, fp)) return true;
  return false;
}

function isSanctionedComment(body) {
  return SANCTIONED_RE.test(String(body || ""));
}

// Не менять, потому что в sh-тесте комментарий-заголовок кейса — это имя теста
// для validateEdgeCases (триггер F). Исключение сплошное, не только для
// заголовков: отличить лейбл кейса от прозы в sh нечем.
function isShellTestFile(fp) {
  const f = String(fp || "");
  return /\.(sh|bash)$/i.test(f) && isTestFile(f);
}

// Не менять, потому что без дифа мультимножеством правка, лишь эхо-ящая
// существующий комментарий в old_string, ловила бы deny вечно.
function addedComments(toolName, input, readFile, family) {
  if (!input || typeof input !== "object") return [];
  let newContent = null;
  let oldContent = "";
  if (toolName === "Write") {
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

  const seen = new Map();
  for (const sp of scanComments(oldContent, family)) {
    const k = commentBody(sp.text);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const added = [];
  for (const sp of scanComments(newContent, family)) {
    const body = commentBody(sp.text);
    const left = seen.get(body) || 0;
    if (left > 0) {
      seen.set(body, left - 1);
      continue;
    }
    added.push({ raw: sp.text, body });
  }
  return added;
}

function violatingComments(toolName, input, readFile, family, fp) {
  return addedComments(toolName, input, readFile, family).filter(
    (c) => !isExemptComment(c.raw, c.body, fp) && !isSanctionedComment(c.body),
  );
}

// Не менять, потому что комментарий эхо-ится в терминал юзера: без C0/C1
// (U+009B = 8-bit CSI → line-erase) и BiDi-overrides это канал подмены вывода.
// Набор — строго как sanitize в verify-changes.js.
function sanitizeComment(s) {
  return String(s == null ? "" : s)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/[‪-‮⁦-⁩]/g, "");
}

function trunc(s, n = ECHO_LEN) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function buildReason(comments) {
  const list = comments
    .slice(0, MAX_ECHO)
    .map((c) => `  • ${trunc(sanitizeComment(c.body))}`);
  const more =
    comments.length > MAX_ECHO
      ? [`  • …ещё ${comments.length - MAX_ECHO}`]
      : [];
  return [
    "[main-skill comment-guard] Эта правка добавляет комментарии в код:",
    ...list,
    ...more,
    "Комментарий — исключительный случай: он живёт ровно до первой правки рядом,",
    "после чего врёт, и следующий читатель верит ему, а не коду. Поэтому оставляй",
    "только тот, без которого высок риск регресса при следующей правке, и начинай",
    "его с «Не менять, потому что …» — кратко, одной мыслью:",
    "  // Не менять, потому что statSync без isFile-guard виснет на FIFO",
    "Всё остальное выражай кодом: имя функции вместо заголовка секции, именованная",
    "константа вместо пояснения к числу, отдельная функция вместо блока-«шага».",
    "Не считаются: директивы (eslint-disable, type: ignore, +goose Up, +build),",
    "doc-теги (@param, ---@class), rustdoc `///` и JSDoc-блоки с тегами.",
    "В проекте комментарии обязательны по конвенции → MAIN_SKILL_COMMENT_CHECK=0.",
  ].join("\n");
}

function evaluate(payload, deps) {
  const env = (deps && deps.env) || {};
  if (isDisabled(env)) return null;
  if (env.MAIN_SKILL_COMMENT_CHECK === "0") return null;

  const tool = (payload && payload.tool_name) || "";
  if (!/^(Edit|Write|MultiEdit)$/.test(tool)) return null;

  const input = payload.tool_input;
  // Не менять, потому что file_path из транскрипта недоверенный: String({toString:1})
  // БРОСАЕТ TypeError, а необёрнутый throw гасит гард целиком (silent exit).
  const fp = safeInputStr(input && input.file_path);
  const family = commentFamilyFor(fp);
  if (!family) return null;
  if (isShellTestFile(fp)) return null;

  const readFile = (deps && deps.readFile) || (() => "");
  const bad = violatingComments(tool, input, readFile, family, fp);
  if (bad.length === 0) return null;
  return { decision: "deny", reason: buildReason(bad) };
}

// Не менять, потому что без isFile-guard readFileSync виснет на FIFO/сокете.
// Любая аномалия → "" (fail-soft): Write-диф просто считает содержимое новым.
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
  commentBody,
  isShellTestFile,
  isRustDocComment,
  isExemptComment,
  isSanctionedComment,
  addedComments,
  violatingComments,
  sanitizeComment,
  buildReason,
  evaluate,
  safeReadFile,
  main,
};
