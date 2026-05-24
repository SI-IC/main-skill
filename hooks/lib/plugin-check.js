#!/usr/bin/env node
"use strict";

// Детект рекомендованных плагинов для SessionStart-баннера.
// main-skill ссылается на скиллы этих плагинов в workflow-rules SKILL.md (триаж/ревью);
// без них workflow деградирует мягко (см. note в SKILL.md), но баннер подсказывает юзеру
// поставить их для полного процесса. Чистая логика — в pure-функциях, побочка только в run().

const fs = require("fs");
const os = require("os");
const path = require("path");

// Источник истины — что упомянуто в skills/workflow-rules/SKILL.md (триаж + UI).
const RECOMMENDED = [
  {
    name: "superpowers",
    why: "триаж: systematic-debugging / brainstorming / TDD / receiving-code-review",
  },
  {
    name: "ui-ux-pro-max",
    why: "UI/UX-задачи (верификация через playwright/screenshot)",
  },
];

// Множество base-имён (часть до '@') плагинов, у которых enabledPlugins[key] === true.
function enabledPluginNames(settings) {
  const out = new Set();
  const ep = settings && settings.enabledPlugins;
  if (!ep || typeof ep !== "object") return out;
  for (const [key, val] of Object.entries(ep)) {
    if (val === true) out.add(String(key).split("@")[0]);
  }
  return out;
}

// Рекомендованные, которых нет среди enabled (отсутствуют или value=false).
// Если в settings нет валидного enabledPlugins — возвращаем [] (не можем достоверно
// судить → не шумим ложным баннером).
function missingRecommended(settings, recommended = RECOMMENDED) {
  if (
    !settings ||
    !settings.enabledPlugins ||
    typeof settings.enabledPlugins !== "object"
  ) {
    return [];
  }
  const enabled = enabledPluginNames(settings);
  return recommended.filter((p) => !enabled.has(p.name));
}

// ВАЖНО: в баннер попадают ТОЛЬКО hardcoded-имена из RECOMMENDED, никогда не
// значения из settings.json — иначе нужна была бы ANSI/control-char санитизация
// недоверенного ввода (как sanitize() в verify-changes.js). Не нарушай инвариант.
function formatBanner(missing) {
  if (!missing || missing.length === 0) return "";
  const lines = ["main-skill: рекомендованные плагины не установлены —"];
  for (const p of missing) lines.push(`  • ${p.name} — ${p.why}`);
  lines.push(
    "Workflow работает и без них (мягкая деградация). Поставить: /plugin. Отключить проверку: MAIN_SKILL_PLUGIN_CHECK=0",
  );
  return lines.join("\n");
}

// settings.json свой и мал; cap страхует от раздутого/враждебного файла.
const MAX_SETTINGS_BYTES = 5 * 1024 * 1024;

// Читает ~/.claude/settings.json. Любая аномалия → null (fail-soft).
// isFile-guard обязателен: без него readFileSync завис бы на FIFO/сокете, заморозив
// SessionStart (та же политика, что у transcript-input в verify-changes.js).
function readSettings(homeDir) {
  try {
    const home = homeDir || os.homedir();
    if (!home) return null;
    const p = path.join(home, ".claude", "settings.json");
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_SETTINGS_BYTES) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function run() {
  if (process.env.MAIN_SKILL_PLUGIN_CHECK === "0") return;
  let banner = "";
  try {
    banner = formatBanner(missingRecommended(readSettings()));
  } catch {
    return; // fail-soft: SessionStart никогда не должен ломаться из-за этой проверки
  }
  if (banner) process.stdout.write(banner + "\n");
}

if (require.main === module) run();

module.exports = {
  RECOMMENDED,
  enabledPluginNames,
  missingRecommended,
  formatBanner,
  readSettings,
};
