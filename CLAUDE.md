# main-skill — заметки для разработчика плагина

Этот файл — для тех, кто правит сам плагин (этот репо). Он автоматически грузится Claude Code как project-memory, когда работаешь внутри `/Users/alex/Documents/main-skill/`. **User-facing правила (язык, логирование, доки, удаление, дубли процессов и т.п.) живут в `skills/workflow-rules/SKILL.md`** — этот файл их не дублирует.

## Что это за репо

Personal Claude Code плагин с workflow-правилами. Распространяется через marketplace (см. `.claude-plugin/marketplace.json`), устанавливается на любую машину одной командой (см. `README.md` → Install).

Ключевая идея: SessionStart-хук подталкивает Claude вызвать `Skill: main-skill:workflow-rules` в начале сессии — содержимое skill приходит через нормальный skill-канал (без 10KB-кап-а на stdout хуков). User-facing правила — в `SKILL.md`. Всё, что не помещается в SKILL.md и применяется условно/по триггеру — в `skills/workflow-rules/references/*.md`.

## Структура

```
main-skill/
├── .claude-plugin/
│   ├── plugin.json         # манифест плагина (version → bump на каждом коммите)
│   └── marketplace.json    # делает репо installable как marketplace
├── skills/
│   └── workflow-rules/
│       ├── SKILL.md        # ядро: 3-фазный workflow + universal rules
│       └── references/     # справочные файлы (Stop-triggers и т.п.)
├── hooks/
│   ├── hooks.json          # регистрация SessionStart + PostToolUse + Stop
│   ├── session-start.sh    # update-check + инструкция вызвать skill
│   ├── auto-format.js      # PostToolUse-хук: форматирует файл prettier/ruff/gofmt/rustfmt/clang-format
│   ├── auto-format.test.js
│   ├── verify-changes.js   # Stop-хук с триггерами A–K
│   ├── verify-changes.test.js
│   └── lib/
│       ├── checks.js       # src↔test mapping (включая generic same-dir
│       │                   # fallback `<base>.test.<ext>` для sh/lua/dart/...),
│       │                   # edge-cases parser, auto-lint
│       └── checks.test.js
├── CLAUDE.md               # ← этот файл (dev-facing only)
└── README.md
```

## Bump version при каждой правке

При **любой** правке файла в этом репо — увеличь `version` в `.claude-plugin/plugin.json` (patch-инкремент по умолчанию) **до коммита**. Без bump-а `claude plugin update` на потребительских машинах не подтянет свежий контент из кеша.

## Как писать правила в SKILL.md / CLAUDE.md / references

Кратко, по делу, жёстко на исполнение. Одно правило — заголовок + 1–3 строки. Без преамбул «почему это важно», без буллет-листов на 8 пунктов, без дублирования системного промпта. Глаголы в повелительном: «делай X», «не делай Y». Если не умещается в абзац — режь, пока не уместится.

Перед коммитом перечитай свой diff: для каждой добавленной секции > 5 строк выкинь треть. Если пользователь спросил «не раздул ли?» — правило уже провалено.

## Тестирование хуков

```bash
# unit + integration для Stop-хука
node hooks/verify-changes.test.js
node hooks/lib/checks.test.js

# unit для PostToolUse auto-format
node hooks/auto-format.test.js

# sh-синтаксис для SessionStart
sh -n hooks/session-start.sh
```

Любая правка `verify-changes.js` / `checks.js` / `auto-format.js` без обновления соответствующих `*.test.js` — нарушение Stop-триггера D.

## Skip-rules для триггера D — что НЕ требует парного теста

Источник истины — `SKIP_PATH_PATTERNS` / `SKIP_FILENAME_PATTERNS` в `hooks/lib/checks.js`. Если меняешь — синхронизируй и advertise-message в `verify-changes.js` (`reasonD`), и эту секцию.

- **Path-skip**: `migrations?/`, `migrate/`, `alembic/`, `seed(ers|s)?/`, `fixtures?/`, `locales?/i18n/translations?/`, `__generated__/`, `.generated/`, `start/`, `bootstrap/`, `infra/`, `infrastructure/`, `__mocks__/`.
- **Filename-skip**: timestamped migrations, `*.d.ts`, `*.generated.*`, `*.gen.*`, `*.pb.go`, `*_pb2(_grpc)?.py`, `*.sql.go`, framework-configs (`vite|next|nuxt|svelte|astro|tailwind|postcss|babel|jest|vitest|rollup|tsup|webpack|esbuild|drizzle|playwright`), операционные shell-скрипты (`install|deploy|bootstrap|setup|provision|teardown|sync[-_]config`).sh, Storybook stories (`*.stories.{tsx,jsx,ts,js}`).
- **Content-skip**: `@generated` заголовок, type-only TS-файлы (только `interface`/`type`/`const enum`).
- **Не code-файлы для триггера D** (`isCodeFile = false`, никакого парного теста не ищется): стили `.css/.scss/.sass/.less` и разметка `.html/.htm` — визуальная верификация, не unit-тест на сам файл стилей.
- **Намеренно НЕ skip-ятся** (бывает реальная логика → должен быть тест либо явный per-project ignore): `config/`, `deploy/`, `scripts/`, generic ops-имена `run.sh`/`entrypoint.sh`/`healthcheck.sh`. Юзер в своём проекте отключает их через `MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/config/**:**/deploy/**"`.

Принцип: skip-default-ы консервативные (low false-negatives). Project-specific tradeoff делается на уровне проекта env-переменной, не глобальным паттерном.

## Размер SKILL.md

Целевой кап — **под 5000 токенов** (≈ 20KB ASCII / ~12KB Cyrillic-heavy), потому что после компакции Claude Code перезагружает только первые 5000 токенов каждого вызванного skill. Контент за капом — в `references/*.md` со ссылкой из SKILL.md, либо в этот CLAUDE.md (если только dev-facing).

500 строк — мягкая рекомендация Claude Code; 5000 токенов — реальное узкое место.
