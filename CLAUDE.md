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
│       └── references/     # справочные файлы (stop-triggers, testing-strategy,
│                           # premortem — few-shot пример + классы контрактов,
│                           # verify-done — evidence-рецепты + build-your-own-harness,
│                           # circle/worktree-plan-authoring — форматы планов)
├── hooks/
│   ├── hooks.json          # регистрация SessionStart + PreToolUse + PostToolUse + Stop
│   ├── session-start.sh    # update-check + plugin-check + skill-инструкция + сброс off-сентинела
│   ├── session-start.test.sh # integration-тесты для session-start.sh
│   ├── claudemd-guard.js   # PreToolUse-хук: deny на крупное раздувание CLAUDE.md
│   ├── claudemd-guard.test.js
│   ├── auto-format.js      # PostToolUse-хук: форматирует файл prettier/ruff/gofmt/rustfmt/clang-format
│   ├── auto-format.test.js
│   ├── verify-changes.js   # Stop-хук с триггерами A–N
│   ├── verify-changes.test.js
│   └── lib/
│       ├── checks.js       # src↔test mapping (включая generic same-dir
│       │                   # fallback `<base>.test.<ext>` для sh/lua/dart/...,
│       │                   # same-dir `tests|test/<base>.(test|spec).<ext>`
│       │                   # и import-scan fallback центральных спеков),
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

Кратко, по делу. Одно правило — заголовок + 1–3 строки. Без преамбул «почему это важно», без буллет-листов на 8 пунктов, без дублирования системного промпта. Глаголы в повелительном: «делай X», «не делай Y». Если не умещается в абзац — режь, пока не уместится.

Стиль под модели 5-го поколения (плагин используется только с ними; [обоснование](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)): переограничение вредит — без CAPS-нажима («ОБЯЗАН», «НИКОГДА», «ЗАПРЕЩЁН»), без «списков не-делай» и повторов-для-надёжности. Правило = принцип + enforcement-ссылка: давление несёт хук (Stop-триггер / deny-guard), не тон текста. Каждый порог/список живёт в одном каноническом месте (пороги J/N и security-regex — `stop-triggers.md`), остальные места ссылаются. Исключение — машинопроверяемые форматы блоков (`<premortem>`, `<edge-cases>`, `<self-review>`, `<review-triage>`): шаблон показывай целиком, это спецификация валидатора, а не few-shot.

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

## AgentTool-гейт моделей 5-го поколения

Сервер подмешивает gen-5-моделям в системный промпт «Do not call the AgentTool unless the user requested it» (кеш `.claude.json` → `clientDataCacheSlots`, tengu-флаг; локальная чистка бесполезна — пересинхронизируется, публичной ручки нет). Модель трактует «user requested» узко и пропускает ревью-сабагентов триггера J, делая ревью сама. Контр-авторизация («запуск ревью-сабагентов = standing-запрос юзера, гейт снят своим же "unless"») продублирована в трёх каналах плагина: SKILL.md §self-review, `reasonJ` (howTo), `emit_skill_invocation` в `session-start.sh`; четвёртый и самый авторитетный — строка в юзерском `~/.claude/CLAUDE.md`, которую `ensure_standing_request` в `session-start.sh` сам провиженит (идемпотентный append одним printf по маркеру ИЛИ payload-якорю «Standing request (main-skill)» — переживает стирание HTML-comment'а `claude-md-improver`-ом; баннер при записи, действует со 2-й сессии, opt-out `MAIN_SKILL_CLAUDEMD_PROVISION=0`; guard'ы: пустой HOME и симлинк-CLAUDE.md → пропуск, `2>/dev/null` до `>>` — иначе утечка stderr на read-only. Известные компромиссы: N гонящихся первых стартов дают до N−1 безвредных дублей; ручное удаление строки без opt-out перезаписывается; после деинсталляции плагина строка остаётся — README велит удалить руками; read-only HOME → тихий no-op, сессию страхует SessionStart-инструкция). Потолок teeth задокументирован: анти-луп-гард `lastBlockIdx > lastEditIdx` в `verify-changes.js` пропускает повторный Stop после одного блока — «слово юзеру» by design, поэтому упорный отказ модели хуком не дожимается, решает юзерский канал. Правка формулировок → синхронизируй все четыре точки + `session-start.test.sh` + тест reasonJ в `verify-changes.test.js`.

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

