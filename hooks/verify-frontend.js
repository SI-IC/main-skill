#!/usr/bin/env node
// Stop hook: блокирует завершение, если ассистент в последнем сообщении
// заявил «готово/done/работает» после правки фронта (.tsx/.jsx/.vue/.svelte/
// .astro/.html), но не выполнил ни одной headless-верификации (browser MCP,
// curl localhost, playwright) ПОСЛЕ последней правки.
//
// Опт-аут: export MAIN_SKILL_VERIFY_FRONTEND=0
//
// Эскейп: если ассистент честно написал «не проверил / not verified /
// проверь вручную» — хук пропускает.

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
  if (process.env.MAIN_SKILL_VERIFY_FRONTEND === '0') return;

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

  // Anti-loop: если хук уже сработал в этой сессии и ассистент после этого
  // не правил фронт заново — больше не блокируем (даём пользователю слово).
  // Реализация ниже через сравнение индексов: lastEdit ДОЛЖЕН быть позже
  // последнего hook-block-message.

  const lastText = findLastAssistantText(lines);
  if (!lastText) return;

  const successPat =
    /(^|[^\p{L}\p{N}_])(готово|готов|готова|done|fixed|fix(ed)?|works?|работает|пофиксил|починил|ready|complete[d]?|применил|применён|примен[её]н)([^\p{L}\p{N}_]|$)/iu;
  const disclaimerPat =
    /не\s+(про)?верил|не\s+тестировал|not\s+verified|проверь\s+вручную|please\s+(verify|check)\s+manually|end-to-end\s+не\s+проверил/i;

  const hasSuccess = successPat.test(lastText);
  const hasDisclaimer = disclaimerPat.test(lastText);

  // Молчание = не наша забота
  if (!hasSuccess && !hasDisclaimer) return;

  const frontendExt = /\.(tsx|jsx|vue|svelte|astro|html)$/i;
  let lastEditIdx = -1;
  let lastVerifyIdx = -1; // настоящая верификация: curl/playwright/MCP с страницей
  let lastAttemptIdx = -1; // любой намёк на попытку: lsof, which, npx install, etc.
  let lastBlockIdx = -1;

  lines.forEach((e, idx) => {
    if (e.type !== 'assistant') return;
    const content = e.message?.content || [];
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const name = b.name || '';
      const inp = b.input || {};

      if (['Edit', 'Write', 'MultiEdit'].includes(name)) {
        if (frontendExt.test(inp.file_path || '')) lastEditIdx = idx;
      }

      if (name === 'Bash') {
        const cmd = String(inp.command || '');
        if (
          /\bcurl\b[^|;&]*(localhost|127\.0\.0\.1|0\.0\.0\.0|https?:\/\/)/i.test(cmd) ||
          /\bwget\b[^|;&]*(localhost|127\.0\.0\.1|https?:\/\/)/i.test(cmd) ||
          /\b(playwright|puppeteer)\b[^\n]*\b(test|run|open|screenshot|goto|click)/i.test(cmd) ||
          /chrom(e|ium)[^\n]*--headless/i.test(cmd) ||
          /\bnpx\s+playwright\s+(test|open|screenshot)/i.test(cmd)
        ) {
          lastVerifyIdx = idx;
        }
        // Любой намёк, что Claude хотя бы пытался разведать окружение
        if (
          /\b(lsof|ss|netstat|pgrep|ps\s+-|nc\s+-z)\b/i.test(cmd) ||
          /\bwhich\s+(playwright|chromium|chrome|curl|node)\b/i.test(cmd) ||
          /\bcommand\s+-v\s+(playwright|chromium|chrome|curl)\b/i.test(cmd) ||
          /\bnpx\s+playwright\s+install/i.test(cmd) ||
          /\bnpm\s+(install|i)\s+[^\n]*playwright/i.test(cmd) ||
          /\bnpm\s+run\s+(dev|start|build|preview)/i.test(cmd) ||
          /\b(next|vite|remix)\s+(dev|start|build)/i.test(cmd) ||
          /\bcurl\b/i.test(cmd) ||
          /\bwget\b/i.test(cmd)
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

  // Detect own previous block message to avoid infinite loops
  lines.forEach((e, idx) => {
    if (e.type !== 'user') return;
    const content = e.message?.content || [];
    for (const b of content) {
      if (b && b.type === 'tool_result' && typeof b.content === 'string') {
        if (b.content.includes('main-skill:verify-frontend')) lastBlockIdx = idx;
      }
    }
    // Также проверяем системные напоминания в user-сообщениях
    if (typeof e.message?.content === 'string' && e.message.content.includes('main-skill:verify-frontend')) {
      lastBlockIdx = idx;
    }
  });

  if (lastEditIdx < 0) return; // фронт не правил — нечего блокировать
  if (lastBlockIdx > lastEditIdx) return; // уже блокировали, новых правок не было — даём пользователю слово

  const verifiedAfterEdit = lastVerifyIdx > lastEditIdx;
  const attemptedAfterEdit = lastAttemptIdx > lastEditIdx;

  // Реальная верификация после правки → пропускаем всё.
  if (verifiedAfterEdit) return;

  // Дисклеймер имеет приоритет над success-словом: если автор честно сказал
  // «не проверил», оцениваем по дисклеймерному правилу — нужна разведка.
  // Без дисклеймера success-слово блочится через триггер A.
  let trigger = null;
  if (hasDisclaimer) {
    if (!attemptedAfterEdit) trigger = 'B';
    else return;
  } else if (hasSuccess) {
    trigger = 'A';
  } else {
    return;
  }

  const reasonA = [
    '[main-skill:verify-frontend] Stop заблокирован (триггер A: success без верификации).',
    '',
    'Ты правил фронт (.tsx/.jsx/.vue/.svelte/.astro/.html) и заявил «готово»',
    'без headless-проверки ПОСЛЕ правки. Запрещено правилом workflow-rules §3.',
    '',
    'Сделай минимум одно прямо сейчас:',
    '  • headless browser MCP (playwright / chrome-devtools-mcp / claude-in-chrome):',
    '    открыть affected route → HTTP 2xx документа И JS bundle, console без ошибок,',
    '    DOM содержит ожидаемый маркер. Скриншот если визуально.',
    '  • curl http://localhost:PORT/route → status + grep ожидаемого маркера в HTML.',
    '  • если headless не установлен — `npx playwright install chromium`.',
    '',
    'Контейнер / нет GUI — НЕ оправдание. Headless работает везде.',
    '',
    'Если хочешь использовать дисклеймер «не проверил» — покажи реальные попытки',
    '(lsof/ss/netstat для порта, which/command -v для playwright, npx install,',
    'curl с ошибкой). Без попыток дисклеймер тоже блочится (триггер B).',
  ].join('\n');

  const reasonB = [
    '[main-skill:verify-frontend] Stop заблокирован (триггер B: дисклеймер без попытки).',
    '',
    'Ты правил фронт и сослался на «не проверил / нет доступа к браузеру»,',
    'но в этой сессии НЕ выполнил ни одной попытки разведать окружение.',
    'Это лень, замаскированная под честность.',
    '',
    'Минимальная разведка перед эскейпом:',
    '  • lsof -i :PORT  /  ss -tlnp  /  netstat -tlnp  — есть ли dev-server вообще',
    '  • which playwright / chromium / chrome / curl — что доступно',
    '  • npx playwright install chromium — поставить, если нет',
    '  • curl -fsS http://localhost:PORT/route  — даже connection refused это инфа',
    '  • попытаться поднять `npm run dev` / `next dev` / `vite` если процесса нет',
    '',
    'После реальной попытки одно из двух:',
    '  • получилось — отчитайся с пруфами (статус, snippet HTML, console)',
    '  • не получилось по конкретной причине — теперь дисклеймер легитимен:',
    '    "Фикс применён. End-to-end НЕ проверил: <конкретная техническая причина',
    '     с цитатой ошибки>. Проверь вручную: <точные шаги>"',
    '',
    'Опт-аут (используй редко): export MAIN_SKILL_VERIFY_FRONTEND=0',
  ].join('\n');

  const reason = trigger === 'A' ? reasonA : reasonB;
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
