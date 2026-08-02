#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Не менять, потому что список обязан совпадать с плагинами, на скиллы которых
// ссылается workflow-rules SKILL.md: лишнее имя = баннер про плагин, без которого
// ничего не деградирует.
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

function enabledPluginNames(settings) {
  const out = new Set();
  const ep = settings && settings.enabledPlugins;
  if (!ep || typeof ep !== "object") return out;
  for (const [key, val] of Object.entries(ep)) {
    if (val === true) out.add(String(key).split("@")[0]);
  }
  return out;
}

// Не менять, потому что без валидного enabledPlugins ответ обязан быть пустым:
// иначе баннер врёт про «не установлен» на каждом нечитаемом settings.json.
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

// Не менять, потому что в баннер идут только hardcoded-имена из RECOMMENDED:
// значение из settings.json потребовало бы ANSI-санитизации, как sanitize() в
// verify-changes.js.
function formatBanner(missing) {
  if (!missing || missing.length === 0) return "";
  const lines = ["main-skill: рекомендованные плагины не установлены —"];
  for (const p of missing) lines.push(`  • ${p.name} — ${p.why}`);
  lines.push(
    "Workflow работает и без них (мягкая деградация). Поставить: /plugin. Отключить проверку: MAIN_SKILL_PLUGIN_CHECK=0",
  );
  return lines.join("\n");
}

const MAX_SETTINGS_BYTES = 5 * 1024 * 1024;

// Не менять, потому что statSync без isFile-guard даёт зависание на FIFO/сокете —
// SessionStart замёрзнет целиком.
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
    return;
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
