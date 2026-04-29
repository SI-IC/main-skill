#!/usr/bin/env node
// Stop hook: блокирует завершение, если ассистент заявил «готово/done/работает»
// после правки observable-файла (frontend, backend, CLI, MCP plugin, etc.), но
// не выполнил ни одной реальной верификации ПОСЛЕ последней правки.
//
// Триггеры:
//   A — success-слово («готово», «fixed», «pushed», ...) БЕЗ верификации.
//   B — дисклеймер («не проверил», «проверь вручную») БЕЗ попыток разведки.
//   C — делегирование shell-команды пользователю при наличии своего Bash.
//   D — observable src без парного *.test.* / *.spec.* / __tests__/.
//   E — controller / route / api-handler без e2e-парного теста.
//   F — отсутствует или невалиден блок <edge-cases>.
//   G — npm run lint / ruff / golangci-lint / cargo clippy exit ≠ 0.
//   H — public surface изменён без обновления *.md / docs/* в этой же сессии.
//   J — нет валидного <self-review> блока (code+security ревью своими силами).
//   K — <review-triage> отсутствует / невалиден / содержит slop-only обоснования.
//
// Опт-ауты:
//   MAIN_SKILL_VERIFY_CHANGES=0   — все триггеры выкл.
//   MAIN_SKILL_VERIFY_LINT=0      — выкл только G.
//   MAIN_SKILL_VERIFY_REVIEW=0    — выкл J/K.
//   MAIN_SKILL_VERIFY_REVIEW=code — требовать только code-review секцию.
//   MAIN_SKILL_VERIFY_REVIEW=security — требовать только security-review секцию.
// Старое имя переменной тоже уважается: MAIN_SKILL_VERIFY_FRONTEND=0.

