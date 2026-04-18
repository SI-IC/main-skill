#!/usr/bin/env node
// Stop hook: блокирует завершение, если ассистент заявил «готово/done/работает»
// после правки observable-файла (frontend, backend, CLI, MCP plugin, etc.), но
// не выполнил ни одной реальной верификации ПОСЛЕ последней правки.
//
// Триггеры:
//   A — success-слово («готово», «fixed», «pushed», ...) БЕЗ верификации.
//   B — дисклеймер («не проверил», «проверь вручную») БЕЗ попыток разведки.
//   C — делегирование shell-команды пользователю при наличии своего Bash.
//
// Опт-аут: export MAIN_SKILL_VERIFY_CHANGES=0
// Старое имя переменной тоже уважается: MAIN_SKILL_VERIFY_FRONTEND=0.

const fs = require('fs');

let payload = '';
process.stdin.on('data', (c) => (payload += c));
process.stdin.on('end', () => {
  try {
    main(JSON.parse(payload));
  } catch {
    process.exit(0);
  }
});

function main(p) {
  if (
    process.env.MAIN_SKILL_VERIFY_CHANGES === '0' ||
    process.env.MAIN_SKILL_VERIFY_FRONTEND === '0'
  ) {
    return;
  }

  const tp = p.transcript_path;
  if (!tp || !fs.existsSync(tp)) return;

  const lines = fs
    .readFileSync(tp, 'utf8')
    .split('\n')
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
  const hasDelegation = delegatePat.test(lastText) && /```[a-z]*\s*\n[\s\S]*?\n```|`[^`\n]{3,}`/m.test(lastText);

  if (!hasSuccess && !hasDisclaimer && !hasDelegation) return;

  // Классификация правок по типам. Не вся правка триггерит хук — только observable.
  const classify = (fp = '') => {
    const f = String(fp);
    // Явно не observable: docs, config, lockfiles, assets.
    if (/(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT)(\.\w+)?$/i.test(f)) return 'docs';
    if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock)$/i.test(f))
      return 'lockfile';
    if (/\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|mp4|mp3|wav|pdf)$/i.test(f)) return 'asset';

    // Plugin behaviour-files — приоритет над docs, потому что .md в skills/ это runtime.
    if (/(^|\/)\.claude-plugin\//.test(f)) return 'plugin';
    if (/(^|\/)\.claude\/(settings|hooks|commands)/.test(f)) return 'plugin';
    if (/(^|\/)(hooks|commands|skills|agents)\/.*\.(md|mdx|sh|js|ts|mjs|cjs|py|json|ya?ml)$/i.test(f)) return 'plugin';

    // Docs — после plugin.
    if (/\.(md|mdx|txt|rst|adoc)$/i.test(f)) return 'docs';

    // Observable
    if (/\.(tsx|jsx|vue|svelte|astro|html|htm)$/i.test(f)) return 'frontend';
    if (/\.(css|scss|sass|less|styl|stylus)$/i.test(f)) return 'frontend';
    if (/\.(py|go|rs|rb|java|kt|kts|scala|php|cs|fs|fsx|ex|exs|clj|cljs|erl|hs|ml|mli|swift|dart|lua|sh|bash|zsh|fish|ps1|sql)$/i.test(f))
      return 'backend';
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(f)) return 'backend'; // JS/TS по умолчанию backend (frontend уже поймали выше)
    if (/(^|\/)(bin|scripts|cli)\//i.test(f)) return 'cli';
    if (/(^|\/)(Dockerfile|docker-compose[\w.-]*\.ya?ml|Makefile|justfile|Procfile)$/i.test(f)) return 'infra';
    if (/\.(ya?ml|toml|json)$/i.test(f)) return 'config';
    return 'other';
  };

  const observable = new Set(['frontend', 'backend', 'cli', 'plugin', 'infra']);

  let lastEditIdx = -1;
  let lastEditKind = null;
  let lastVerifyIdx = -1;
  let lastAttemptIdx = -1;
  let lastBlockIdx = -1;
  let lastDelegableBashIdx = -1; // последний Bash запуск самого Claude — доказывает наличие Bash-доступа

  lines.forEach((e, idx) => {
    if (e.type !== 'assistant') return;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const name = b.name || '';
      const inp = b.input || {};

      if (['Edit', 'Write', 'MultiEdit'].includes(name)) {
        const kind = classify(inp.file_path || '');
        if (observable.has(kind)) {
          lastEditIdx = idx;
          lastEditKind = kind;
        }
      }

      if (name === 'Bash') {
        const cmd = String(inp.command || '');
        lastDelegableBashIdx = idx;

        // Реальная верификация: запустил реальную проверку после правки.
        if (
          /\bcurl\b[^|;&]*(localhost|127\.0\.0\.1|0\.0\.0\.0|https?:\/\/)/i.test(cmd) ||
          /\bwget\b[^|;&]*(localhost|127\.0\.0\.1|https?:\/\/)/i.test(cmd) ||
          /\b(playwright|puppeteer)\b[^\n]*\b(test|run|open|screenshot|goto|click)/i.test(cmd) ||
          /chrom(e|ium)[^\n]*--headless/i.test(cmd) ||
          /\bnpx\s+playwright\s+(test|open|screenshot)/i.test(cmd) ||
          // Backend / CLI verification
          /\b(pytest|python\s+-m\s+pytest)\b/i.test(cmd) ||
          /\b(go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|bundle\s+exec\s+rspec|rspec|phpunit|dotnet\s+test)\b/i.test(cmd) ||
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
          /\b(python3?|node|deno|bun|ruby|go\s+run|cargo\s+run|dotnet\s+run)\s+[^\n]*\.(py|js|mjs|ts|rb|go|rs)\b/i.test(cmd) ||
          // Shell script invoke: bash/sh <file>, ./scripts/x, /abs/path.sh, make/just targets
          /\b(bash|sh|zsh|ksh|fish)\s+[^|;&\n]*\.(sh|bash)\b/i.test(cmd) ||
          /(^|[\s;&|])\.?\/?(scripts?|bin)\/[\w.-]+/i.test(cmd) ||
          /(^|[\s;&|])(\.\/|\/|~\/)[\w\/.-]+\.(sh|bash|py|js|ts|rb)(\s|$|\s+-)/i.test(cmd) ||
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
        name.startsWith('mcp__claude-in-chrome__') ||
        name.startsWith('mcp__plugin_chrome-devtools-mcp_') ||
        name.startsWith('mcp__plugin_playwright_')
      ) {
        const passive = new Set([
          'mcp__claude-in-chrome__tabs_context_mcp',
          'mcp__claude-in-chrome__shortcuts_list',
          'mcp__claude-in-chrome__switch_browser',
          'mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_pages',
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
    if (e.type !== 'user') return;
    const content = e.message?.content;
    if (typeof content === 'string') {
      if (blockRe.test(content)) lastBlockIdx = idx;
      return;
    }
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_result' && typeof b.content === 'string' && blockRe.test(b.content)) {
        lastBlockIdx = idx;
      }
      if (b.type === 'text' && typeof b.text === 'string' && blockRe.test(b.text)) {
        lastBlockIdx = idx;
      }
    }
  });

  // Триггер C (делегация) работает независимо от правок — его логика отдельная ниже.
  // Триггеры A и B требуют наличия observable-правки.

  let trigger = null;
  let reasonLines = null;

  if (hasDelegation && lastDelegableBashIdx >= 0) {
    // У Клода есть Bash-доступ в этой сессии — он использовал его сам → может запустить и эту команду.
    // Исключение: interactive auth / GUI-команды распознаём грубо по содержимому.
    const interactiveHint =
      /(gcloud|aws|az|op|vault)\s+(login|auth)|ssh\s+-\w*\s*\w|xdg-open|open\s+http|osascript/i;
    if (!interactiveHint.test(lastText)) {
      trigger = 'C';
    }
  }

  if (!trigger && lastEditIdx >= 0) {
    // Уже блокировали после этой правки — даём слово пользователю.
    if (lastBlockIdx > lastEditIdx) return;

    const verifiedAfterEdit = lastVerifyIdx > lastEditIdx;
    const attemptedAfterEdit = lastAttemptIdx > lastEditIdx;

    if (verifiedAfterEdit) return;

    if (hasDisclaimer) {
      if (!attemptedAfterEdit) trigger = 'B';
      else return;
    } else if (hasSuccess) {
      trigger = 'A';
    }
  }

  if (!trigger) return;

  const hintsByKind = {
    frontend: [
      '  • headless browser (playwright / chrome-devtools-mcp / claude-in-chrome):',
      '    открыть route → HTTP 2xx документа+bundle, console без ошибок, DOM-маркер.',
      '  • curl http://localhost:PORT/route → статус + grep маркера в HTML.',
      '  • headless нет? → `npx playwright install chromium` (работает в контейнере без GUI).',
    ],
    backend: [
      '  • curl против реального endpoint → статус + body.',
      '  • pytest / go test / cargo test / npm test для изменённого модуля.',
      '  • прямой запуск: `python script.py` / `go run .` / `node cli.js` → stdout.',
    ],
    cli: [
      '  • прогон самой команды с осмысленными аргументами → exit code + stdout.',
      '  • regression-кейс через фикстуру, если CLI имеет тесты.',
    ],
    plugin: [
      '  • для slash-команд / hooks Claude Code — `claude -p "/namespace:command"` с бампом версии',
      '    и `claude plugin marketplace update` перед прогоном.',
      '  • для MCP — запусти сервер в фоне, дёрни инструмент через `claude -p` или curl.',
      '  • для skills — проверить автозагрузку в новой сессии (`claude` clean-start).',
    ],
    infra: [
      '  • `docker-compose up --abort-on-container-exit` → все сервисы healthy.',
      '  • `docker build .` → successful, затем `docker run` → ожидаемый output.',
      '  • Makefile/justfile target — прогнать и проверить exit code.',
    ],
  };
  const hints = (hintsByKind[lastEditKind] || [
    '  • запусти изменённый код как его запустит пользователь → статус / output / ошибка.',
  ]).join('\n');

  const reasonA = [
    '[main-skill:verify-changes] Stop заблокирован (триггер A: success без верификации).',
    '',
    `Ты правил observable-файл (${lastEditKind}) и заявил «готово» без реальной проверки`,
    'ПОСЛЕ правки. Запрещено правилом workflow-rules §3.',
    '',
    'Сделай минимум одно прямо сейчас:',
    hints,
    '',
    'Если верификация реально невозможна — покажи попытки (lsof/which/npx install/curl',
    'с ошибкой) и используй дисклеймер. Без попыток дисклеймер тоже блочится (триггер B).',
  ].join('\n');

  const reasonB = [
    '[main-skill:verify-changes] Stop заблокирован (триггер B: дисклеймер без попытки).',
    '',
    `Ты правил ${lastEditKind} и сослался на «не проверил / нет доступа», но в сессии НЕ`,
    'выполнил ни одной попытки разведать окружение. Это лень под видом честности.',
    '',
    'Минимальная разведка:',
    '  • lsof -i :PORT / ss -tlnp / netstat — есть ли процесс.',
    '  • which / command -v — что установлено.',
    '  • npx playwright install chromium / pip install / npm i — поставить чего нет.',
    '  • curl -fsS http://... — даже connection refused это инфа.',
    '  • docker-compose up -d → попробовать поднять окружение.',
    '',
    'После реальной попытки:',
    '  • получилось — отчитайся с пруфами (статус, snippet, output).',
    '  • нет — дисклеймер легитимен: «Фикс применён. End-to-end НЕ проверил:',
    '    <конкретная техническая причина с цитатой ошибки>. Проверь вручную: <шаги>».',
    '',
    'Опт-аут (редко): export MAIN_SKILL_VERIFY_CHANGES=0',
  ].join('\n');

  const reasonC = [
    '[main-skill:verify-changes] Stop заблокирован (триггер C: делегирование shell).',
    '',
    'Ты попросил пользователя выполнить shell-команду у себя, но в ЭТОЙ ЖЕ сессии',
    'ты сам использовал Bash — значит доступ есть. Не перекладывай ручную работу.',
    '',
    'Сделай одно из:',
    '  • Запусти команду сам через Bash, отчитайся результатом.',
    '  • Если команда ТРЕБУЕТ интерактива (gcloud auth login, ssh-agent, GUI) —',
    '    скажи это явно и объясни, какой конкретно шаг требует участия пользователя.',
    '',
    'Опт-аут (редко): export MAIN_SKILL_VERIFY_CHANGES=0',
  ].join('\n');

  const reason = trigger === 'A' ? reasonA : trigger === 'B' ? reasonB : reasonC;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

function findLastAssistantText(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = lines[i];
    if (e.type !== 'assistant') continue;
    const content = e.message?.content || [];
    const text = content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text || '')
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}