- **Широкий глоб — по сути всегда не тот инструмент:** смешанная папка → сузить до имени/расширения; централизованные тесты D засчитывает сам (import-scan fallback, см. ниже); спеки вовсе без импортов исходников → `VERIFY_CHANGES=0`. Поэтому deny корректен во всех случаях, reason разводит их.
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

- **Path-skip**: `migrations?/`, `migrate/`, `alembic/`, `seed(ers|s)?/`, `fixtures?/`, `locales?/i18n/translations?/`, `__generated__/`, `.generated/`, `start/`, `bootstrap/`, `providers/*_provider.(ts|js)` (AdonisJS wiring — конвенция имени, не каталог), `infra/`, `infrastructure/`, `__mocks__/` (применяется на любой глубине: `src/__mocks__/`, `packages/foo/__mocks__/lib/x.ts` — всё внутри `__mocks__/` считается Jest-моками; компромисс — если положить туда реальную логику, она не будет требовать тест).
- **Filename-skip**: timestamped migrations, `*.d.ts`, `*.generated.*`, `*.gen.*`, `*.pb.go`, `*_pb2(_grpc)?.py`, `*.sql.go`, framework-configs (`vite|next|nuxt|svelte|astro|tailwind|postcss|babel|jest|vitest|rollup|tsup|webpack|esbuild|drizzle|playwright` + `adonisrc.(ts|js)`), AdonisJS `bin/(server|console|test).(ts|js)` и корневой `ace.js`, операционные shell-скрипты (`install|deploy|bootstrap|setup|provision|teardown|sync[-_]config` + опц. bounded `[-_]суффикс{1,40}`: `deploy-server.sh`), Storybook stories (`*.stories.{tsx,jsx,ts,js}`).
- **Content-skip**: `@generated` заголовок, type-only TS-файлы (только `interface`/`type`/`const enum`), декларативные ORM-модели (Lucid/TypeORM — см. ниже), презентационные SFC (`.vue/.svelte/.astro`) — см. ниже.
- **Декларативные ORM-модели** (`isDeclarativeModelFile` в `checks.js`, `.ts/.js`): skip = гейт (Lucid `extends *BaseModel`, суффикс пропускает кастомную базу; TypeORM `@Entity(` в начале строки — не матчится в строковом литерале; `extends compose(...)` не проходит — миксин несёт поведение) И ≥1 column/relation/`declare`-поле И ноль сигналов логики после stripBlockComments. Легальны только relation-thunk-стрелки в аргументной позиции (`() => Model`, inverse-side `(x) => x.prop` без вызова); любая другая стрелка (`= () =>`, `serialize:`/`onQuery:`), тело метода (имя-агностичный `){` — ловит и многострочные сигнатуры, и computed/unicode-имена), `static {}`, get/set, `@computed`, hooks, `serializeExtras`, `scope(`, `this`/`return`/`new`, `= f(...)` → НЕ skip. FP безопаснее FN (снимается узким env-игнором): лишний тест потребуют TypeORM embedded-классы (без `@Entity` by design) и базы без суффикса `BaseModel`. Известный FN — логика в импортированном хелпере в опциях декоратора (`onQuery: helperFn`); её тестирует парный тест хелпера. Кейс ERP_NEW: 106 чистых моделей без каталожного ignore-глоба.
- **Презентационные SFC** (`isPresentationalSFC` в `checks.js`): `.vue/.svelte/.astro` скипаются, только если в `<script>` (Vue/Svelte) или frontmatter (Astro) НЕТ логики — лишь `import` / `defineProps` / `defineEmits` / типы, либо script вообще отсутствует. Любой сигнал логики (`computed`/`watch`/lifecycle-хук/`function`/control-flow/`await`/`.map().filter()`/Options-`methods`/Svelte `$:`/руны/arrow-функция как значение или коллбэк/тело метода — имя-агностичный `){`, ловит многострочные сигнатуры/`static {}`) → НЕ skip, тест обязателен. Консервативно: типовая аннотация `onClick: () => void` логикой не считается (arrow ловится только в позиции значения `= (..) =>` / коллбэка `f(() =>`). Компромисс — false-positive безопаснее false-negative; чисто-презентационный компонент с тривиальным форматтером может потребовать тест (снимается env-игнором пути). Цель — чтобы Клод не игнорил `**/*.vue` целиком, пряча логику.
- **Не code-файлы для триггера D** (`isCodeFile = false`, никакого парного теста не ищется): стили `.css/.scss/.sass/.less` и разметка `.html/.htm` — визуальная верификация, не unit-тест на сам файл стилей.
- **Вне repoRoot / удалённые** (`existsInsideRepo` в `checks.js`, фильтр `observableSrcEdits`): throwaway-скрипты в `/tmp` и файлы, удалённые в ходе сессии, мехчеки D/E/F/A не триггерят — их больше нет в проекте (dogfooding-кейс v1.9.11). Компромисс «удалить перед Stop» — документированный потолок teeth, как текстовый матч M.
- **Намеренно НЕ skip-ятся** (бывает реальная логика → должен быть тест либо явный per-project ignore): `config/`, `deploy/`, `scripts/`, `commands/` (ace-команды — ERP-кейс `korp_migrate.ts`), `bin/` целиком (кроме трёх Adonis-имён выше), generic ops-имена `run.sh`/`entrypoint.sh`/`healthcheck.sh`. Юзер в своём проекте отключает их через `MAIN_SKILL_VERIFY_IGNORE_GLOBS="**/config/**:**/deploy/**"`.

