#!/usr/bin/env node
"use strict";

const { isDisabled } = require("./lib/session-disabled");

const DEFAULT_MAX = 100;
const MAX_LIMIT = 1000;
const PREVIEW_CHARS = 200;
const MAX_HEREDOC_LABEL = 256;
const MAX_HEREDOC_SPANS = 32;
const HEREDOC_LOOKAHEAD = 64;

// Не менять, потому что набор обязан совпадать с defaultIgnores commitlint: заголовок, который линтер пропускает сам, гард блокировать не должен.
const IGNORED = [
  /^((Merge pull request)|(Merge (.*?) into (.*?))|(Merge branch (.*?)))/,
  /^Merge tag /,
  /^Merge remote-tracking branch/,
  /^(Merged (.*?)(in|into) (.*)|Merged PR (.*): (.*))/,
  /^(R|r)evert /,
  /^(R|r)eapply /,
  /^(amend|fixup|squash)!/,
  /^Automatic merge/,
  /^Auto-merged (.*?) into (.*)/,
  // Не менять, потому что `-` внутри класса при `[-+]`-префиксе даёт катастрофический бэктрекинг: `v1.0.0` + 35 × `-a` + `!` жёг 20 секунд CPU.
  /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)*$/,
];

// Не менять, потому что группа обязана съедать и аргумент флага отдельным токеном: без неё `git -c user.name=x commit` и `git -C dir commit` не распознаются как коммит вовсе.
const COMMIT_SOURCE =
  "(?:^|[\\s;&|(])git\\s+(?:-\\S+\\s+(?:[^-\\s;&|][^\\s;&|]*\\s+)?)*commit(?=[\\s;&|]|$)";
const MESSAGE_FLAG_RE = /(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:\s*=\s*|\s*)/;
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
const VAR_ONLY_RE = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;
const BASH_ESCAPABLE = new Set(['"', "\\", "$", "`", "\n"]);

function heredocRegionAt(text, from) {
  const m = HEREDOC_RE.exec(text.slice(from));
  if (!m || m[2].length > MAX_HEREDOC_LABEL) return null;
  const nl = text.indexOf("\n", from + m.index);
  if (nl < 0) return null;
  const body = text.slice(nl + 1);
  const term = new RegExp(`^[ \\t]*${m[2]}[ \\t]*$`, "m").exec(body);
  return { start: nl + 1, end: term ? nl + 1 + term.index : text.length };
}

// Не менять, потому что без спанов heredoc-тела `cat > doc.md <<'EOF' … git commit -m "…" … EOF` читается как настоящий вызов и гард блокирует запись документации.
function heredocSpans(command) {
  const spans = [];
  let from = 0;
  while (spans.length < MAX_HEREDOC_SPANS) {
    const region = heredocRegionAt(command, from);
    if (!region || region.end <= from) break;
    spans.push(region);
    from = region.end;
  }
  return spans;
}

function findCommitStart(command, spans) {
  const re = new RegExp(COMMIT_SOURCE, "g");
  let m;
  while ((m = re.exec(command)) !== null) {
    const at = m.index + m[0].length;
    if (!spans.some((s) => at > s.start && at <= s.end)) return at;
  }
  return -1;
}

// Не менять, потому что без обрезки по границе команды `-m` следующей команды в цепочке (`git commit -F f && npm x -- -m "…"`) читается как заголовок коммита и даёт ложный deny.
function truncateAtBoundary(tail) {
  let quote = null;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n")
      return tail.slice(0, i);
  }
  return tail;
}

// Не менять, потому что снимается только эскейп перед `" \ $ ` `-newline: bash остальные `\X` оставляет литералом, а лишний стрип занижает длину заголовка у границы лимита.
function readValue(cmd, i) {
  while (i < cmd.length && (cmd[i] === " " || cmd[i] === "\t")) i++;
  if (i >= cmd.length) return null;
  if (cmd[i] === "$" && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) i++;
  const quote = cmd[i];
  if (quote !== '"' && quote !== "'") {
    let j = i;
    while (j < cmd.length && !/\s/.test(cmd[j])) j++;
    return cmd.slice(i, j);
  }
  let out = "";
  let j = i + 1;
  while (j < cmd.length) {
    const c = cmd[j];
    if (c === "\\" && quote === '"' && BASH_ESCAPABLE.has(cmd[j + 1])) {
      out += cmd[j + 1];
      j += 2;
      continue;
    }
    if (c === quote) return out;
    out += c;
    j++;
  }
  return out;
}

