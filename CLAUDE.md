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
├── commands/
│   ├── off.md              # /main-skill:off — выключить плагин в текущей сессии
│   ├── on.md               # /main-skill:on — снова включить
│   └── check-ignore-globs.md # /main-skill:check-ignore-globs — аудит широких
│                           # MAIN_SKILL_VERIFY_IGNORE_GLOBS в проекте
├── skills/
│   └── workflow-rules/
│       ├── SKILL.md        # ядро: 3-фазный workflow + universal rules
│       └── references/     # справочные файлы (stop-triggers,
│                           # circle-plan-authoring — формат плана под circle-skill)
├── hooks/
│   ├── hooks.json          # регистрация SessionStart + PreToolUse + PostToolUse + Stop
│   ├── session-start.sh    # update-check + plugin-check + skill-инструкция + сброс off-сентинела
│   ├── session-start.test.sh # integration-тесты для session-start.sh
│   ├── claudemd-guard.js   # PreToolUse-хук: deny на крупное раздувание CLAUDE.md
│   ├── claudemd-guard.test.js
│   ├── auto-format.js      # PostToolUse-хук: форматирует файл prettier/ruff/gofmt/rustfmt/clang-format
│   ├── auto-format.test.js
│   ├── verify-changes.js   # Stop-хук с триггерами A–K
│   ├── verify-changes.test.js
│   └── lib/
│       ├── checks.js       # src↔test mapping (включая generic same-dir
│       │                   # fallback `<base>.test.<ext>` для sh/lua/dart/...),
│       │                   # edge-cases parser, auto-lint
│       ├── checks.test.js
│       ├── audit-ignore-globs.js  # CLI за /main-skill:check-ignore-globs —
│       │                   # аудит MAIN_SKILL_VERIFY_IGNORE_GLOBS в проекте
│       ├── audit-ignore-globs.test.js
│       ├── plugin-check.js  # детект рекомендованных плагинов для SessionStart-баннера
│       ├── plugin-check.test.js
│       ├── session-disabled.js  # рантайм-проверка off-сентинела / MAIN_SKILL_OFF для всех хуков
│       └── session-disabled.test.js
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

# unit для PreToolUse claude-md-guard
node hooks/claudemd-guard.test.js

# unit для SessionStart plugin-check
node hooks/lib/plugin-check.test.js

# unit для per-session disable
node hooks/lib/session-disabled.test.js

# unit для audit-ignore-globs (за /main-skill:check-ignore-globs)
node hooks/lib/audit-ignore-globs.test.js