Принцип: skip-default-ы консервативные (low false-negatives). Project-specific tradeoff делается на уровне проекта env-переменной, не глобальным паттерном.

## Триггер D — import-scan fallback для централизованных спеков

`findTestByImportScan` (`checks.js`): прямой парный не найден → второй шанс — спек центральных тест-дир (`tests|test|spec|specs|__tests__` от package-roots, ближайший пакет первым — сортировка по глубине пути; insertion-order `findPackageRoots` этого НЕ гарантирует), импортирующий источник. Матч по import-строкам (предфильтр `IMPORT_LINE_RE`: import/require/require_relative/from/`mock(`), `buildImportMatchRes`: у файла с содержательным родителем ПУТЁВЫЙ импорт обязан нести родительский сегмент (`billing/db`, `billing.db`, `from app.billing import db`) — одноимённый файл чужого модуля не засчитывается; голый импорт имени (`'db'`, `'#step_up'`) принимается — алиас прячет путь. Закрывает кейс ERP_NEW (`auth_cookies.spec.ts` импортирует `#controllers/auth_controller`) — главный источник каталожных ignore-глобов.

- **Только спек-именованные файлы** (`isTestFile` по basename): хелперы/фикстуры/setup в `tests/` линк не доказывают.
- **Generic-имена** (`index|route|handler|main|mod`) матчатся по родителю (`cart`, `cart/index`); родитель тоже generic (`src/index.ts`) → скан не применяется, иначе массовый FP на любом `../index`.
- **Порядок чтения — по релевантности, не по алфавиту** (`rankSpecCandidates`): имя источника в basename спека +4 (для generic — имя родителя), родительский сегмент в пути +2, токен basename +1; гейт длины ≥3 (короткое `db` ⊂ `redblue` — шум), tie → алфавит. Ошибка скоринга меняет лишь порядок чтения, не результат; покрытый файл находится за единицы чтений — кэп перестаёт отрезать алфавитно-хвостовые спеки (кейс баг-репорта: пакет >200 спеков).
- **Капы/hardening**: бюджет чтений на прогон — `importScanMaxFiles()`: дефолт 200, env-ручка `MAIN_SKILL_IMPORT_SCAN_MAX_FILES` (мусор/≤0 → дефолт, кап 10000), кап списка кандидатов масштабируется `max(400, бюджет)`; кеш между файлами одного Stop (один скан), ≤20k readdir-entries walk-а, depth ≤8, `readRepoFileSafe` (confinement+200KB), симлинки не следуются, basename/parent эскейпятся И капятся по длине — в `rankSpecCandidates` тоже, ≤200 (фейковый file_path на десятки KB из транскрипта ронял бы `new RegExp` «too large» → fail-open всего Stop-хука; мегабайтный сегмент не гоняется по скорингу), любой exception → `null` (fail toward требования), все квантификаторы bounded (ReDoS/I-O-DoS-грабли из секций M/Hardening).
- **Обрыв не тихий**: `cache.lastTruncated` (валиден при null) = бюджет чтений выбран ИЛИ обрезан список кандидатов (`collectCentralSpecFiles` → `{files, truncated}`; ревью-регресс: при env-cap ≥ 400 maxList == бюджету и цикл чтения обрыва не видит). verify-changes собирает `truncatedScans` → reasonD: ⚠-блок «покрытие НЕ подтверждено» + grep-рецепт + ручка лимита. Рецепт — `grep -rlF` + allowlist `[A-Za-z0-9._-]` на недоверенный basename (`bil$(id)ling.ts` пронёс бы `$(id)` в шелл; sanitize стрипует только controls/BiDi). D всё равно срабатывает — fail toward требования.
- **FP осознанно приемлем** (спек импортирует, но не ассертит) — лучше, чем толкать к широким глобам; FN (functional-спек чистого HTTP-flow без импортов) деградирует в честный D → `VERIFY_CHANGES=0` остаётся последним средством и упоминается в reasonD только для этого случая.
- **Known gaps**: файл в `__tests__/` БЕЗ спек-суффикса (`__tests__/checkout.ts`, Jest-дефолтный testMatch) не читается — спека задачи фиксирует «только `*.spec.*`/`*.test.*`», расширение впустило бы helpers в доказательство линка; алиас с ДРУГИМ родительским сегментом (`'#models/db'` → `app/auth/db.ts`) — FN, деградирует в честный D; импорт одноимённого npm-пакета (`require('billing')`) — FP класса «импортирует, но не ассертит».