const fs = require("fs");
const path = require("path");
const checks = require("./lib/checks");

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
  if (
    process.env.MAIN_SKILL_VERIFY_CHANGES === "0" ||
    process.env.MAIN_SKILL_VERIFY_FRONTEND === "0"
  ) {
    return;
  }

  const tp = p.transcript_path;
  if (!tp || !fs.existsSync(tp)) return;

  const lines = fs
    .readFileSync(tp, "utf8")
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

  // Классификация правок по типам. Не вся правка триггерит хук — только observable.
  const classify = (fp = "") => {
    const f = String(fp);
    // Явно не observable: docs, config, lockfiles, assets.
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

    // Plugin behaviour-files — приоритет над docs, потому что .md в skills/ это runtime.
    if (/(^|\/)\.claude-plugin\//.test(f)) return "plugin";
    if (/(^|\/)\.claude\/(settings|hooks|commands)/.test(f)) return "plugin";
    if (
      /(^|\/)(hooks|commands|skills|agents)\/.*\.(md|mdx|sh|js|ts|mjs|cjs|py|json|ya?ml)$/i.test(
        f,
      )
    )
      return "plugin";

    // Docs — после plugin.
    if (/\.(md|mdx|txt|rst|adoc)$/i.test(f)) return "docs";

    // Observable
    if (/\.(tsx|jsx|vue|svelte|astro|html|htm)$/i.test(f)) return "frontend";
    if (/\.(css|scss|sass|less|styl|stylus)$/i.test(f)) return "frontend";
    if (
      /\.(py|go|rs|rb|java|kt|kts|scala|php|cs|fs|fsx|ex|exs|clj|cljs|erl|hs|ml|mli|swift|dart|lua|sh|bash|zsh|fish|ps1|sql)$/i.test(
        f,
      )
    )
      return "backend";
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(f)) return "backend"; // JS/TS по умолчанию backend (frontend уже поймали выше)
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
  let lastAttemptIdx = -1;
  let lastBlockIdx = -1;
  let lastDelegableBashIdx = -1; // последний Bash запуск самого Claude — доказывает наличие Bash-доступа

  lines.forEach((e, idx) => {
    if (e.type !== "assistant") return;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      const name = b.name || "";
      const inp = b.input || {};

      if (["Edit", "Write", "MultiEdit"].includes(name)) {
        const kind = classify(inp.file_path || "");
        if (observable.has(kind)) {
          lastEditIdx = idx;
          lastEditKind = kind;
        }
      }

      if (name === "Bash") {
        const cmd = String(inp.command || "");
        lastDelegableBashIdx = idx;

        // Реальная верификация: запустил реальную проверку после правки.
        if (
          /\bcurl\b[^|;&]*(localhost|127\.0\.0\.1|0\.0\.0\.0|https?:\/\/)/i.test(
            cmd,
          ) ||
          /\bwget\b[^|;&]*(localhost|127\.0\.0\.1|https?:\/\/)/i.test(cmd) ||
          /\b(playwright|puppeteer)\b[^\n]*\b(test|run|open|screenshot|goto|click)/i.test(
            cmd,
          ) ||
          /chrom(e|ium)[^\n]*--headless/i.test(cmd) ||
          /\bnpx\s+playwright\s+(test|open|screenshot)/i.test(cmd) ||
          // Backend / CLI verification
          /\b(pytest|python\s+-m\s+pytest)\b/i.test(cmd) ||
          /\b(go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|bundle\s+exec\s+rspec|rspec|phpunit|dotnet\s+test)\b/i.test(
            cmd,
          ) ||
          /\bnpm\s+(test|run\s+test|run\s+e2e)\b/i.test(cmd) ||
          /\bpnpm\s+(test|run\s+test|run\s+e2e)\b/i.test(cmd) ||
          /\byarn\s+(test|run\s+test|run\s+e2e)\b/i.test(cmd) ||
          /\bvitest\b/i.test(cmd) ||
          /\bjest\b/i.test(cmd) ||
          // Docker compose
          /\bdocker[- ]compose\s+(up|run|exec)/i.test(cmd) ||
          /\bdocker\s+(run|exec|build)/i.test(cmd) ||
          // MCP plugin verification
          /\bclaude\s+-p\b/i.test(cmd) ||
          /\bclaude\s+--print\b/i.test(cmd) ||
          // Python/Node CLI direct invoke
          /\b(python3?|node|deno|bun|ruby|go\s+run|cargo\s+run|dotnet\s+run)\s+[^\n]*\.(py|js|mjs|ts|rb|go|rs)\b/i.test(
            cmd,
          ) ||
          // Shell script invoke: bash/sh <file>, ./scripts/x, /abs/path.sh, make/just targets
          /\b(bash|sh|zsh|ksh|fish)\s+[^|;&\n]*\.(sh|bash)\b/i.test(cmd) ||
          /(^|[\s;&|])\.?\/?(scripts?|bin)\/[\w.-]+/i.test(cmd) ||
          /(^|[\s;&|])(\.\/|\/|~\/)[\w\/.-]+\.(sh|bash|py|js|ts|rb)(\s|$|\s+-)/i.test(
            cmd,
          ) ||
          /\b(make|just)\s+(test|check|e2e|ci|smoke|verify)\b/i.test(cmd)
        ) {
          lastVerifyIdx = idx;
        }
        // Любой намёк, что Claude пытался разведать окружение
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
          lastAttemptIdx = idx;
        } else {
          lastAttemptIdx = idx;
        }
      }
    }
  });

  // Детект предыдущего своего блокирующего сообщения — anti-loop.
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

  // Триггер C (делегация) работает независимо от правок — его логика отдельная.
  // Триггеры A/B требуют наличия observable-правки.
  // Триггеры D/E/F/G/H — мехчеки на дисциплину тестов/доков/лайнта; срабатывают при hasSuccess.

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
    // Уже блокировали после этой правки — даём слово пользователю.
    if (lastBlockIdx > lastEditIdx) return;

    const verifiedAfterEdit = lastVerifyIdx > lastEditIdx;
    const attemptedAfterEdit = lastAttemptIdx > lastEditIdx;

    if (hasDisclaimer && !attemptedAfterEdit) {
      trigger = "B";
    } else if (hasSuccess) {
      // Новые мехчеки. Порядок: G (lint) → D (src↔test) → E (e2e) → H (docs) → F (edge-cases) → A (no verify).
      const repoRoot = checks.resolveRepoRoot(
        process.env.CLAUDE_PROJECT_DIR,
        allEdits,
      );
      const sessionFiles = new Set(allEdits.map((e) => e.file_path));
      const observableSrcEdits = allEdits
        .filter((e) => observable.has(classify(e.file_path)))
        .filter((e) => !checks.isTestFile(e.file_path))
        .filter((e) => !checks.isDocFile(e.file_path))
        .filter((e) => checks.isCodeFile(e.file_path));
      const observableSrcFiles = [
        ...new Set(observableSrcEdits.map((e) => e.file_path)),
      ];

      // G: auto-lint (опт-аут MAIN_SKILL_VERIFY_LINT=0).
      if (!trigger && process.env.MAIN_SKILL_VERIFY_LINT !== "0") {
        const lintRes = checks.runLint(repoRoot);
        if (lintRes && lintRes.ran && lintRes.ok === false) {
          trigger = "G";
          triggerData = lintRes;
        }
      }

      // D: src без парного test-файла.
      // Фильтруем файлы, для которых unit-тест объективно не имеет смысла
      // (миграции, типы, generated, configs, wiring), плюс поддерживаем
      // user-override через MAIN_SKILL_VERIFY_IGNORE_GLOBS (POSIX globs, через `:`).
      if (!trigger) {
        const userIgnoreGlobs = String(
          process.env.MAIN_SKILL_VERIFY_IGNORE_GLOBS || "",
        )
          .split(":")
          .map((s) => s.trim())
          .filter(Boolean);
        const missingTests = [];
        for (const fp of observableSrcFiles) {
          const rel = path.isAbsolute(fp) ? path.relative(repoRoot, fp) : fp;
          if (checks.shouldSkipForTestPairing(fp, repoRoot)) continue;
          if (checks.matchAnyGlob(rel, userIgnoreGlobs)) continue;
          const paired = checks.findPairedTestFile(fp, repoRoot, sessionFiles);
          if (!paired) missingTests.push(fp);
        }
        if (missingTests.length > 0) {
          trigger = "D";
          triggerData = { missingTests };
        }
      }

      // E: controller/route без e2e-парного.
      if (!trigger) {
        const missingE2e = [];
        for (const fp of observableSrcFiles) {
          if (!checks.isControllerOrRoute(fp)) continue;
          const paired = checks.findE2eFile(fp, repoRoot, sessionFiles);
          if (!paired) missingE2e.push(fp);
        }
        if (missingE2e.length > 0) {
          trigger = "E";
          triggerData = { missingE2e };
        }
      }

      // H: public surface tронут И docs не тронуты в сессии.
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

      // F: декларация edge-cases.
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

      // J / K: self-review + триаж замечаний ревьюеров.
      // Опт-аут: MAIN_SKILL_VERIFY_REVIEW=0 (полностью), =code (только code-review),
      // =security (только security-review), =both (default).
      const VALID_REVIEW_MODES = new Set(["both", "code", "security", "0"]);
      const rawReviewMode = (
        process.env.MAIN_SKILL_VERIFY_REVIEW || "both"
      ).toLowerCase();
      const reviewMode = VALID_REVIEW_MODES.has(rawReviewMode)
        ? rawReviewMode
        : "both";
      const reviewWantCode = reviewMode === "both" || reviewMode === "code";
      const reviewWantSec = reviewMode === "both" || reviewMode === "security";
      const reviewEnabled =
        reviewMode !== "0" && (reviewWantCode || reviewWantSec);

      if (!trigger && reviewEnabled && observableSrcEdits.length > 0) {
        const securityPath =
          checks.hasSecuritySensitivePath(observableSrcEdits);
        // Считаем только observable-src правки (не docs / configs / tests). Иначе правка
        // README на 50 строк ложно активирует J. Cap на 20 — раннее завершение.
        const observableSrcSet = new Set(observableSrcFiles);
        const isObservableSrc = (fp) => observableSrcSet.has(fp);
        const nonTrivialLines = checks.countNonTrivialDiffLines(
          lines,
          isObservableSrc,
          20,
        );
        const isTrivial = !securityPath && nonTrivialLines < 20;
        const selfReview = checks.parseSelfReview(lastText);

        // Тривиальный diff — self-review необязателен; но если объявлен `skipped:trivial`
        // в нетривиальной правке — это анти-фейк, блокируем.
        if (!isTrivial) {
          if (!selfReview) {
            trigger = "J";
            triggerData = {
              kind: "missing",
              securityPath,
              nonTrivialLines,
              reviewMode,
            };
          } else if (selfReview.skippedTrivial) {
            trigger = "J";
            triggerData = {
              kind: "fake-skip",
              securityPath,
              nonTrivialLines,
              reviewMode,
            };
          } else {
            // Проверяем, что нужные секции присутствуют согласно reviewMode.
            const missingSections = [];
            if (reviewWantCode && !selfReview.code)
              missingSections.push("code");
            if (reviewWantSec && !selfReview.security)
              missingSections.push("security");
            if (missingSections.length > 0) {
              trigger = "J";
              triggerData = {
                kind: "missing-sections",
                missingSections,
                reviewMode,
              };
            } else {
              // Анти-фейк: если секция объявлена со статусом != skipped, в transcript должен быть
              // соответствующий Task-вызов. `none-found` тоже требует реального запуска.
              const calls = checks.findReviewAgentCalls(lines);
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
              if (fakeSections.length > 0) {
                trigger = "J";
                triggerData = { kind: "fake-decl", fakeSections, reviewMode };
              } else {
                // K: триаж требуется, если хоть в одной активной секции есть applied/rejected/deferred.
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
                      // Все записи в триаже должны принадлежать активной по reviewMode секции.
                      const wrongSource = triage.entries.filter(
                        (e) =>
                          e.valid &&
                          ((e.source === "code" && !reviewWantCode) ||
                            (e.source === "security" && !reviewWantSec)),
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

      // A: нет реальной verify-команды после правки (последняя сетка).
      if (!trigger && !verifiedAfterEdit) {
        trigger = "A";
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

  const reasonD = [
    "[main-skill:verify-changes] Stop заблокирован (триггер D: src-файл без парного test-файла).",
    "",
    "Ты правил observable src-файлы, но для них нет парного test-файла ни в репо,",
    "ни среди правок этой сессии. Запрещено правилом workflow-rules §3 («happy path NOT enough»).",
    "",
    "Файлы без тестов:",
    ...(triggerData?.missingTests || []).map((f) => `  • ${f}`),
    "",
    "Конвенции, по которым ищу парный тест (mirror-discovery в monorepo):",
    "  • <name>.test.<ext> / <name>.spec.<ext> рядом с src",
    "  • __tests__/<name>.<ext> / __tests__/<name>.test.<ext> (включая src/__tests__/)",
    "  • tests/unit/<name>.<ext> / tests/<name>.test.<ext> относительно package-root",
    "    (package-root = директория с package.json/pyproject.toml/Cargo.toml/go.mod/...)",
    "  • mirror src/<rel>/X ↔ tests/<rel>/X.spec, __tests__/<rel>/X.test",
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
    "  framework-configs (vite/next/nuxt/playwright/...), start/, bootstrap/,",
    "  infra/ infrastructure/, операционные shell-скрипты",
    "  (install/deploy/bootstrap/setup/provision/teardown/sync-config.sh),",
    "  файлы с @generated заголовком, type-only TS-файлы (только interface/type/enum).",
    "Для config/ deploy/ и project-specific каталогов — MAIN_SKILL_VERIFY_IGNORE_GLOBS.",
    "",
    "Сделай: напиши тесты → прогони → отчитайся.",
    "Опт-аут целиком: MAIN_SKILL_VERIFY_CHANGES=0",
    'Per-project ignore: MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/legacy/**:**/scripts/**" (через `:`).',
  ].join("\n");

  const reasonE = [
    "[main-skill:verify-changes] Stop заблокирован (триггер E: controller/route без e2e/functional-теста).",
    "",
    "Ты правил controller/route/api-handler — это endpoint, требующий integration/e2e-теста.",
    "Unit-тест на сервис не считается; нужен тест, бьющий по реальному endpoint",
    "(например @japa/api-client / supertest / playwright / cypress).",
    "",
    "Без e2e-теста:",
    ...(triggerData?.missingE2e || []).map((f) => `  • ${f}`),
    "",
    "Ищу в: tests/functional/, tests/e2e/, tests/integration/, e2e/, cypress/e2e/, playwright/.",
    "",
    "Опт-аут (если в проекте e2e реально не предусмотрен): MAIN_SKILL_VERIFY_CHANGES=0",
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
        "и наличие it/test/describe/def с этим именем.",
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
      ...failed.map((v) => `  • ${v.entry?.raw || "<unparsed>"} — ${v.reason}`),
      "",
      "Каждая запись должна быть name:test_file:test_name; test_file существует;",
      "в нём — it/test/describe/def, чьё имя содержит test_name (case-insensitive).",
      "",
      "Опт-аут (редко): MAIN_SKILL_VERIFY_CHANGES=0",
    ].join("\n");
  })();

  const reasonG = [
    "[main-skill:verify-changes] Stop заблокирован (триггер G: лайнтер красный).",
    "",
    `Команда: ${triggerData?.cmd || "<lint>"}`,
    "Exit-код ≠ 0. Workflow-rules §3 требует «Linters + formatters green» перед done.",
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
    ...(triggerData?.publicEdits || []).map((f) => `  • ${f}`),
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
      "  </self-review>",
      "",
      "Per-section статусы: applied | rejected | deferred | none-found.",
      "Целиком пропустить можно ТОЛЬКО если diff < 20 нетривиальных observable-строк И",
      "не затронут security-sensitive путь:",
      "  <self-review>skipped:trivial</self-review>",
      "Per-section `code:skipped` / `security:skipped` НЕ принимается — это был bypass.",
    ];
    const howTo = [
      "Что должен сделать:",
      "  1. Параллельно запусти ДВА агента в одном сообщении (один Tool message, два Task call):",
      '       • code-review — Task(subagent_type="superpowers:code-reviewer") или Task с',
      "         требованием в промпте провести code review;",
      '       • security-review — Task(subagent_type="general-purpose") с промптом',
      "         «security review по OWASP Top-10 + injection / auth-bypass / SSRF / weak-crypto /",
      "         secret leaks» на конкретные изменённые файлы.",
      "  2. По каждому замечанию — пункт в <review-triage> блоке (триггер K).",
      "  3. Применить applied / обосновать rejected/deferred с техническим аргументом.",
      "  4. Один проход. Повторный запуск review-агентов перед Stop запрещён.",
      "",
      "Опт-аут: MAIN_SKILL_VERIFY_REVIEW=0 (целиком) | =code (только code) | =security (только security).",
    ];
    if (triggerData?.kind === "fake-skip") {
      return [
        baseHead.replace(
          "нет валидного <self-review> блока",
          "фейковый skipped:trivial",
        ),
        "",
        `Ты пометил <self-review>skipped:trivial</self-review>, но diff НЕ тривиальный:`,
        `  • non-trivial lines: ${triggerData.nonTrivialLines} (порог skip: < 20)`,
        `  • security-sensitive путь затронут: ${triggerData.securityPath ? "да" : "нет"}`,
        "",
        "Self-review обязателен. " +
          (triggerData.securityPath
            ? "Особенно тут — затронут auth/api/sql/crypto/payment/admin/session/token/..."
            : "Diff ≥ 20 нетривиальных observable-строк."),
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
        "transcript этой сессии НЕТ соответствующих Task-вызовов. Это враньё под видом дисциплины.",
        "",
        "Что считается реальным запуском:",
        '  • code  — Task с subagent_type содержащим "code-review*" или промптом упоминающим code review.',
        '  • security — Task с subagent_type содержащим "security" ИЛИ промптом упоминающим OWASP /',
        "    injection / auth bypass / secret leak / XSS / CSRF / SSRF / RCE / TOCTOU / weak crypto.",
        "",
        ...howTo,
      ].join("\n");
    }
    // missing
    return [
      baseHead,
      "",
      "Ты правил observable код и заявил «готово», но не выполнил self-review своими силами.",
      "Это требование workflow-rules §4: после execution, до Stop, обязан прогнать code+security",
      "ревью через суб-агентов и зафиксировать результат блоком <self-review>.",
      "",
      `Диагностика (почему J активирован):`,
      `  • non-trivial observable строк: ${triggerData?.nonTrivialLines ?? "?"} (порог skip: < 20)`,
      `  • security-sensitive путь затронут: ${triggerData?.securityPath ? "да" : "нет"}`,
      `  • режим: MAIN_SKILL_VERIFY_REVIEW=${triggerData?.reviewMode ?? "both"}`,
      "",
      "Тривиальные правки (< 20 нетривиальных observable-строк И не auth/api/sql/crypto/...)",
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
        ...(triggerData.failed || []).map(
          (v) => `  • ${v.entry?.raw || "<unparsed>"} — ${v.reason}`,
        ),
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
        "Записи относятся к секции, которая отключена флагом — это означает что ты их выдумал",
        "или забыл переключить режим:",
        ...(triggerData.wrongSource || []).map((e) => `  • ${e.raw}`),
      ].join("\n");
    }
    // missing
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
  };
  const reason = reasonByTrigger[trigger] || reasonA;
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

function findLastAssistantText(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = lines[i];
    if (e.type !== "assistant") continue;
    const content = e.message?.content || [];
    const text = content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}