# integration для SessionStart-хука (+ sh-синтаксис)
sh -n hooks/session-start.sh
sh hooks/session-start.test.sh
```

Любая правка `verify-changes.js` / `checks.js` / `auto-format.js` / `plugin-check.js` / `claudemd-guard.js` / `session-disabled.js` / `audit-ignore-globs.js` без обновления соответствующих `*.test.js` — нарушение Stop-триггера D.

## Per-session disable (`/main-skill:off`)

`commands/off.md` создаёт сентинел `~/.claude/plugins/.main-skill-off`; `lib/session-disabled.js` (`isDisabled`) читает его в рантайме, и все три node-хука (`verify-changes`, `claudemd-guard`, `auto-format`) при его наличии делают no-op. `commands/on.md` удаляет сентинел. `MAIN_SKILL_OFF=1` (launch-time env) — эквивалент на всю сессию.

- **Файл, а не env:** env фиксируется при старте процесса → не выключить посреди сессии после `/clear`. Сентинел читается на каждый вызов → команда работает без перезапуска.
- **Авто-сброс:** `session-start.sh` удаляет сентинел на каждом SessionStart (`startup|resume|clear`) и при `MAIN_SKILL_OFF=1` выходит сразу (ни апдейта, ни skill-инструкции). Значит disable живёт только до следующего `/clear`/рестарта — ровно «эта сессия».
- **Команда — это промпт:** слэш-команда не выгружает уже зарегистрированные хуки; сентинел глушит их teeth (Stop-блок), а тело команды велит Claude не применять workflow-rules.
- **Fail-soft:** аномалия чтения (нет HOME, ошибка stat) → `isDisabled`=false (плагин ВКЛ), при сомнении не отключаемся молча.
- **Known limitation:** сентинел глобальный (user-level), не привязан к `session_id` → пока активен, заденет параллельные окна Claude Code. Для одно-оконного потока корректно; многооконный — компромисс в пользу простоты.

Правка форматов сентинела / команд / reset-логики → синхронизируй `session-disabled.test.js`, `session-start.test.sh` и эту секцию.

## SessionStart plugin-check баннер

`session-start.sh` → `emit_plugin_check` зовёт `lib/plugin-check.js`, который читает `~/.claude/settings.json` (`enabledPlugins`) и печатает **неблокирующий** баннер, если рекомендованный плагин не включён. Набор `RECOMMENDED` — источник истины то, на что ссылается `SKILL.md` (триаж/UI): `superpowers`, `ui-ux-pro-max`. Матч по base-имени до `@` (любой marketplace-суффикс считается). `value=false` (установлен, но выключен) = missing. Нет валидного `enabledPlugins` → `[]` (не шумим ложным баннером). Fail-soft: любая ошибка чтения/парса → тишина, SessionStart не ломается. Опт-аут: `MAIN_SKILL_PLUGIN_CHECK=0`.

**Known limitation:** читается только user-level `~/.claude/settings.json`. Плагин, включённый через project-level `.claude/settings.json`, может ложно попасть в «не установлен». Минор — `enabledPlugins` Claude Code хранит на user-level.

## PreToolUse claude-md-guard

`claudemd-guard.js` гасит раздувание CLAUDE.md в точке письма. На `Edit`/`Write`/`MultiEdit` по basename `CLAUDE.md` считает **net-прирост строк правки** (`netAddedLines`: добавлено − удалено); дописывание в существующий файл ≥ порога → `permissionDecision:deny` с дистиллятом правил claude-md-management. Порог 20 (`MAIN_SKILL_CLAUDEMD_MAXADD`), опт-аут `MAIN_SKILL_CLAUDEMD_CHECK=0`.

- **Net, не абсолютный размер:** у Claude Code нет официального капа на CLAUDE.md — абсолют фолсил бы на легитимно больших файлах.
- **Создание-с-нуля не гардится** (`isCreation`: файл пуст/отсутствует) — свежий плотный CLAUDE.md не раздувание. `deny` только на дописывание.
- **deny, а не `additionalContext`:** PreToolUse не переписывает pending-правку (content уже зафиксирован) — повлиять можно только deny+reason, Claude переиздаёт ужатую. Мелкие правки молчат.
- **reason** захардкожен в `buildReason`: статичный текст + целые числа, недоверенного ввода нет → ANSI-санитизация не нужна (инвариант `formatBanner`). `claude-md-management` включён → reason зовёт `claude-md-improver`.
- **Fail-soft:** аномалия чтения → `safeReadFile`=`null` → правка пропускается, Edit не ломается.
- **Known gap:** «тысяча мелких правок» не ловится — метрика на одну операцию.

Правка форматов входа / порога / reason → синхронизируй `claudemd-guard.test.js` и эту секцию.

## PreToolUse ignore-glob-guard

`ignore-glob-guard.js` бьёт по широкому `MAIN_SKILL_VERIFY_IGNORE_GLOBS` в момент записи. На `Edit/Write/MultiEdit` в env-carrier-файл (`isEnvCarrierFile`: `.env*`, `settings.json`/`settings.local.json`, `.mcp.json`, shell-rc `.bashrc/.zshrc/.zshenv/.bash_profile/.zprofile/.profile/.envrc`, `*.sh`) и на `Bash` command парсит присваивания `VAR` (`extractIgnoreGlobs`: bare `.env`, shell `export`, JSON, одинарные кавычки; сплит по `:`). Любой НОВО введённый глоб, для которого `checks.isBroadIgnoreGlob`, → `permissionDecision:deny` с требованием сузить. Опт-аут `MAIN_SKILL_IGNORE_GLOB_CHECK=0`.

- **Широкий глоб — по сути всегда не тот инструмент:** смешанная папка → сузить до имени/расширения; весь централизованный репо → `VERIFY_CHANGES=0`. Поэтому deny корректен во всех случаях, reason разводит их.
- **`isBroadIgnoreGlob` (в `checks.js`, общий).** Broad = последний сегмент после снятия ведущего wildcard-рана либо пуст (`dir/**`, `config/*`), либо ОДНО расширение (`*.ts`, `*.*`, `**/*.py`, `src/**/*.*` — весь язык/дерево, по эффекту шире каталога). Narrow = литеральный якорь: имя (`schema.ts`, `build-*.sh`) или СОСТАВНОЕ расширение (`*.gen.ts`, `*.pb.go`, `*.d.ts`, `*.config.ts`). Голое `**/*.ts` — намеренно broad: иначе Claude обходил бы guard, дописав дефолт-расширение.
- **Диф против «старого» обязателен (`addedBroadGlobs`):** флажим только ново-введённый широкий глоб — Edit/MultiEdit против `old_string`, Write против содержимого на диске (`safeReadFile`), Bash — вся команда (старого нет). Иначе правка, лишь эхо-ящая уже существующий широкий глоб (или полный Write файла с ним), отклонялась бы навсегда.
- **env-carrier-гейт обязателен:** без него правка `README.md` / `stop-triggers.md` (примеры с `VAR`) и исходника `verify-changes.js` (пример-строка) ложно словила бы deny сама на себя. Доки/исходники — не carrier → пропускаются. Match по lower-case basename; блаженного `.claude/*` НЕТ (иначе `.claude/commands/*.md` с примером ложно бы гардился) — под `.claude/` ловятся только `settings*.json`/`.mcp.json`/`*.sh` по basename.
- **`extractIgnoreGlobs` — защиты от ложного матча:** lookbehind `(?<![\w])` перед `VAR` (не ловим `LEGACY_…_IGNORE_GLOBS`); skip присваивания в закомментированной строке (в префиксе строки до матча есть `#`) — инструктивный пример в `.sh`/`.env` не deny-ит.
- **Guard vs runtime-honoring раздельны:** Stop-хук `verify-changes` по-прежнему ЧЕСТИТ любой глоб как opt-out (широкий тоже) — юзер, поставивший его вручную или через `IGNORE_GLOB_CHECK=0`, не блокируется в рантайме. Guard лишь мешает Claude ЗАПИСАТЬ широкий.
- **Sanitize обязателен:** глоб — недоверенный Claude-content, эхо-ится в reason → `sanitizeGlob` стрипует C0/C1-controls + BiDi-override строго как `sanitize` в verify-changes (источник истины; не давать дрейфовать).
- **Fail-soft:** malformed payload / нет content → `null`/`[]`, PreToolUse не ломается; `safeReadFile` при аномалии → `""` (Write-диф считает всё новым — fail-safe в сторону deny).
- **Known gaps:** carrier-список фиксирован — `VAR` в `docker-compose.yml` / `Makefile` / `.github/workflows/*.yml` не гардится (false-negative; редко). Bash `export` эфемерен (не персистит), но ловим и его.

Правка `isEnvCarrierFile` / `extractIgnoreGlobs` / `addedBroadGlobs` / `isBroadIgnoreGlob` / reason → синхронизируй `ignore-glob-guard.test.js`, `checks.test.js` и эту секцию.

## audit-ignore-globs (за `/main-skill:check-ignore-globs`)

`lib/audit-ignore-globs.js` — ретроспективный аудит уже заданных `MAIN_SKILL_VERIFY_IGNORE_GLOBS`. Гард бьёт только по НОВОЙ записи широкого глоба; глобы, поставленные до его появления, остаются — эта команда их находит. `collectSources` собирает источники (env → carrier-файлы проекта через `walkCarrierFiles` → home-carriers `~/.claude/settings*.json` + shell-rc), `classifySources` разносит через `isBroadIgnoreGlob`, `formatReport` печатает отчёт. Standalone: `node hooks/lib/audit-ignore-globs.js <dir>`.

- **Zero-дубль классификации:** broad/narrow-решение — только `isBroadIgnoreGlob` (`checks.js`); поиск присваиваний — `extractIgnoreGlobs`, carrier-детект — `isEnvCarrierFile`, эхо-очистка — `sanitizeGlob` (всё из `ignore-glob-guard.js`). Локален лишь `describeBroad` — cosmetic-формулировка «почему широкий», не гейт.
- **Команда — интерактивная обёртка:** скрипт только детектит; сужение (осмотр папки, замена на имя/расширение или `VERIFY_CHANGES=0`, правка источника) делает Claude по телу `check-ignore-globs.md` с подтверждением юзера.
- **Только по явному вызову:** `description` команды и guard-абзац в теле запрещают авто-вызов по инициативе Claude (единственный вектор авто-запуска plugin-команды — матч `description` в списке skill'ов; сам скрипт хуками нигде не дёргается). Запускается лишь когда юзер набрал `/main-skill:check-ignore-globs` или прямо попросил.
- **Локатор скрипта в команде:** `${CLAUDE_PLUGIN_ROOT}` → fallback `find ~/.claude/plugins ... | sort -V | tail -1` (в Bash-инструменте Claude env-var обычно пуст → работает fallback).
- **Fail-soft:** нечитаемый файл → `""`, walk пропускает `node_modules/.git/dist/...` и уходит не глубже 8; size-cap 2MB на файл.
- **Известный компромисс:** тест-фикстуры с широким глобом нельзя создавать через Bash — их поймает сам ignore-glob-guard (`printf ... VAR=src/**`); в тестах пиши файлы через `fs.writeFileSync`, для ручной проверки CLI — node-скриптом с разбитым именем VAR.

Правка источников/формата отчёта → синхронизируй `audit-ignore-globs.test.js` и эту секцию.

## Skip-rules для триггера D — что НЕ требует парного теста

Источник истины — `SKIP_PATH_PATTERNS` / `SKIP_FILENAME_PATTERNS` в `hooks/lib/checks.js`. Если меняешь — синхронизируй и advertise-message в `verify-changes.js` (`reasonD`), и эту секцию.

- **Path-skip**: `migrations?/`, `migrate/`, `alembic/`, `seed(ers|s)?/`, `fixtures?/`, `locales?/i18n/translations?/`, `__generated__/`, `.generated/`, `start/`, `bootstrap/`, `infra/`, `infrastructure/`, `__mocks__/` (применяется на любой глубине: `src/__mocks__/`, `packages/foo/__mocks__/lib/x.ts` — всё внутри `__mocks__/` считается Jest-моками; компромисс — если положить туда реальную логику, она не будет требовать тест).
- **Filename-skip**: timestamped migrations, `*.d.ts`, `*.generated.*`, `*.gen.*`, `*.pb.go`, `*_pb2(_grpc)?.py`, `*.sql.go`, framework-configs (`vite|next|nuxt|svelte|astro|tailwind|postcss|babel|jest|vitest|rollup|tsup|webpack|esbuild|drizzle|playwright`), операционные shell-скрипты (`install|deploy|bootstrap|setup|provision|teardown|sync[-_]config`).sh, Storybook stories (`*.stories.{tsx,jsx,ts,js}`).
- **Content-skip**: `@generated` заголовок, type-only TS-файлы (только `interface`/`type`/`const enum`), презентационные SFC (`.vue/.svelte/.astro`) — см. ниже.
- **Презентационные SFC** (`isPresentationalSFC` в `checks.js`): `.vue/.svelte/.astro` скипаются, только если в `<script>` (Vue/Svelte) или frontmatter (Astro) НЕТ логики — лишь `import` / `defineProps` / `defineEmits` / типы, либо script вообще отсутствует. Любой сигнал логики (`computed`/`watch`/lifecycle-хук/`function`/control-flow/`await`/`.map().filter()`/Options-`methods`/Svelte `$:`/руны/arrow-функция как значение или коллбэк) → НЕ skip, тест обязателен. Консервативно: типовая аннотация `onClick: () => void` логикой не считается (arrow ловится только в позиции значения `= (..) =>` / коллбэка `f(() =>`). Компромисс — false-positive безопаснее false-negative; чисто-презентационный компонент с тривиальным форматтером может потребовать тест (снимается env-игнором пути). Цель — чтобы Клод не игнорил `**/*.vue` целиком, пряча логику.
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

## Выбор терминального сообщения (`findLastAssistantText`)

Все триггеры оценивают `lastText` — текст **терминального** assistant-сообщения хода, т.е. последнего text-блока, ПОСЛЕ которого нет `tool_use`. Промежуточный нарратив (текст, за которым в том же ходе идёт ещё `tool_use` — напр. «делаю X» перед тул-коллом) НЕ считается «готово»-claim: иначе success-слово в нём даёт ложный A/F, а при flush-гонке (финал ещё не сброшен на диск) хук блокирует по устаревшему сообщению. Функция сканирует с конца, флагом `sawToolUseAfter`; нет терминального текста → `""` → хук выходит без блока (fail-open, корректно для незавершённого хода). Тесты — `verify-changes.test.js` секция `lastText:`.

## Размер SKILL.md

Целевой кап — **под 5000 токенов** (≈ 20KB ASCII / ~12KB Cyrillic-heavy), потому что после компакции Claude Code перезагружает только первые 5000 токенов каждого вызванного skill. Контент за капом — в `references/*.md` со ссылкой из SKILL.md, либо в этот CLAUDE.md (если только dev-facing).

500 строк — мягкая рекомендация Claude Code; 5000 токенов — реальное узкое место.