Правка `findTestByImportScan` / `buildImportMatchRes` / `rankSpecCandidates` / `importScanMaxFiles` / walk-а → синхронизируй `checks.test.js`, `verify-changes.test.js`, `reasonD`, reason-тексты `ignore-glob-guard.js` / `audit-ignore-globs.js` / `check-ignore-globs.md`, `stop-triggers.md`, README (env-ручка) и эту секцию.

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

## Триггер E — endpoint-тест только для критичных роутов

E требует endpoint-level тест (`findE2eFile`: functional/integration/e2e-диры; ищет по обоим именам — ресурсному `auth` и полному `auth_controller`) только для endpoint'ов, критичных по ЛЮБОМУ из двух сигналов (`checks.js`):

- **путь** — `isCriticalEndpoint`: substring-матч доступ/деньги (`auth|login|session|payment|checkout|admin|transfer|…`; короткие токены `acl|sso|otp|2fa|mfa` — с границами, иначе `oracle` ловился бы на `acl`). Generic-маркеры security-кода (`api|sql|crypto|hash`) намеренно исключены — иначе каждый `app/api/**`-роут считался бы критичным;
- **контент** — `hasMutatingHandler`: мутирующие сигнатуры в теле файла (Next.js `export function POST/PUT/PATCH/DELETE`, `router.post('/x')`, NestJS `@Post(`, Rails `def destroy`, Laravel/Adonis `store/update/destroy`) — закрывает CAVEAT бэклога «неназванные мутации минуют E» (`users_controller.destroy`); комментарии предварительно стрипнуты.