function firstMeaningfulLine(message) {
  for (const raw of String(message).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line;
  }
  return null;
}

// Не менять, потому что берётся только первый message-аргумент: второй `-m` у git — тело коммита, счёт его заголовком даёт ложный deny.
function extractCommitHeader(command) {
  if (typeof command !== "string" || !command) return null;
  const start = findCommitStart(command, heredocSpans(command));
  if (start < 0) return null;
  const tail = truncateAtBoundary(command.slice(start));
  const flag = MESSAGE_FLAG_RE.exec(tail);
  if (!flag) return null;

  const at = flag.index + flag[0].length;
  // Не менять, потому что `-m "$(cat <<'EOF' … EOF)"` — дефолтная форма коммита у Claude Code: разбор кавычками обрывает её на первой кавычке внутри тела и режет заголовок.
  const region = HEREDOC_RE.test(tail.slice(at, at + HEREDOC_LOOKAHEAD))
    ? heredocRegionAt(tail, at)
    : null;
  const value = region
    ? tail.slice(region.start, region.end)
    : readValue(tail, at);

  if (value == null || VAR_ONLY_RE.test(value.trim())) return null;
  return firstMeaningfulLine(value);
}

function isIgnoredHeader(header) {
  return IGNORED.some((re) => re.test(header));
}

function headerLimit(env) {
  const n = Number.parseInt(
    (env && env.MAIN_SKILL_COMMIT_HEADER_MAX) || "",
    10,
  );
  if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) return DEFAULT_MAX;
  return n;
}

// Не менять, потому что заголовок эхо-ится в терминал юзера: C0/C1 (U+009B = 8-bit CSI) и BiDi-overrides — канал подмены вывода; набор строго как sanitize в verify-changes.js.
function sanitize(s) {
  return String(s == null ? "" : s)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/[‪-‮⁦-⁩]/g, "");
}

function buildReason(header, max) {
  const preview = sanitize(header).slice(0, PREVIEW_CHARS);
  return [
    `[main-skill commit-msg-guard] Заголовок коммита — ${header.length} символов при лимите ${max}:`,
    `  • ${preview}`,
    "commitlint (header-max-length) такой коммит отклонит, и его придётся переписывать. Сожми:",
    `  • суть в ≤${max} символов: \`тип(scope): что изменилось\` — без перечисления файлов и «почему»;`,
    "  • подробности — в тело коммита (второй `-m` или абзац heredoc после пустой строки), там лимита нет;",
    "  • служебный autosquash-коммит — префиксы `fixup!` / `squash!` / `amend!` гард пропускает.",
    "Лимит в проекте другой → MAIN_SKILL_COMMIT_HEADER_MAX=<n>; гард не нужен → MAIN_SKILL_COMMIT_CHECK=0.",
  ].join("\n");
}

function evaluate(payload, deps) {
  const env = (deps && deps.env) || {};
  if (isDisabled(env)) return null;
  if (env.MAIN_SKILL_COMMIT_CHECK === "0") return null;

  if (!payload || payload.tool_name !== "Bash") return null;
  const input = payload.tool_input;
  const command =
    input && typeof input.command === "string" ? input.command : null;
  if (!command) return null;

  const header = extractCommitHeader(command);
  if (!header) return null;

  // Не менять, потому что порядок обязан быть «длина → ignore-регулярки»: заголовок в пределах лимита не должен вообще доходить до regex-набора.
  const max = headerLimit(env);
  if (header.length <= max || isIgnoredHeader(header)) return null;
  return { decision: "deny", reason: buildReason(header, max) };
}

function main(payload) {
  const out = evaluate(payload, { env: process.env });
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
  extractCommitHeader,
  isIgnoredHeader,
  headerLimit,
  sanitize,
  buildReason,
  evaluate,
  main,
};
