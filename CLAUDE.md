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

- **Path-skip**: `migrations?/`, `migrate/`, `alembic/`, `seed(ers|s)?/`, `fixtures?/`, `locales?/i18n/translations?/`, `__generated__/`, `.generated/`, `start/`, `bootstrap/`, `infra/`, `infrastructure/`, `__mocks__/` (применяется на любой глубине: `src/__mocks__/`, `packages/foo/__mocks__/lib/x.ts` — всё внутри `__mocks__/` считается Jest-моками; компромисс — если положить туда реальную логику, она не будет требовать тест).
- **Filename-skip**: timestamped migrations, `*.d.ts`, `*.generated.*`, `*.gen.*`, `*.pb.go`, `*_pb2(_grpc)?.py`, `*.sql.go`, framework-configs (`vite|next|nuxt|svelte|astro|tailwind|postcss|babel|jest|vitest|rollup|tsup|webpack|esbuild|drizzle|playwright`), операционные shell-скрипты (`install|deploy|bootstrap|setup|provision|teardown|sync[-_]config`).sh, Storybook stories (`*.stories.{tsx,jsx,ts,js}`).
- **Content-skip**: `@generated` заголовок, type-only TS-файлы (только `interface`/`type`/`const enum`).
- **Не code-файлы для триггера D** (`isCodeFile = false`, никакого парного теста не ищется): стили `.css/.scss/.sass/.less` и разметка `.html/.htm` — визуальная верификация, не unit-тест на сам файл стилей.
- **Намеренно НЕ skip-ятся** (бывает реальная логика → должен быть тест либо явный per-project ignore): `config/`, `deploy/`, `scripts/`, generic ops-имена `run.sh`/`entrypoint.sh`/`healthcheck.sh`. Юзер в своём проекте отключает их через `MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/config/**:**/deploy/**"`.

Принцип: skip-default-ы консервативные (low false-negatives). Project-specific tradeoff делается на уровне проекта env-переменной, не глобальным паттерном.

## Триггер L — dep version-lookup enforcement

`verify-changes.js` детектит правки manifest-файлов через `collectManifestDepsFromEdits` (parses **то что Claude написал в Edit/Write/MultiEdit** — не итог на диске, чтобы не флагать legacy deps). Поддержанные форматы — в `parseManifestDeps` (`hooks/lib/checks.js`):

- `package.json` (JSON.parse целиком + regex-fallback для фрагментов; `engines.node` → type=runtime)
- `requirements*.txt` / `constraints.txt`
- `pyproject.toml` (`[project.dependencies]` PEP-621, `[tool.poetry.dependencies]`)
- `Cargo.toml` (`[dependencies]` / `[dev-dependencies]` / `[build-dependencies]`)
- `go.mod` (require block + single-line require + `go 1.x` → runtime)
- `Dockerfile`, `Dockerfile.<suffix>` (FROM lines; `latest` / `scratch` / без tag — skip)
- `.nvmrc`, `.python-version`, `.tool-versions` (asdf)
- `.github/workflows/*.yml` (`uses: org/repo@vX`; локальные `./...` — skip)

Lookup-детектор `findVersionLookups` ловит:

- Bash: `npm view|info|show <pkg>`, `pip3? index versions <pkg>` / `pip show`, `cargo search <pkg>`, `go list -m -versions`, `gh api repos/<org>/<repo>/releases`, `git ls-remote <github-url>`, `docker manifest inspect`
- WebFetch / WebSearch: `endoflife.date/api/<product>` (норм. `nodejs`→`node`), `nodejs.org/dist`, `python.org/downloads`, `registry.npmjs.org/<pkg>`, `npmjs.com/package/<pkg>`, `pypi.org/(pypi|project)/<pkg>`, `crates.io/(api/v\d+/)?crates/<pkg>`, `pkg.go.dev/<module>`, `proxy.golang.org/<module>`, `hub.docker.com/(_|r/<owner>)/<image>`, `github.com/<org>/<repo>/releases`
- Cross-type fallback: lookup в `runtime` покрывает совпадающее имя в `docker` и наоборот (FROM node:18 + endoflife/api/nodejs → ОК).

Loose-версии не требуют lookup-а: `latest`, `*`, `x`, `>=0`, голый `>=`. Так Claude может явно писать «не пиню» — пакет-менеджер резолвит latest при install.

Размещение в pipeline: L срабатывает **отдельно** от ветки `if (lastEditIdx >= 0)` — потому что `package.json`/`*.yml` classify-ятся как `config`, не `observable`. Anti-loop guard: если `lastBlockIdx > lastManifestEditIdx` — пропускаем (юзер ещё не ответил на предыдущий блок).

**Known limitations:**

- **Корпоративные прокси npm/pypi** (Verdaccio, Artifactory, JFrog) — `WebFetch verdaccio.corp/<pkg>` НЕ ловится; считается false-negative для трига L. Workaround: `MAIN_SKILL_VERIFY_DEPS=0` в проектах с приватным registry, либо альтернативный lookup через `npm view` (его ловит).
- **`[project.optional-dependencies]`** в pyproject.toml как массив строк — не парсится (только `[project.dependencies]`). Минор, optional-deps редко критичны.
- **Docker SHA-pinned** (`FROM node@sha256:...`) — silently skip (SHA-pin = максимально специфичен, lookup не нужен). Корректное поведение, не баг.

Любая правка форматов → синхронизируй парсер, тесты в `checks.test.js`, integration-тесты в `verify-changes.test.js`, advertise-message `reasonL` в `verify-changes.js`, и эту секцию.

## Hardening hook input

`verify-changes.js` принимает `transcript_path` через stdin и читает файл с диска. Защиты:

- `realpathSync` — резолвит symlinks, чтобы attacker не мог через `~/.claude/x.jsonl → /etc/passwd` подсунуть произвольный файл.
- `isFile()` guard — отказ если путь это директория, FIFO, socket. Иначе хук может застрять на блокирующем чтении.
- `MAX_TRANSCRIPT_BYTES = 50 MB` — отказ на больших файлах. Без cap-а длинная сессия с image-вложениями могла бы съесть OOM Node-процесс.
- `sanitize(s)` стрипует все control-chars (`[\x00-\x1f\x7f]`) перед эхо в `reason`. Без него имя файла вида `src/\x1b[2K\x1b[1Aevil.ts` (ANSI-инжекция) при выводе перезапишет предыдущие строки терминала юзера.

Любая аномалия (broken symlink, не файл, размер свыше cap-а, exception на stat) — silent exit без `decision:block`. Хук должен fail-soft, чтобы не блокировать Stop из-за инфраструктурной странности.

## Размер SKILL.md

Целевой кап — **под 5000 токенов** (≈ 20KB ASCII / ~12KB Cyrillic-heavy), потому что после компакции Claude Code перезагружает только первые 5000 токенов каждого вызванного skill. Контент за капом — в `references/*.md` со ссылкой из SKILL.md, либо в этот CLAUDE.md (если только dev-facing).

500 строк — мягкая рекомендация Claude Code; 5000 токенов — реальное узкое место.