Рядовой read-only controller/route покрывается триггером D (парный тест любого слоя): e2e-форс на каждый роут = e2e-пролиферация → получасовые прогоны. False positive (лишний endpoint-тест на `authors_controller`) безвреден; false negative (мутация в непокрытой сигнатурами конвенции) деградирует до D-парного теста — который может быть unit-ом; это осознанный остаток дыры, сужаемый добавлением сигнатур. reasonE толкает к integration (api-client/supertest) как дефолту, e2e — только для сквозных user-journeys.

## Триггер F — sh-fallback в validateEdgeCases

`validateEdgeCases` (`checks.js`) ищет `test_name` как имя `it/test/describe/context/specify` либо `def/func/fn`; третий fallback — sh-интеграционные тесты: TAP-лейбл `ok - …`/`not ok - …`, строка assert-хелпера (`assert_contains "$out" … "лейбл"` — лейбл живёт кавычным аргументом, литерала `ok - <лейбл>` в файле нет) или комментарий-заголовок блока (`# 7d. …`). Закрывает дог-фудинг-кейс v1.12.0: честно покрытые sh-кейсы выдавливались в фиктивные `N/A`.

- **Гейт — только тест-именованный `*.sh`/`*.bash`** (`isTestFile`: `*.test.sh` / `tests/…`): иначе комментарий в самом правленом продакшн-скрипте «доказывал» бы несуществующий тест (live-exploit из ревью: `hooks/session-start.sh` + его же `# 4. …`-комментарий). Шебанг исключён (`#(?!!)`), `test_name` < 3 символов — отказ (матчится слишком дёшево).
- **Hardening для всех паттернов F** (та же правка): `test_name` капится ≤200 до `new RegExp` (иначе «Regular expression too large» → exception → fail-open всего хука, конвенция `rankSpecCandidates`); чтение `test_file` — через `readRepoFileSafe` (realpath-confinement под repoRoot, обычный файл, ≤200KB — traversal/FIFO/гигант отсекаются); эхо `v.reason` в reason-ах — `sanitize(trunc(…, 300))`.
- **Осознанные потолки**: `not ok - X` доказывает существование теста X (F проверяет существование, не green — как и `it(...)`-паттерн); окно `[^\n]{0,500}` до `test_name` bounded by design; матч — дословная подстрока (перифраз лейбла → честный отказ, декларируй лейбл verbatim).

Правка fallback-паттернов / гейта / капов → синхронизируй `checks.test.js`, `verify-changes.test.js`, `reasonF`, `stop-triggers.md`, SKILL.md §edge-cases и эту секцию.

## Триггер M — render-verify для фронт-правок

Блокирует «готово», если после последней фронт-правки (classify `frontend`, минус тест/док-файлы — иначе правка `Card.test.tsx` после рендера ложно ре-триггерила бы M) нет render-класса прогона. Render-детект — `checks.isRenderVerifyCmd` (headless browser / curl|wget по localhost; НАМЕРЕННО без unit-раннеров — jsdom не рендерит, и без внешнего `https://` — прод-URL не проверяет локальную правку); активный браузер-MCP засчитывается по имени tool_use в `verify-changes.js`. Опт-аут `MAIN_SKILL_VERIFY_RENDER=0`.

