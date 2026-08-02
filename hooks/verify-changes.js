#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const checks = require("./lib/checks");
const { isDisabled } = require("./lib/session-disabled");

// Не менять, потому что без капа сессия с image-вложениями съедает память
// Node-процесса хука.
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

// Не менять, потому что это канонический набор для всего репо (остальные хуки
// копируют его): C0 + DEL + C1 (U+009B — 8-bit CSI, xterm читает как ESC[ →
// cursor-up/line-erase) и BiDi-overrides (U+202A-202E, U+2066-2069, спуфинг
// порядка символов). Меньший набор = terminal-injection через имя файла.
function sanitize(s) {
  return String(s == null ? "" : s)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/[‪-‮⁦-⁩]/g, "");
}

// Не менять, потому что запись транскрипта бывает мегабайтной: без капа reason
// раздувается в десятки MB прямо в терминал юзера.
function trunc(s, n = 200) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n) + "…" : t;
}

let payload = "";
process.stdin.on("data", (c) => (payload += c));
process.stdin.on("end", () => {
  try {
    main(JSON.parse(payload));
  } catch {
    process.exit(0);
  }
});

function main(p) {
  if (isDisabled()) return;
  if (
    process.env.MAIN_SKILL_VERIFY_CHANGES === "0" ||
    process.env.MAIN_SKILL_VERIFY_FRONTEND === "0"
  ) {
    return;
  }

  const tp = p.transcript_path;
  if (!tp || !fs.existsSync(tp)) return;

  // Не менять, потому что без realpath+isFile симлинк `~/.claude/x.jsonl → /etc/passwd`
  // подсунет хуку произвольный файл, а FIFO подвесит чтение.
  let resolvedTp;
  try {
    resolvedTp = fs.realpathSync(tp);
    const st = fs.statSync(resolvedTp);
    if (!st.isFile()) return;
    if (st.size > MAX_TRANSCRIPT_BYTES) return;
  } catch {
    return;
  }

  const lines = fs
    .readFileSync(resolvedTp, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const lastText = findLastAssistantText(lines);
  if (!lastText) return;

  const successPat =
    /(^|[^\p{L}\p{N}_])(готово|готов|готова|done|fixed|fix(ed)?|works?|работает|пофиксил|починил|ready|complete[d]?|применил|применён|примен[её]н|pushed|bumped|shipped|deployed)([^\p{L}\p{N}_]|$)/iu;
  const disclaimerPat =
    /не\s+(про)?верил|не\s+(про)?тестировал|not\s+verified|проверь\s+вручную|please\s+(verify|check)\s+manually|end-to-end\s+не\s+проверил|couldn['']?t\s+(verify|test)|did\s+not\s+verify/i;
  const delegatePat =
    /(запусти|выполни|попробуй\s+запустить)\s+(это\s+)?(у\s+себя|на\s+своей|в\s+(своём|твоём|своем|твоем)\s+терминале|сам(остоятельно)?|вручную)|запусти[^.!?]{0,40}в\s+терминале|you\s+(need\s+to\s+|should\s+|can\s+|will\s+need\s+to\s+)run\b|please\s+run\b|run\s+(this|it|that|the\s+\w+)\s+(locally|in\s+your\s+terminal|on\s+your\s+(machine|side))|in\s+your\s+terminal/i;

  const hasSuccess = successPat.test(lastText);
  const hasDisclaimer = disclaimerPat.test(lastText);
  const hasDelegation =
    delegatePat.test(lastText) &&
    /```[a-z]*\s*\n[\s\S]*?\n```|`[^`\n]{3,}`/m.test(lastText);

  if (!hasSuccess && !hasDisclaimer && !hasDelegation) return;

  const classify = (fp = "") => {
    const f = String(fp);
    if (
      /(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT)(\.\w+)?$/i.test(
        f,
      )
    )
      return "docs";
    if (
      /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock)$/i.test(
        f,
      )
    )
      return "lockfile";
    if (
      /\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|mp4|mp3|wav|pdf)$/i.test(
        f,
      )
    )
      return "asset";

    // Не менять, потому что ветка обязана идти до docs: .md в skills/ — это runtime
    // поведение, а не документация.
    if (/(^|\/)\.claude-plugin\//.test(f)) return "plugin";
    if (/(^|\/)\.claude\/(settings|hooks|commands)/.test(f)) return "plugin";
    if (
      /(^|\/)(hooks|commands|skills|agents)\/.*\.(md|mdx|sh|js|ts|mjs|cjs|py|json|ya?ml)$/i.test(
        f,
      )
    )
      return "plugin";

    if (/\.(md|mdx|txt|rst|adoc)$/i.test(f)) return "docs";

    if (/\.(tsx|jsx|vue|svelte|astro|html|htm)$/i.test(f)) return "frontend";
    if (/\.(css|scss|sass|less|styl|stylus)$/i.test(f)) return "frontend";
    if (
      /\.(py|go|rs|rb|java|kt|kts|scala|php|cs|fs|fsx|ex|exs|clj|cljs|erl|hs|ml|mli|swift|dart|lua|sh|bash|zsh|fish|ps1|sql)$/i.test(
        f,
      )
    )
      return "backend";
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(f)) return "backend";
    if (/(^|\/)(bin|scripts|cli)\//i.test(f)) return "cli";
    if (
      /(^|\/)(Dockerfile|docker-compose[\w.-]*\.ya?ml|Makefile|justfile|Procfile)$/i.test(
        f,
      )
    )
      return "infra";
    if (/\.(ya?ml|toml|json)$/i.test(f)) return "config";
    return "other";
  };

  const observable = new Set(["frontend", "backend", "cli", "plugin", "infra"]);

  let lastEditIdx = -1;
  let lastEditKind = null;
  let lastVerifyIdx = -1;
  let lastRenderIdx = -1;
  let lastAttemptIdx = -1;
  let lastBlockIdx = -1;
  let lastDelegableBashIdx = -1;
  const frontendEdits = [];

  lines.forEach((e, idx) => {
    if (e.type !== "assistant") return;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      const name = b.name || "";
      const inp = b.input || {};

      if (["Edit", "Write", "MultiEdit"].includes(name)) {
        const fp = inp.file_path || "";
        const kind = classify(fp);
        if (observable.has(kind)) {
          lastEditIdx = idx;
          lastEditKind = kind;
        }
        // Не менять, потому что без фильтра правка Card.test.tsx после рендера ложно
        // ре-триггерит M на неизменённый компонент.
        if (
          kind === "frontend" &&
          !checks.isTestFile(fp) &&
          !checks.isDocFile(fp)
        ) {
          frontendEdits.push({ idx, fp });
        }
      }

      if (name === "Bash") {
        const cmd = String(inp.command || "");
        lastDelegableBashIdx = idx;

        const isRenderCmd = checks.isRenderVerifyCmd(cmd);
        if (isRenderCmd) lastRenderIdx = idx;

        // Не менять, потому что квантификаторы обязаны быть ограничены ({0,300}):
        // unbounded даёт квадратичный backtracking на команде из множества curl-токенов.
        if (
          isRenderCmd ||
          /\bcurl\b[^|;&\n]{0,300}https?:\/\//i.test(cmd) ||
          /\bwget\b[^|;&\n]{0,300}https?:\/\//i.test(cmd) ||
          /\b(pytest|python\s+-m\s+pytest)\b/i.test(cmd) ||
          /\b(go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|bundle\s+exec\s+rspec|rspec|phpunit|dotnet\s+test)\b/i.test(
            cmd,
          ) ||
          /\bnpm\s+(test|run\s+test|run\s+e2e)\b/i.test(cmd) ||
          /\bpnpm\s+(test|run\s+test|run\s+e2e)\b/i.test(cmd) ||
          /\byarn\s+(test|run\s+test|run\s+e2e)\b/i.test(cmd) ||
          /\bvitest\b/i.test(cmd) ||
          /\bjest\b/i.test(cmd) ||
          /\bdocker[- ]compose\s+(up|run|exec)/i.test(cmd) ||
          /\bdocker\s+(run|exec|build)/i.test(cmd) ||
          /\bclaude\s+-p\b/i.test(cmd) ||
          /\bclaude\s+--print\b/i.test(cmd) ||
          /\b(python3?|node|deno|bun|ruby|go\s+run|cargo\s+run|dotnet\s+run)\s+[^\n]*\.(py|js|mjs|ts|rb|go|rs)\b/i.test(
            cmd,
          ) ||
          /\b(bash|sh|zsh|ksh|fish)\s+[^|;&\n]*\.(sh|bash)\b/i.test(cmd) ||
          /(^|[\s;&|])\.?\/?(scripts?|bin)\/[\w.-]+/i.test(cmd) ||
          /(^|[\s;&|])(\.\/|\/|~\/)[\w\/.-]+\.(sh|bash|py|js|ts|rb)(\s|$|\s+-)/i.test(
            cmd,
          ) ||
          /\b(make|just)\s+(test|check|e2e|ci|smoke|verify)\b/i.test(cmd)
        ) {
          lastVerifyIdx = idx;
        }
        if (
          /\b(lsof|ss|netstat|pgrep|ps\s+-|nc\s+-z)\b/i.test(cmd) ||
          /\bwhich\s+\w+/i.test(cmd) ||
          /\bcommand\s+-v\s+\w+/i.test(cmd) ||
          /\bnpx\s+playwright\s+install/i.test(cmd) ||
          /\bnpm\s+(install|i)\s+[^\n]*playwright/i.test(cmd) ||
          /\bnpm\s+run\s+(dev|start|build|preview)/i.test(cmd) ||
          /\b(next|vite|remix|astro)\s+(dev|start|build)/i.test(cmd) ||
          /\bcurl\b/i.test(cmd) ||
          /\bwget\b/i.test(cmd) ||
          /\bdocker\b/i.test(cmd) ||
          /\bclaude\b/i.test(cmd)
        ) {
          lastAttemptIdx = idx;
        }
      }

      if (
        name.startsWith("mcp__claude-in-chrome__") ||
        name.startsWith("mcp__plugin_chrome-devtools-mcp_") ||
        name.startsWith("mcp__plugin_playwright_")
      ) {
        const passive = new Set([
          "mcp__claude-in-chrome__tabs_context_mcp",
          "mcp__claude-in-chrome__shortcuts_list",
          "mcp__claude-in-chrome__switch_browser",
          "mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_pages",
        ]);
        if (!passive.has(name)) {
          lastVerifyIdx = idx;
          lastRenderIdx = idx;
          lastAttemptIdx = idx;
        } else {
          lastAttemptIdx = idx;
        }
      }
    }
  });

  const blockRe = /main-skill:verify-(frontend|changes)/;
  lines.forEach((e, idx) => {
    if (e.type !== "user") return;
    const content = e.message?.content;
    if (typeof content === "string") {
      if (blockRe.test(content)) lastBlockIdx = idx;
      return;
    }
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b) continue;
      if (
        b.type === "tool_result" &&
        typeof b.content === "string" &&
        blockRe.test(b.content)
      ) {
        lastBlockIdx = idx;
      }
      if (
        b.type === "text" &&
        typeof b.text === "string" &&
        blockRe.test(b.text)
      ) {
        lastBlockIdx = idx;
      }
    }
  });

  let trigger = null;
  let triggerData = null;

  if (hasDelegation && lastDelegableBashIdx >= 0) {
    const interactiveHint =
      /(gcloud|aws|az|op|vault)\s+(login|auth)|ssh\s+-\w*\s*\w|xdg-open|open\s+http|osascript/i;
    if (!interactiveHint.test(lastText)) {
      trigger = "C";
    }
  }

  const allEdits = checks.collectFileEdits(lines);

  if (!trigger && lastEditIdx >= 0) {
    // Не менять, потому что без этого выхода хук блокирует Stop бесконечно, когда
    // Claude не может выполнить требование: одно слово юзеру — by design.
    if (lastBlockIdx > lastEditIdx) return;

    const verifiedAfterEdit = lastVerifyIdx > lastEditIdx;
    const attemptedAfterEdit = lastAttemptIdx > lastEditIdx;

    if (hasDisclaimer && !attemptedAfterEdit) {
      trigger = "B";
    } else if (hasSuccess) {
      // Не менять, потому что порядок определяет, какое требование Claude увидит
      // первым: дешёвые мехчеки (lint, парный тест) идут раньше дорогих ритуалов.
      const repoRoot = checks.resolveRepoRoot(
        process.env.CLAUDE_PROJECT_DIR,
        allEdits,
      );
      const sessionFiles = new Set(allEdits.map((e) => e.file_path));
      const observableSrcEdits = allEdits
        .filter((e) => observable.has(classify(e.file_path)))
        .filter((e) => !checks.isTestFile(e.file_path))
        .filter((e) => !checks.isDocFile(e.file_path))
        .filter((e) => checks.isCodeFile(e.file_path))

        .filter((e) => checks.existsInsideRepo(e.file_path, repoRoot));
      const observableSrcFiles = [
        ...new Set(observableSrcEdits.map((e) => e.file_path)),
      ];

      if (!trigger && process.env.MAIN_SKILL_VERIFY_LINT !== "0") {
        const lintRes = checks.runLint(repoRoot);
        if (lintRes && lintRes.ran && lintRes.ok === false) {
          trigger = "G";
          triggerData = lintRes;
        }
      }

      if (!trigger) {
        const userIgnoreGlobs = String(
          process.env.MAIN_SKILL_VERIFY_IGNORE_GLOBS || "",
        )
          .split(":")
          .map((s) => s.trim())
          .filter(Boolean);
        const missingTests = [];
        const truncatedScans = [];
        const importScanCache = {};
        for (const fp of observableSrcFiles) {
          const rel = path.isAbsolute(fp) ? path.relative(repoRoot, fp) : fp;
          if (checks.shouldSkipForTestPairing(fp, repoRoot)) continue;
          if (checks.matchAnyGlob(rel, userIgnoreGlobs)) continue;
          const paired = checks.findPairedTestFile(fp, repoRoot, sessionFiles);
          if (paired) continue;
          if (checks.findTestByImportScan(fp, repoRoot, importScanCache))
            continue;
          if (importScanCache.lastTruncated) truncatedScans.push(fp);
          missingTests.push(fp);
        }
        if (missingTests.length > 0) {
          trigger = "D";
          triggerData = { missingTests, truncatedScans };
        }
      }

      if (!trigger) {
        const missingE2e = [];
        for (const fp of observableSrcFiles) {
          if (!checks.isControllerOrRoute(fp)) continue;
          if (
            !checks.isCriticalEndpoint(fp) &&
            !checks.hasMutatingHandler(fp, repoRoot)
          )
            continue;
          const paired = checks.findE2eFile(fp, repoRoot, sessionFiles);
          if (!paired) missingE2e.push(fp);
        }
        if (missingE2e.length > 0) {
          trigger = "E";
          triggerData = { missingE2e };
        }
      }

      if (!trigger && process.env.MAIN_SKILL_VERIFY_RENDER !== "0") {
        // Не менять, потому что без капа транскрипт с тысячами фронт-путей превращает
        // Stop в I/O-DoS: каждый кандидат стоит statSync+readFileSync до 200KB.
        const unrendered = [
          ...new Set(
            frontendEdits.filter((e) => e.idx > lastRenderIdx).map((e) => e.fp),
          ),
        ]
          .slice(0, 50)
          .filter((fp) => !checks.isRenderExemptFrontendFile(fp, repoRoot));
        if (unrendered.length > 0) {
          trigger = "M";
          triggerData = { unrendered };
        }
      }

      if (!trigger) {
        const publicEdits = allEdits.filter((e) =>
          checks.isPublicSurface(e.file_path),
        );
        const docEdits = allEdits.filter((e) => checks.isDocFile(e.file_path));
        if (publicEdits.length > 0 && docEdits.length === 0) {
          trigger = "H";
          triggerData = {
            publicEdits: [...new Set(publicEdits.map((e) => e.file_path))],
          };
        }
      }

      if (!trigger) {
        const parsed = checks.parseEdgeCasesBlock(lastText);
        if (!parsed || parsed.entries.length === 0) {
          trigger = "F";
          triggerData = { kind: "missing" };
        } else {
          const validation = checks.validateEdgeCases(parsed, repoRoot);
          const failed = validation.filter((v) => !v.ok);
          if (failed.length > 0) {
            trigger = "F";
            triggerData = { kind: "invalid", failed };
          }
        }
      }

      // Не менять, потому что счёт идёт по ДОБАВЛЕННЫМ строкам (дельта new−old):
      // от полного new_string широкий контекстный якорь rename требовал бы ритуалов
      // на пустом месте.
      const securityPath = checks.hasSecuritySensitivePath(observableSrcEdits);
      const observableSrcSet = new Set(observableSrcFiles);
      const isObservableSrc = (fp) => observableSrcSet.has(fp);
      const addedNonTrivialLines =
        observableSrcEdits.length > 0
          ? checks.countNonTrivialDiffLines(lines, isObservableSrc, 20)
          : 0;
      const isTrivial = !securityPath && addedNonTrivialLines < 20;
      const premortemEnabled = process.env.MAIN_SKILL_VERIFY_PREMORTEM !== "0";

      // Не менять, потому что позиция блока не проверяется намеренно: блокировка не
      // отматывает время, ретро-премортем — единственное, что зуб может потребовать.
      if (
        !trigger &&
        premortemEnabled &&
        observableSrcEdits.length > 0 &&
        !isTrivial
      ) {
        const blocks = checks.findPremortemBlocks(lines);
        if (blocks.length === 0) {
          trigger = "N";
          triggerData = { kind: "missing", securityPath, addedNonTrivialLines };
        } else {
          // Не менять, потому что чинить Claude будет ПОСЛЕДНИЙ блок — его разбор и
          // должен попасть в reason.
          let anyValid = false;
          let lastValidation = [];
          for (const b of blocks) {
            const validation = checks.validatePremortem(
              checks.parsePremortemBlock(b.body),
            );
            lastValidation = validation;
            if (
              validation.length >= checks.PREMORTEM_MIN_ENTRIES &&
              validation.every((v) => v.ok)
            ) {
              anyValid = true;
              break;
            }
          }
          if (!anyValid) {
            trigger = "N";
            triggerData = {
              kind: "invalid",
              failed: lastValidation.filter((v) => !v.ok),
              validCount: lastValidation.filter((v) => v.ok).length,
            };
          }
        }
      }

      const VALID_REVIEW_MODES = new Set(["both", "code", "security", "0"]);
      const rawReviewMode = (
        process.env.MAIN_SKILL_VERIFY_REVIEW || "both"
      ).toLowerCase();
      const reviewMode = VALID_REVIEW_MODES.has(rawReviewMode)
        ? rawReviewMode
        : "both";
      const reviewWantCode = reviewMode === "both" || reviewMode === "code";
      const reviewWantSec = reviewMode === "both" || reviewMode === "security";
      // Не менять, потому что в суженных режимах =code/=security третья линза не
      // навязывается: это осознанная кастомизация юзера.
      const reviewWantEdge = premortemEnabled && reviewMode === "both";
      const reviewEnabled =
        reviewMode !== "0" && (reviewWantCode || reviewWantSec);

      if (!trigger && reviewEnabled && observableSrcEdits.length > 0) {
        const selfReview = checks.parseSelfReview(lastText);

        // Не менять, потому что `skipped:trivial` в нетривиальной правке обязан
        // блокировать: иначе строка-заглушка закрывает весь триггер J.
        if (!isTrivial) {
          if (!selfReview) {
            trigger = "J";
            triggerData = {
              kind: "missing",
              securityPath,
              addedNonTrivialLines,
              reviewMode,
            };
          } else if (selfReview.skippedTrivial) {
            trigger = "J";
            triggerData = {
              kind: "fake-skip",
              securityPath,
              addedNonTrivialLines,
              reviewMode,
            };
          } else {
            const missingSections = [];
            if (reviewWantCode && !selfReview.code)
              missingSections.push("code");
            if (reviewWantSec && !selfReview.security)
              missingSections.push("security");
            if (reviewWantEdge && !selfReview.edge)
              missingSections.push("edge");
            if (missingSections.length > 0) {
              trigger = "J";
              triggerData = {
                kind: "missing-sections",
                missingSections,
                reviewMode,
              };
            } else {
              // Не менять, потому что аномалия разбора транскрипта обязана считаться
              // «сабагент не запускался»: silent-exit здесь снимает весь триггер J.
              let calls;
              try {
                calls = checks.findReviewAgentCalls(lines);
              } catch {
                calls = {
                  code: false,
                  security: false,
                  edge: false,
                  edgeModel: "",
                };
              }
              const fakeSections = [];
              const sectionsRequiringCall = (sec) => {
                const e = selfReview[sec];
                if (!e) return false;
                if (e.status === "skipped") return false;
                return true;
              };
              if (
                reviewWantCode &&
                sectionsRequiringCall("code") &&
                !calls.code
              )
                fakeSections.push("code");
              if (
                reviewWantSec &&
                sectionsRequiringCall("security") &&
                !calls.security
              )
                fakeSections.push("security");
              if (
                reviewWantEdge &&
                sectionsRequiringCall("edge") &&
                !calls.edge
              )
                fakeSections.push("edge");
              if (fakeSections.length > 0) {
                trigger = "J";
                triggerData = { kind: "fake-decl", fakeSections, reviewMode };
              } else if (
                reviewWantEdge &&
                sectionsRequiringCall("edge") &&
                calls.edge &&
                checks.isWeakPremortemModel(calls.edgeModel)
              ) {
                // Не менять, потому что модель берётся из ПОСЛЕДНЕГО premortem-вызова: именно
                // его находки уходят в триаж.
                trigger = "J";
                triggerData = {
                  kind: "weak-edge-model",
                  model: calls.edgeModel,
                };
              } else {
                const needsTriage =
                  (reviewWantCode &&
                    selfReview.code &&
                    ["applied", "rejected", "deferred"].includes(
                      selfReview.code.status,
                    )) ||
                  (reviewWantSec &&
                    selfReview.security &&
                    ["applied", "rejected", "deferred"].includes(
                      selfReview.security.status,
                    )) ||
                  (reviewWantEdge &&
                    selfReview.edge &&
                    ["applied", "rejected", "deferred"].includes(
                      selfReview.edge.status,
                    ));
                if (needsTriage) {
                  const triage = checks.parseReviewTriage(lastText);
                  if (!triage || triage.entries.length === 0) {
                    trigger = "K";
                    triggerData = { kind: "missing" };
                  } else {
                    const validation = checks.validateReviewTriage(triage);
                    const failed = validation.filter((v) => !v.ok);
                    if (failed.length > 0) {
                      trigger = "K";
                      triggerData = { kind: "invalid", failed };
                    } else {
                      // Не менять, потому что edge гейтится наравне с остальными: иначе в режиме
                      // =code/=security триаж из одних edge-записей закрывает K впустую.
                      const wrongSource = triage.entries.filter(
                        (e) =>
                          e.valid &&
                          ((e.source === "code" && !reviewWantCode) ||
                            (e.source === "security" && !reviewWantSec) ||
                            (e.source === "edge" && !reviewWantEdge)),
                      );
                      if (wrongSource.length > 0) {
                        trigger = "K";
                        triggerData = {
                          kind: "wrong-source",
                          wrongSource,
                          reviewMode,
                        };
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (!trigger && !verifiedAfterEdit) {
        trigger = "A";
      }
    }
  }

  // Не менять, потому что L живёт вне observable-ветки: manifest-файлы
  // classify-ятся как config, и внутри ветки lastEditIdx для них -1.
  if (!trigger && hasSuccess && process.env.MAIN_SKILL_VERIFY_DEPS !== "0") {
    const addedDeps = checks.collectManifestDepsFromEdits(lines);
    if (addedDeps.length > 0) {
      let lastManifestEditIdx = -1;
      const MANIFEST_RE =
        /(^|\/)(package\.json|requirements[\w-]*\.txt|constraints\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Dockerfile(\.[\w-]+)?|\.nvmrc|\.python-version|\.tool-versions)$|(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
      for (const e of allEdits) {
        if (MANIFEST_RE.test(e.file_path)) lastManifestEditIdx = e.idx;
      }
      if (!(lastBlockIdx > lastManifestEditIdx)) {
        const lookupMap = checks.findVersionLookups(lines);
        const missing = checks.getDepsWithoutLookup(addedDeps, lookupMap);
        if (missing.length > 0) {
          trigger = "L";
          triggerData = { missing };
        }
      }
    }
  }

  if (!trigger) return;

  const hintsByKind = {
    frontend: [
      "  • headless browser (playwright / chrome-devtools-mcp / claude-in-chrome):",
      "    открыть route → HTTP 2xx документа+bundle, console без ошибок, DOM-маркер.",
      "  • curl http://localhost:PORT/route → статус + grep маркера в HTML.",
      "  • headless нет? → `npx playwright install chromium` (работает в контейнере без GUI).",
    ],
    backend: [
      "  • curl против реального endpoint → статус + body.",
      "  • pytest / go test / cargo test / npm test для изменённого модуля.",
      "  • прямой запуск: `python script.py` / `go run .` / `node cli.js` → stdout.",
    ],
    cli: [
      "  • прогон самой команды с осмысленными аргументами → exit code + stdout.",
      "  • regression-кейс через фикстуру, если CLI имеет тесты.",
    ],
    plugin: [
      '  • для slash-команд / hooks Claude Code — `claude -p "/namespace:command"` с бампом версии',
      "    и `claude plugin marketplace update` перед прогоном.",
      "  • для MCP — запусти сервер в фоне, дёрни инструмент через `claude -p` или curl.",
      "  • для skills — проверить автозагрузку в новой сессии (`claude` clean-start).",
    ],
    infra: [
      "  • `docker-compose up --abort-on-container-exit` → все сервисы healthy.",
      "  • `docker build .` → successful, затем `docker run` → ожидаемый output.",
      "  • Makefile/justfile target — прогнать и проверить exit code.",
    ],
  };
  const hints = (
    hintsByKind[lastEditKind] || [
      "  • запусти изменённый код как его запустит пользователь → статус / output / ошибка.",
    ]
  ).join("\n");

  const reasonA = [
    "[main-skill:verify-changes] Stop заблокирован (триггер A: success без верификации).",
    "",
    `Ты правил observable-файл (${lastEditKind}) и заявил «готово» без реальной проверки`,
    "ПОСЛЕ правки. Запрещено правилом workflow-rules §3.",
    "",
    "Сделай минимум одно прямо сейчас:",
    hints,
    "",
    "Если верификация реально невозможна — покажи попытки (lsof/which/npx install/curl",
    "с ошибкой) и используй дисклеймер. Без попыток дисклеймер тоже блочится (триггер B).",
  ].join("\n");

  const reasonB = [
    "[main-skill:verify-changes] Stop заблокирован (триггер B: дисклеймер без попытки).",
    "",
    `Ты правил ${lastEditKind} и сослался на «не проверил / нет доступа», но в сессии НЕ`,
    "выполнил ни одной попытки разведать окружение. Это лень под видом честности.",
    "",
    "Минимальная разведка:",
    "  • lsof -i :PORT / ss -tlnp / netstat — есть ли процесс.",
    "  • which / command -v — что установлено.",
    "  • npx playwright install chromium / pip install / npm i — поставить чего нет.",
    "  • curl -fsS http://... — даже connection refused это инфа.",
    "  • docker-compose up -d → попробовать поднять окружение.",
    "",
    "После реальной попытки:",
    "  • получилось — отчитайся с пруфами (статус, snippet, output).",
    "  • нет — дисклеймер легитимен: «Фикс применён. End-to-end НЕ проверил:",
    "    <конкретная техническая причина с цитатой ошибки>. Проверь вручную: <шаги>».",
    "",
    "Опт-аут (редко): export MAIN_SKILL_VERIFY_CHANGES=0",
  ].join("\n");

  const reasonC = [
    "[main-skill:verify-changes] Stop заблокирован (триггер C: делегирование shell).",
    "",
    "Ты попросил пользователя выполнить shell-команду у себя, но в ЭТОЙ ЖЕ сессии",
    "ты сам использовал Bash — значит доступ есть. Не перекладывай ручную работу.",
    "",
    "Сделай одно из:",
    "  • Запусти команду сам через Bash, отчитайся результатом.",
    "  • Если команда ТРЕБУЕТ интерактива (gcloud auth login, ssh-agent, GUI) —",
    "    скажи это явно и объясни, какой конкретно шаг требует участия пользователя.",
    "",
    "Опт-аут (редко): export MAIN_SKILL_VERIFY_CHANGES=0",
  ].join("\n");

  // Не менять, потому что имя для grep приходит из недоверенного транскрипта:
  // sanitize стрипует controls/BiDi, но не шелл-метасимволы — нужны allowlist
  // [A-Za-z0-9._-] и -F.
  const grepPat = (() => {
    if (!triggerData?.truncatedScans?.length) return "";
    const f0 = String(triggerData.truncatedScans[0]);
    const bare = path
      .basename(f0, path.extname(f0))
      .replace(/[^A-Za-z0-9._-]/g, "")
      .slice(0, 100);
    return bare || "<имя-файла>";
  })();
  const truncD = triggerData?.truncatedScans?.length
    ? [
        "",
        `⚠ Для файлов ниже import-scan ОБОРВАН бюджетом (лимит ${checks.importScanMaxFiles()} спеков / кап списка) —`,
        "  покрытие центральным спеком НЕ подтверждено, но и НЕ опровергнуто:",
        ...triggerData.truncatedScans.map((f) => `  • ${sanitize(f)}`),
        "  Прежде чем писать тест — проверь grep-ом (он без лимита), например:",
        `  grep -rlF "${grepPat}" <tests-диры пакета> --include="*.spec.*" --include="*.test.*"`,
        "  Спек с импортом есть → подними лимит: MAIN_SKILL_IMPORT_SCAN_MAX_FILES=1000",
        "  (или добавь УЗКИЙ ignore-глоб на файл). Спека нет → пиши тест.",
      ]
    : [];
  const reasonD = [
    "[main-skill:verify-changes] Stop заблокирован (триггер D: src-файл без парного test-файла).",
    "",
    "Ты правил observable src-файлы, но для них нет парного test-файла ни в репо,",
    "ни среди правок этой сессии. Запрещено правилом workflow-rules §3 (Edge-case discipline).",
    "",
    "Файлы без тестов:",
    ...(triggerData?.missingTests || []).map((f) => `  • ${sanitize(f)}`),
    ...truncD,
    "",
    "Конвенции, по которым ищу парный тест (mirror-discovery в monorepo):",
    "  • <name>.test.<ext> / <name>.spec.<ext> рядом с src",
    "  • __tests__/<name>.<ext> / __tests__/<name>.test.<ext> (включая src/__tests__/)",
    "  • tests/<name>.test.<ext> / test/<name>.spec.<ext> рядом с src (src/tests/x.test.ts)",
    "  • tests/unit/<name>.<ext> / tests/<name>.test.<ext> относительно package-root",
    "    (package-root = директория с package.json/pyproject.toml/Cargo.toml/go.mod/...)",
    "  • mirror src/<rel>/X ↔ tests/<rel>/X.spec, __tests__/<rel>/X.test",
    "  • централизованный спек с ЛЮБЫМ именем (по фиче), ИМПОРТИРУЮЩИЙ правленый файл",
    "    (tests/ | test/ | spec/ | specs/ | __tests__/ от package-root; import/require/",
    "    from/vi.mock, включая #алиасы и относительные пути)",
    "  • для .vue / .svelte / .astro <ext> теста = .ts/.tsx/.js/.jsx/.mjs/.cjs",
    "    (App.vue ↔ App.spec.ts, Card.svelte ↔ Card.svelte.test.ts)",
    "  • Python: test_<name>.py / <name>_test.py / tests/test_<name>.py",
    "  • Go: <name>_test.go рядом",
    "  • Ruby: <name>_test.rb / <name>_spec.rb; app/<g>/X.rb ↔ spec/<g>/X_spec.rb",
    "  • Java/Kotlin Maven: src/main/<lang>/X ↔ src/test/<lang>/XTest",
    "  • PHP: tests/(Unit|Feature|Integration)/<rel>/<Base>Test.php",
    "  • Swift SPM: Sources/<Module>/X.swift ↔ Tests/<Module>Tests/XTests.swift",
    "",
    "Авто-skip: миграции, seeders, fixtures, locales, *.d.ts, *.generated.*, *.gen.*,",
    "  framework-configs (vite/next/nuxt/playwright/adonisrc/...), start/, bootstrap/,",
    "  providers/*_provider.(ts|js), bin/(server|console|test).(ts|js), ace.js — AdonisJS wiring,",
    "  infra/ infrastructure/, __mocks__/, *.stories.{tsx,jsx,ts,js},",
    "  операционные shell-скрипты (install/deploy/bootstrap/setup/provision/teardown/",
    "  sync-config + опц. [-_]суффикс: deploy-server.sh, setup-test-db.sh),",
    "  файлы с @generated заголовком, type-only TS-файлы (только interface/type/enum),",
    "  декларативные ORM-модели (Lucid `extends BaseModel` / TypeORM `@Entity`: только",
    "  @column/relations/declare-поля и static-константы; @computed/get-set/hook/метод/",
    "  serialize-стрелка — уже логика, тест ОБЯЗАТЕЛЕН; не игнорь models/ каталогом),",
    "  файлы вне repoRoot (throwaway-скрипты в /tmp) и удалённые к моменту Stop.",
    "Стили и разметка (.css/.scss/.sass/.less/.html) исключены из code-файлов —",
    "  на них trigger D не срабатывает (визуальная верификация, не unit-тест).",
    "",
    "SFC (.vue/.svelte/.astro): авто-skip ТОЛЬКО для презентационных — template/markup",
    "  без логики в <script> (либо script отсутствует, либо в нём лишь import /",
    "  defineProps / defineEmits / типы). Если в <script> есть computed/watch/функция/",
    "  control-flow/await/.map().filter()/Options-methods — это логика, и тест ОБЯЗАТЕЛЕН.",
    "  Не игнорь .vue целиком по расширению: глобальный `**/*.vue` спрячет и логику тоже.",
    "",
    "Сделай: напиши тесты → прогони → отчитайся.",
    "",
    "Тесты в репо лежат ОТДЕЛЬНЫМ каталогом (tests/), имена спеков — по фиче, не по",
    "  источнику? Такая раскладка засчитывается АВТОМАТИЧЕСКИ: спек, импортирующий",
    "  правленый файл, снимает D (см. конвенцию выше). Раз ты видишь этот блок —",
    "  спека с импортом файла я не нашёл (порядок — по релевантности файлу,",
    "  бюджет — MAIN_SKILL_IMPORT_SCAN_MAX_FILES, дефолт 200):",
    "  допиши покрытие в существующий спек (импорт + ассерты) или создай парный по",
    "  конвенциям. Не плоди дубль-тесты рядом с кодом против конвенции проекта и",
    "  НЕ выписывай каталожный ignore-глоб.",
    "Опт-аут целиком: MAIN_SKILL_VERIFY_CHANGES=0",
    "Per-project ignore — ТОЛЬКО узкий глоб по имени/расширению конкретных нетестируемых",
    "  файлов, НЕ каталог целиком (широкий `dir/**` спрячет и тестируемую логику рядом и",
    "  отклоняется ignore-glob-guard при записи):",
    '  MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/*.gen.ts:src/generated/schema.ts" (через `:`).',
    "  Центральные спеки принципиально не импортируют исходники (чистый HTTP-flow",
    "  через клиент)? Только тогда снимай D на проект: MAIN_SKILL_VERIFY_CHANGES=0.",
  ].join("\n");

  const reasonE = [
    "[main-skill:verify-changes] Stop заблокирован (триггер E: критичный endpoint без endpoint-level теста).",
    "",
    "Ты правил controller/route на критичном пути (auth / деньги / доступ) либо с",
    "мутирующим handler-ом (POST/PUT/PATCH/DELETE, destroy/store/update) — для него",
    "обязателен тест, бьющий по реальному endpoint. Дефолт — integration через",
    "@japa/api-client / supertest (быстрый, без браузера); e2e (playwright / cypress) —",
    "только если это сквозной критичный user-journey. Unit-тест на сервис не считается.",
    "",
    "Без endpoint-теста:",
    ...(triggerData?.missingE2e || []).map((f) => `  • ${sanitize(f)}`),
    "",
    "Ищу в: tests/functional/, tests/e2e/, tests/integration/, e2e/, cypress/e2e/, playwright/.",
    "Рядовых CRUD-роутов E не касается — их покрывает триггер D (парный тест любого слоя).",
    "",
    "Опт-аут (если endpoint-тесты в проекте реально не предусмотрены): MAIN_SKILL_VERIFY_CHANGES=0",
  ].join("\n");

  const reasonM = [
    "[main-skill:verify-changes] Stop заблокирован (триггер M: фронт-правка без render-проверки).",
    "",
    "После последней правки frontend-файлов нет ни одного render-класса прогона",
    "(headless browser / curl localhost / активный браузер-MCP). Unit-тесты в jsdom",
    "рендер НЕ проверяют — нет layout-движка: «не отрисовалось», «текст за полем»,",
    "«окна внахлёст» они не ловят.",
    "",
    "Не отрендерено после правки:",
    ...(triggerData?.unrendered || []).map((f) => `  • ${sanitize(f)}`),
    "",
    "Минимум: подними dev-server и `curl -s localhost:PORT/<route>` → status + grep DOM-маркера.",
    "Лучше: headless playwright — открой route, console clean, DOM-маркер, скриншот если визуально.",
    "Рецепт layout-oracle (клиппинг/наложение геометрией, без пикселей): references/testing-strategy.md.",
    "",
    "Опт-аут: MAIN_SKILL_VERIFY_RENDER=0 (весь хук: MAIN_SKILL_VERIFY_CHANGES=0).",
  ].join("\n");

  const reasonF = (() => {
    if (triggerData?.kind === "missing") {
      return [
        "[main-skill:verify-changes] Stop заблокирован (триггер F: нет декларации edge-cases).",
        "",
        "Ты заявил «готово» после observable-правки, но не вывел блок <edge-cases>",
        "с перечислением покрытых тестами edge-кейсов. Это требование workflow-rules §3.",
        "",
        "Формат (одной строкой через `;` или построчно):",
        "  <edge-cases>",
        "  empty:tests/auth.test.ts:test_empty_password;",
        "  expired_token:tests/auth.test.ts:test_expired_remember;",
        "  race:tests/auth.test.ts:test_concurrent_login",
        "  </edge-cases>",
        "",
        "Каждая запись — name:test_file:test_name. Хук проверит существование test_file",
        "и наличие it/test/describe/def с этим именем; для тест-именованных *.sh",
        "(*.test.sh / tests/…) — лейбла `ok - …`/`not ok - …`, строки assert-хелпера",
        "или комментария-заголовка блока (`# 7d. …`).",
        "",
        "Минимум edge-кейсов из workflow-rules §3:",
        "  • non-existent / deleted resource",
        "  • empty state (zero items / null / whitespace)",
        "  • boundary values (max length / overflow / off-by-one)",
        "  • concurrency / races",
        "  • external failures (timeout / 5xx / rate limit)",
        "  • malformed / hostile input",
        "  • permission / auth edge states",
        "  • browser / UX edge states (для frontend)",
        "",
        "Если кейс реально N/A для этой задачи — пиши явно: name:N/A:<обоснование>.",
        "",
        "Опт-аут (редко): MAIN_SKILL_VERIFY_CHANGES=0",
      ].join("\n");
    }
    const failed = triggerData?.failed || [];
    return [
      "[main-skill:verify-changes] Stop заблокирован (триггер F: декларация edge-cases невалидна).",
      "",
      "Невалидные записи в блоке <edge-cases>:",
      ...failed
        .slice(0, 10)
        .map(
          (v) =>
            `  • ${sanitize(trunc(v.entry?.raw || "<unparsed>"))} — ${sanitize(trunc(v.reason, 300))}`,
        ),
      ...(failed.length > 10 ? [`  … и ещё ${failed.length - 10}`] : []),
      "",
      "Каждая запись должна быть name:test_file:test_name; test_file существует;",
      "в нём — it/test/describe/def, чьё имя содержит test_name (case-insensitive);",
      "для тест-именованных *.sh (*.test.sh / tests/…) — лейбл `ok - …`/`not ok - …`,",
      "строка assert-хелпера или комментарий-заголовок блока с test_name.",
      "",
      "Опт-аут (редко): MAIN_SKILL_VERIFY_CHANGES=0",
    ].join("\n");
  })();

  const reasonG = [
    "[main-skill:verify-changes] Stop заблокирован (триггер G: лайнтер красный).",
    "",
    `Команда: ${triggerData?.cmd || "<lint>"}`,
    "Exit-код ≠ 0. Workflow-rules §3 требует зелёные линтеры + форматтеры перед done.",
    "",
    "Output (хвост):",
    ...(triggerData?.output || "")
      .split("\n")
      .slice(-30)
      .map((l) => `  ${l}`),
    "",
    "Опт-аут (редко): MAIN_SKILL_VERIFY_LINT=0 (отдельно от MAIN_SKILL_VERIFY_CHANGES).",
  ].join("\n");

  const reasonH = [
    "[main-skill:verify-changes] Stop заблокирован (триггер H: public surface без обновления доков).",
    "",
    "Ты изменил public-surface файлы, но НЕ тронул ни один *.md / docs/* в этой сессии.",
    "CLAUDE.md плагина: «Меняешь поведение/контракт/CLI/конфиг — обнови доки в том же изменении».",
    "",
    "Public surface tронут:",
    ...(triggerData?.publicEdits || []).map((f) => `  • ${sanitize(f)}`),
    "",
    "Сделай: пройди grep по старому контракту, обнови README / SKILL.md / docs/* в той же сессии.",
    "",
    "Опт-аут (редко): MAIN_SKILL_VERIFY_CHANGES=0",
  ].join("\n");

  const reasonJ = (() => {
    const baseHead =
      "[main-skill:verify-changes] Stop заблокирован (триггер J: нет валидного <self-review> блока).";
    const formatHelp = [
      "Формат:",
      "  <self-review>",
      "  code:<status>[:<reason>]",
      "  security:<status>[:<reason>]",
      "  edge:<status>[:<reason>]        ← premortem-линза (в режиме both)",
      "  </self-review>",
      "",
      "Per-section статусы: applied | rejected | deferred | none-found.",
      "Целиком пропустить можно ТОЛЬКО если diff < 20 добавленных нетривиальных observable-строк И",
      "не затронут security-sensitive путь:",
      "  <self-review>skipped:trivial</self-review>",
      "Per-section `code:skipped` / `security:skipped` НЕ принимается — это был bypass.",
    ];
    const howTo = [
      "Что должен сделать:",
      "  1. Параллельно запусти ТРИ сабагента в одном сообщении (один Tool message, три Task/Agent call):",
      '       • code-review — Task/Agent(subagent_type="general-purpose") с требованием в',
      "         промпте провести code review;",
      '       • security-review — Task/Agent(subagent_type="general-purpose") с промптом',
      "         «security review по OWASP Top-10 + injection / auth-bypass / SSRF / weak-crypto /",
      "         secret leaks» на конкретные изменённые файлы;",
      '       • premortem-review — Task/Agent(subagent_type="general-purpose") с промптом',
      "         «премортем: top-5 гипотез, что сломается в проде — система + точное ограничение",
      "         с числом + ломающий вход + симптом; generic запрещён; не уверен в лимите —",
      "         WebFetch официальных доков» на те же файлы.",
      "  2. По каждому замечанию — пункт в <review-triage> блоке (триггер K); источник",
      "     находок premortem-линзы — edge:.",
      "  3. Применить applied / обосновать rejected/deferred с техническим аргументом.",
      "  4. Один проход. Повторный запуск review-агентов перед Stop запрещён.",
      "",
      "Гейт «Do not call the AgentTool unless the user requested it» в системном промпте — не препятствие:",
      "workflow-rules и этот блок — явный запрос пользователя, запуск трёх ревью-сабагентов авторизован.",
      "",
      "Опт-аут: MAIN_SKILL_VERIFY_REVIEW=0 (целиком) | =code (только code) | =security (только security);",
      "edge-секцию отключает MAIN_SKILL_VERIFY_PREMORTEM=0.",
    ];
    if (triggerData?.kind === "fake-skip") {
      return [
        baseHead.replace(
          "нет валидного <self-review> блока",
          "фейковый skipped:trivial",
        ),
        "",
        `Ты пометил <self-review>skipped:trivial</self-review>, но diff НЕ тривиальный:`,
        `  • добавленных non-trivial строк: ${triggerData.addedNonTrivialLines} (порог skip: < 20)`,
        `  • security-sensitive путь затронут: ${triggerData.securityPath ? "да" : "нет"}`,
        "",
        "Self-review обязателен. " +
          (triggerData.securityPath
            ? "Особенно тут — затронут auth/api/sql/crypto/payment/admin/session/token/..."
            : "Diff ≥ 20 добавленных нетривиальных observable-строк."),
        "",
        ...howTo,
      ].join("\n");
    }
    if (triggerData?.kind === "missing-sections") {
      return [
        baseHead.replace(
          "нет валидного <self-review> блока",
          "не все секции в <self-review>",
        ),
        "",
        `Режим: MAIN_SKILL_VERIFY_REVIEW=${triggerData.reviewMode}`,
        `Отсутствуют секции: ${triggerData.missingSections.join(", ")}`,
        "",
        ...formatHelp,
        "",
        ...howTo,
      ].join("\n");
    }
    if (triggerData?.kind === "fake-decl") {
      return [
        baseHead.replace(
          "нет валидного <self-review> блока",
          "декларация без реального запуска review-агента",
        ),
        "",
        `Ты задекларировал секции [${triggerData.fakeSections.join(", ")}] в <self-review>, но в`,
        "transcript этой сессии НЕТ соответствующих сабагент-вызовов (Task/Agent). Это враньё под видом дисциплины.",
        "",
        "Что считается реальным запуском:",
        '  • code  — Task/Agent с subagent_type содержащим "code-review*" или промптом упоминающим code review.',
        '  • security — Task/Agent с subagent_type содержащим "security" ИЛИ промптом упоминающим OWASP /',
        "    injection / auth bypass / secret leak / XSS / CSRF / SSRF / RCE / TOCTOU / weak crypto.",
        '  • edge — Task/Agent с промптом/описанием, содержащим "premortem" / «премортем».',
        "",
        ...howTo,
      ].join("\n");
    }
    if (triggerData?.kind === "weak-edge-model") {
      return [
        baseHead.replace(
          "нет валидного <self-review> блока",
          "premortem-линза запущена на haiku",
        ),
        "",
        `premortem-агент вызван с model="${sanitize(trunc(triggerData.model, 60))}".`,
        "workflow-rules §self-review требует для этой линзы sonnet и дословно «не haiku»:",
        "ценность премортема — специфичность гипотез (точные лимиты, коды ошибок, цитаты доков),",
        "именно она первой деградирует на самой дешёвой модели. Экономия здесь покупается за счёт",
        "того единственного, ради чего линза запускается.",
        "",
        'Что сделать: перезапусти premortem-агента с model="sonnet" (или без override — тогда',
        "наследуется модель сессии) и обнови секцию edge: в <self-review> по его находкам.",
        "Правило «один проход» здесь не действует — прогон на haiku не засчитан.",
        "",
        "Учти: реально исполненная модель могла отличаться от запрошенной — её переопределяют",
        "CLAUDE_CODE_SUBAGENT_MODEL и организационный availableModels-allowlist, а хук видит",
        "только то, что ты написал в вызове. Если модель форсится извне — это ложное срабатывание,",
        "снимается опт-аутом ниже.",
        "",
        "Опт-аут: MAIN_SKILL_VERIFY_PREMORTEM=0 (снимает edge-секцию и триггер N целиком).",
      ].join("\n");
    }
    return [
      baseHead,
      "",
      "Ты правил observable код и заявил «готово», но не выполнил self-review своими силами.",
      "Это требование workflow-rules §4: после execution, до Stop, обязан прогнать code+security",
      "ревью через суб-агентов и зафиксировать результат блоком <self-review>.",
      "",
      `Диагностика (почему J активирован):`,
      `  • добавленных non-trivial observable строк: ${triggerData?.addedNonTrivialLines ?? "?"} (порог skip: < 20)`,
      `  • security-sensitive путь затронут: ${triggerData?.securityPath ? "да" : "нет"}`,
      `  • режим: MAIN_SKILL_VERIFY_REVIEW=${triggerData?.reviewMode ?? "both"}`,
      "",
      "Тривиальные правки (< 20 добавленных нетривиальных observable-строк И не auth/api/sql/crypto/...)",
      "self-review не требуют — у тебя случай иной.",
      "",
      ...formatHelp,
      "",
      ...howTo,
    ].join("\n");
  })();

  const reasonK = (() => {
    const baseHead =
      "[main-skill:verify-changes] Stop заблокирован (триггер K: нет валидного <review-triage> блока).";
    const formatHelp = [
      "Формат: одна запись на строку, формат `<source>:<id>:<status>:<reason>`.",
      "  source ∈ { code, security }",
      "  status ∈ { applied, rejected, deferred }",
      "",
      "Пример:",
      "  <review-triage>",
      "  code:1:applied:src/auth.ts:42-58 — добавил early-return на null user",
      "  code:2:deferred:rate-limit на /login — нет данных по нагрузке, см. issue #123",
      "  code:3:rejected:async/await в logger — fire-and-forget намеренно, потеря лога приемлемее блокировки запроса",
      "  security:1:applied:src/auth.ts:120 — sanitize redirect_to через allowlist",
      "  security:2:rejected:CSRF на /logout — endpoint POST + SameSite=Strict cookie",
      "  </review-triage>",
    ];
    const slopHelp = [
      "rejected/deferred с slop-обоснованием (только «minor», «несущественно», «вне scope», «стилистика»,",
      "«мелочь», «cosmetic», «not critical» и т.п.) без технического раскрытия — БЛОКИРУЕТСЯ.",
      "Раскрой каждое отвергнутое замечание: file:line, конкретный риск, метрика, цитата кода.",
    ];
    if (triggerData?.kind === "invalid") {
      return [
        baseHead.replace(
          "нет валидного <review-triage> блока",
          "невалидные записи в <review-triage>",
        ),
        "",
        "Невалидные записи:",
        ...(triggerData.failed || [])
          .slice(0, 10)
          .map(
            (v) =>
              `  • ${sanitize(trunc(v.entry?.raw || "<unparsed>"))} — ${sanitize(trunc(v.reason, 300))}`,
          ),
        ...((triggerData.failed || []).length > 10
          ? [`  … и ещё ${(triggerData.failed || []).length - 10}`]
          : []),
        "",
        ...slopHelp,
        "",
        ...formatHelp,
      ].join("\n");
    }
    if (triggerData?.kind === "wrong-source") {
      return [
        baseHead.replace(
          "нет валидного <review-triage> блока",
          "записи в <review-triage> для отключённой секции",
        ),
        "",
        `Режим: MAIN_SKILL_VERIFY_REVIEW=${triggerData.reviewMode}`,
        "Записи относятся к секции, которая отключена флагом (edge гейтится и",
        "MAIN_SKILL_VERIFY_PREMORTEM) — это означает что ты их выдумал или забыл переключить режим:",
        ...(triggerData.wrongSource || [])
          .slice(0, 10)
          .map((e) => `  • ${sanitize(trunc(e.raw))}`),
      ].join("\n");
    }
    return [
      baseHead,
      "",
      "В <self-review> ты заявил applied/rejected/deferred — значит у ревьюеров были замечания.",
      "Workflow-rules §4: каждое замечание обязано пройти пунктный триаж в блоке <review-triage>",
      "с явным решением и техническим обоснованием. Это форс-функция против performative-dismissal",
      "(«остальное minor, поехали»).",
      "",
      ...slopHelp,
      "",
      ...formatHelp,
    ].join("\n");
  })();

  const reasonN = (() => {
    const head =
      "[main-skill:verify-changes] Stop заблокирован (триггер N: нет валидного премортем-блока).";
    const formatHelp = [
      `Формат: минимум ${checks.PREMORTEM_MIN_ENTRIES} гипотезы, одна на строку; каждая с точным фактом —`,
      "число (лимит / код ошибки / таймаут; нумерация строк не считается), идентификатор кода",
      "или термин механизма отказа (идемпотентность / ретрай / кодировка / гонка / …); generic не проходит.",
      "Пример ниже намеренно закомментирован (#-строки парсер игнорирует) — его копипаста",
      "триггер НЕ закроет, пиши гипотезы про СВОЮ правку:",
      "  <premortem>",
      "  # telegram sendMessage: text >4096 символов → 400 MESSAGE_TOO_LONG, отчёт потерян → чанковать по 4000",
      "  # parse_mode=Markdown: `*`/`_` в юзер-тексте → 400 can't parse entities → escape перед вставкой",
      "  # рассылка по chatIds в цикле → 429 при превышении rate limit → троттлинг + уважать retry_after",
      "  </premortem>",
    ];
    const ritual = [
      "Проведи премортем СЕЙЧАС — ретроспективно, против уже написанного кода:",
      "  1. Перечисли внешние системы/контракты, которых касается правка: лимиты API",
      "     (длина/размер/rate), форматы, таймауты, ретраи/идемпотентность, кодировки, конкурентность.",
      "  2. Не уверен в точном лимите/коде ошибки — WebFetch официальных доков, не угадывай.",
      "  3. Каждая гипотеза: конкретный вход/состояние → наблюдаемый отказ → решение.",
      "  4. Гипотеза реальна и не покрыта кодом → добавь guard + тест (и запись в <edge-cases>).",
      "Заметь: self-review (триггер J) дополнительно требует ОТДЕЛЬНОГО premortem-review",
      "сабагента — запусти его параллельно с code/security-review, не дожидаясь блока J.",
      "В следующий раз блок обязан появиться ДО первой правки кода (workflow-rules §2) —",
      "сомнение до кода дешевле ретро-разбора.",
    ];
    const optOut =
      "Опт-аут: MAIN_SKILL_VERIFY_PREMORTEM=0 — и только он: MAIN_SKILL_VERIFY_REVIEW=0" +
      "\nтриггер N НЕ отключает (весь хук целиком: MAIN_SKILL_VERIFY_CHANGES=0).";
    if (triggerData?.kind === "invalid") {
      const failed = triggerData.failed || [];
      return [
        head.replace(
          "нет валидного премортем-блока",
          "премортем-блок невалиден",
        ),
        "",
        `В последнем блоке <premortem> валидных гипотез: ${triggerData.validCount ?? 0}` +
          ` (нужно ≥ ${checks.PREMORTEM_MIN_ENTRIES}, и все записи блока должны быть валидны).` +
          (failed.length ? " Невалидные записи:" : ""),
        ...failed
          .slice(0, 10)
          .map(
            (v) =>
              `  • ${sanitize(trunc(v.entry?.raw || "<unparsed>"))} — ${sanitize(trunc(v.reason, 300))}`,
          ),
        ...(failed.length > 10 ? [`  … и ещё ${failed.length - 10}`] : []),
        "",
        ...formatHelp,
        "",
        ...ritual,
        "",
        optOut,
      ].join("\n");
    }
    return [
      head,
      "",
      "Правка нетривиальна (" +
        (triggerData?.securityPath
          ? "затронут security-sensitive путь"
          : `${triggerData?.addedNonTrivialLines ?? "?"} добавленных нетривиальных строк, порог 20`) +
        "), а в сессии нет блока <premortem>",
      "с гипотезами «что сломается в проде». Workflow-rules §2: премортем обязателен",
      "ДО первой observable-правки — happy-path bias ловится до кода, не после.",
      "",
      ...ritual,
      "",
      ...formatHelp,
      "",
      optOut,
    ].join("\n");
  })();

  const reasonL = (() => {
    const missing = triggerData?.missing || [];
    const byType = {};
    for (const d of missing) {
      const k = d.type;
      (byType[k] = byType[k] || []).push(d);
    }
    const lookupCmd = {
      npm: "npm view <pkg> version  (или: pnpm/yarn/bun view|info|show <pkg>)",
      pip: "pip index versions <pkg>",
      cargo: "cargo search <pkg> --limit 1",
      go: "go list -m -versions <module>",
      docker:
        "docker manifest inspect <image>:<tag> или https://hub.docker.com/_/<image>",
      "gh-action":
        "gh api repos/<org>/<repo>/releases/latest или https://github.com/<org>/<repo>/releases",
      runtime:
        "https://endoflife.date/api/<product>.json (node: https://nodejs.org/dist/index.json)",
    };
    const head = [
      "[main-skill:verify-changes] Stop заблокирован (триггер L: dep добавлен без version-lookup).",
      "",
      "Ты добавил/обновил зависимость(и) в manifest-файле, но в этой сессии НЕ запросил",
      "актуальную версию из реестра. Знания модели о версиях устаревают на месяцы —",
      "правило workflow-rules «Свежие версии при init / add-dep» обязывает сделать lookup",
      "в реестре до выбора версии.",
      "",
      "Зависимости без lookup-а:",
    ];
    const body = [];
    for (const [type, deps] of Object.entries(byType)) {
      body.push(`  ${type}:`);
      for (const d of deps) {
        body.push(
          `    • ${sanitize(d.name)}@${sanitize(d.version)} (${sanitize(d.file_path)})`,
        );
      }
      body.push(`    → запусти: ${lookupCmd[type] || "<реестр>"}`);
    }
    const tail = [
      "",
      "После lookup-а: используй latest stable / LTS. В существующем проекте latest",
      "подчинён совместимости — если peer-dep / project-target / другой пакет требует ≤N,",
      "бери максимально свежую совместимую и объяви ограничение в формате",
      "«ставлю X@N вместо latest M, потому что Y требует ≤N».",
      "",
      "Любое другое отклонение от latest (личное предпочтение, опасение, привычка) —",
      "спроси «использую X вместо latest Y, причина: Z — ок?» и дождись ack.",
      "",
      "Опт-аут (для проектов с фиксированным стеком): MAIN_SKILL_VERIFY_DEPS=0",
    ];
    return [...head, ...body, ...tail].join("\n");
  })();

  const reasonByTrigger = {
    A: reasonA,
    B: reasonB,
    C: reasonC,
    D: reasonD,
    E: reasonE,
    F: reasonF,
    G: reasonG,
    H: reasonH,
    J: reasonJ,
    K: reasonK,
    M: reasonM,
    L: reasonL,
    N: reasonN,
  };
  const reason = reasonByTrigger[trigger] || reasonA;
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

// Не менять, потому что оценивать можно только текст, после которого нет
// tool_use: промежуточный нарратив даёт ложный success-триггер, а при
// flush-гонке — блок по устаревшему сообщению.
function findLastAssistantText(lines) {
  let sawToolUseAfter = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = lines[i];
    if (!e || e.type !== "assistant") continue;
    const content = e.message?.content || [];
    const hasToolUse = content.some((b) => b && b.type === "tool_use");
    const text = content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
      .trim();
    if (text && !hasToolUse && !sawToolUseAfter) return text;
    if (hasToolUse) sawToolUseAfter = true;
  }
  return "";
}