- **Exempt** (`isRenderExemptFrontendFile`, fail toward требования — нечитаемый/не-файл/вне repoRoot/>200KB → НЕ exempt): `@generated`-заголовок, type-only `.tsx/.jsx`, token-only stylesheet (`isTokenOnlyCss`: custom-props/SCSS-vars/@import + `@media/@supports`-обёртка и attr-селекторы токен-скоупа). Презентационные SFC и `.html` НЕ exempt — визуал именно там. Чтение файлов — через `readRepoFileSafe` (realpath + confinement под repoRoot, как hardening transcript_path); кандидатов ≤ 50 за проход (I/O-DoS-кап).
- **Стрип комментариев — посимвольный state-machine `stripBlockComments` (O(n))**, не regex: lazy/unrolled `/* */`-regex квадратичен на adversarial-входе из незакрытых `/*` (документированные ReDoS-грабли). Сканер различает `//`-comment и строки `' " \``— иначе `/_`внутри`// paths like /api/_`съедал бы файл до EOF вместе с кодом-дисквалификатором (обход type-only exempt); предварительный стрип также гасит lazy-regex внутри`isTypeOnlyTsFile` для M-пути.
- **Render-детект bounded**: все квантификаторы `isRenderVerifyCmd` ограничены (`{0,300}`), в `isTokenOnlyCss` — гейт длины строки (>500 → не exempt): unbounded-версии квадратичны на adversarial-команде/строке (тот же ReDoS-класс). Vitest Browser Mode (`--browser`) и cypress засчитываются рендером; голый `vitest`/`jest` — нет.
- **Хук видит ФАКТ рендера, не вердикт** «выглядит правильно» — осознанный потолок teeth (как и текстовый матч команд: `echo "curl localhost"` его формально обходит); к layout-oracle (клиппинг/наложение геометрией) толкает reasonM, рецепт в `references/testing-strategy.md`.

Правка `isRenderVerifyCmd` / exempt-логики / reasonM → синхронизируй `checks.test.js`, `verify-changes.test.js`, `stop-triggers.md` и эту секцию.

## Триггер N — премортем-ритуал (+ edge-линза в J)

Блокирует «готово» на нетривиальной правке (порог общий с J: ≥20 **добавленных** нетривиальных observable-строк ИЛИ security-путь) без валидного блока `<premortem>` в ЛЮБОМ assistant-тексте сессии (`findPremortemBlocks`). Блок валиден: все записи валидны И их ≥ `PREMORTEM_MIN_ENTRIES` (3) — частично-мусорный блок не закрывает ритуал. Запись = строка `вход → отказ → решение` (`→`/`->`, ≥3 непустых сегментов; разделитель ТОЛЬКО `\n` — гипотезы-фразы легально содержат `;`). Опт-аут `MAIN_SKILL_VERIFY_PREMORTEM=0` (гасит и edge-требование в J); `MAIN_SKILL_VERIFY_REVIEW=0` N НЕ отключает — развязка задокументирована в reasonN/README (ревью-кейс: юзер со старым REVIEW=0 не должен гадать).

- **Порог — добавленные строки, не весь new_string** (`_countAddedNonTrivialLines` в `checks.js`, backlog #5): multiset-дельта канонических строк `new_string − old_string` для Edit/MultiEdit — широкий контекстный якорь rename/extract счётчик не надувает. Ключ — `_nonTrivialLineKeys`: trim + схлопывание внутреннего whitespace + NFC (реформат выравнивания/CRLF/денормализованный unicode — не «новая» строка); перестановки и re-indent внутри одной пары — не добавление, дописанный дубликат строки — добавление (потому multiset, не Set). LCS отвергнут: O(n·m) на недоверенном транскрипте — DoS Stop-хука; кап 1MB на оба текста, new_string за капом → fallback на полный счёт (иначе усечённая дельта занулила бы логику за границей капа — in-band обход порога). Write — целиком (старого содержимого в tool_use нет). Чистое удаление → 0 — осознанный трейдофф «new минус old»; рискованные удаления компенсируют securityPath и триггеры A/D. Known FN-gaps (все — в сторону молчания зуба, снимаются только ужесточением): `replace_all` считается один раз (множитель сайтов неизвестен без чтения файла); построчно совпадающее тело удалённого блока поглощает строки нового (rename одной из двух похожих функций); перенос блока двумя правками — наоборот FP (дельты пар не видят друг друга, session-level multiset не строим); код, внесённый мимо Edit/Write (Bash heredoc/sed) и эхо-ящийся old_string-ом последующего Edit, абсорбируется (Bash-канал и так вне счётчика by design, аналог «echo curl обходит M»).
- **Анти-generic** — `_hasPremortemSignal`: число (ведущая нумерация `1.`/`2)`/`шаг 3:` стрипуется — иначе пронумерованный generic-список проходил бы) ИЛИ camelCase (`_CAMEL_RE`, общий с `_WEAK_SIGNALS`) / составной snake/UPPER/dotted bounded `{2,60}`×`{1,20}` («e.g.» не сигнал) / `` `литерал` `` / термин механизма отказа (идемпотентн*/ретра*/таймаут/кодировк*/гонк*/… — хвосты словоформ `[\p{L}]`, НЕ `\w`: JS-`\w` без кириллицы, ломал бы матч перед `_NWE`; enum узкий — механизмы, не симптомы). Термины впустили честную чисто-кириллическую гипотезу (ревью-кейс) ценой того, что «сеть упадёт → … → добавить ретраи» тоже проходит — осознанный floor: цель зуба — чтобы ритуал состоялся, качество несут SKILL.md §2 + reasonN.
- **Позиция «до первой правки» механически НЕ форсится**: блокировка не отматывает время; зуб требует ретро-премортем. Один премортем на сессию; примеры блоков в reasonN/premortem.md закомментированы `#` — копипаста не закрывает зуб (в сессиях над САМИМ этим репо валидные блоки из тестов всё равно эхо-ятся в тексты — dogfooding-потолок).
- **DoS-капы** (недоверенный транскрипт): экстракция тегов — линейный `extractTagBlocks` (indexOf; lazy-regex `[\s\S]*?` квадратичен на незакрытых тегах: 30k → 1.5s, замерено) — на него же переведены parseSelfReview/parseReviewTriage/parseEdgeCasesBlock; блоков ≤ 100, тело ≤ 20KB, записей ≤ 100 (сверх — invalid-маркер), сигнал-кап 2048/запись; эхо в reason: ≤ 10 записей × 200 символов (`trunc`) + sanitize.
- **Edge-линза в J**: `reviewWantEdge = premortemEnabled && reviewMode === "both"` (суженные =code/=security не навязывают третью линзу) → обязательна секция `edge:` в `<self-review>`; fake-decl ловится `findReviewAgentCalls().edge` (маркер `premortem`/`премортем` в hay); `parseReviewTriage` принимает source `edge`; wrong-source гейтит и edge (`!reviewWantEdge` → блок): иначе в суженном режиме триаж из одних edge-записей закрывал бы K без записей активной секции.
- **Валидировано на синтетике** (2026-07-16, Telegram 4096 + Stripe webhook): премортем-промпт вытаскивает 4096/parse_mode/retry_after/идемпотентность/zero-decimal на haiku и sonnet; sonnet специфичнее (цитаты доков через WebFetch). На изолированном 50-строчном файле контрольный code-review тоже ловит критикалы — ценность линзы = концентрация без minor-шума и walk-to-docs; в реальных больших диффах ревью 4096 пропускал (триггер-кейс плана).

Правка `extractTagBlocks` / `findPremortemBlocks` / `parsePremortemBlock` / `validatePremortem` / `_hasPremortemSignal` / `_countAddedNonTrivialLines` / `countNonTrivialDiffLines` / капов / reasonN / edge-wiring в J → синхронизируй `checks.test.js`, `verify-changes.test.js`, `stop-triggers.md`, `premortem.md`, SKILL.md §2/§self-review и эту секцию.

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

Плотность — постоянная цель (каждая сессия платит полный размер SKILL.md токенами), но **функционал — инвариант**: жми редактурой/дедупом; в `references/*.md` выноси только условный/по-триггеру контент, оставляя в SKILL.md 1–3-строчную выжимку правила + обязательную ссылку «при X прочитай Y». Не жертвуй правилом ради размера.

Кап **5000 токенов** (≈ 20KB ASCII / ~12KB Cyrillic-heavy) жёсткий только при компакции — после неё Claude Code перезагружает лишь первые 5000 токенов вызванного skill. Основной пользователь до компакции не доходит (пик ~45% окна) → кап — ориентир, не самоцель. 500 строк — мягкая рекомендация Claude Code.
