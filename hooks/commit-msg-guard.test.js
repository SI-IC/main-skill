const test = require("node:test");
const assert = require("node:assert");
const g = require("./commit-msg-guard");

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const ev = (command, env) => g.evaluate(bash(command), { env: env || {} });
const subj = (n, prefix) =>
  (prefix || "feat: ") + "x".repeat(n - (prefix || "feat: ").length);

test("extractCommitHeader: простой -m в двойных кавычках", () => {
  assert.equal(
    g.extractCommitHeader(`git commit -m "feat: добавил гард"`),
    "feat: добавил гард",
  );
});

test("extractCommitHeader: одинарные кавычки и склеенный -m", () => {
  assert.equal(g.extractCommitHeader(`git commit -m'fix: тире'`), "fix: тире");
  assert.equal(
    g.extractCommitHeader(`git commit -m"fix: кавычки"`),
    "fix: кавычки",
  );
});

test("extractCommitHeader: составной короткий флаг -am", () => {
  assert.equal(
    g.extractCommitHeader(`git commit -am "chore: bump"`),
    "chore: bump",
  );
});

test("extractCommitHeader: --message с '=' и без", () => {
  assert.equal(
    g.extractCommitHeader(`git commit --message="docs: readme"`),
    "docs: readme",
  );
  assert.equal(
    g.extractCommitHeader(`git commit --message "docs: readme"`),
    "docs: readme",
  );
});

test("extractCommitHeader: bare-значение без кавычек", () => {
  assert.equal(g.extractCommitHeader(`git commit -m wip`), "wip");
});

test("extractCommitHeader: heredoc-форма Claude Code — берётся тело, не литерал $(cat", () => {
  const cmd = [
    `git commit -m "$(cat <<'EOF'`,
    "feat(guard): заголовок из heredoc",
    "",
    "Тело коммита, которое заведомо длиннее ста символов и не должно попадать в проверку заголовка вообще никак.",
    "",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "EOF",
    `)"`,
  ].join("\n");
  assert.equal(g.extractCommitHeader(cmd), "feat(guard): заголовок из heredoc");
});

test("extractCommitHeader: heredoc без кавычек вокруг метки и с <<-", () => {
  const cmd = `git commit -m "$(cat <<-EOF\n\tfix: отступной heredoc\n\tEOF\n)"`;
  assert.equal(g.extractCommitHeader(cmd), "fix: отступной heredoc");
});

test("extractCommitHeader: второй -m это тело коммита — заголовком не считается", () => {
  const body = "b".repeat(300);
  assert.equal(
    g.extractCommitHeader(`git commit -m "feat: коротко" -m "${body}"`),
    "feat: коротко",
  );
});

test("extractCommitHeader: пустые строки и git-комментарии перед заголовком пропускаются", () => {
  const cmd = `git commit -m "$(cat <<'EOF'\n\n# комментарий git\nfeat: реальный заголовок\nEOF\n)"`;
  assert.equal(g.extractCommitHeader(cmd), "feat: реальный заголовок");
});

test("extractCommitHeader: команда в цепочке через && находится", () => {
  assert.equal(
    g.extractCommitHeader(`git add -A && git commit -m "feat: цепочка"`),
    "feat: цепочка",
  );
});

test("extractCommitHeader: --amend -m читается, --amend --no-edit даёт null", () => {
  assert.equal(
    g.extractCommitHeader(`git commit --amend -m "fix: правка"`),
    "fix: правка",
  );
  assert.equal(g.extractCommitHeader(`git commit --amend --no-edit`), null);
});

test("extractCommitHeader: не git commit — null", () => {
  assert.equal(g.extractCommitHeader(`git log --oneline -m 5`), null);
  assert.equal(g.extractCommitHeader(`npm run commit -- -m "x"`), null);
  assert.equal(g.extractCommitHeader(``), null);
  assert.equal(g.extractCommitHeader(null), null);
});

test("extractCommitHeader: -F/--file не парсится — известный FN, не падение", () => {
  assert.equal(g.extractCommitHeader(`git commit -F /tmp/msg.txt`), null);
});

test("extractCommitHeader: пустое сообщение — null", () => {
  assert.equal(g.extractCommitHeader(`git commit -m ""`), null);
  assert.equal(g.extractCommitHeader(`git commit -m "   "`), null);
});

test("isIgnoredHeader: defaultIgnores commitlint — amend!/fixup!/squash!", () => {
  assert.ok(g.isIgnoredHeader("fixup! " + "x".repeat(200)));
  assert.ok(g.isIgnoredHeader("squash! " + "x".repeat(200)));
  assert.ok(g.isIgnoredHeader("amend! " + "x".repeat(200)));
});

test("isIgnoredHeader: merge / revert / reapply / semver", () => {
  assert.ok(
    g.isIgnoredHeader("Merge branch 'main' into feature/" + "x".repeat(150)),
  );
  assert.ok(
    g.isIgnoredHeader("Merge pull request #12 from org/" + "x".repeat(150)),
  );
  assert.ok(
    g.isIgnoredHeader("Merge remote-tracking branch " + "x".repeat(150)),
  );
  assert.ok(g.isIgnoredHeader("Revert " + "x".repeat(200)));
  assert.ok(g.isIgnoredHeader("Reapply " + "x".repeat(200)));
  assert.ok(g.isIgnoredHeader("Automatic merge " + "x".repeat(200)));
  assert.ok(g.isIgnoredHeader("v1.2.3"));
});

test("isIgnoredHeader: обычный conventional-заголовок не игнорируется", () => {
  assert.ok(!g.isIgnoredHeader("feat(auth): добавил гард"));
  assert.ok(!g.isIgnoredHeader("fixup: это не autosquash-префикс"));
});

test("evaluate: заголовок ровно на лимите проходит, +1 символ блокируется", () => {
  assert.equal(ev(`git commit -m "${subj(100)}"`), null);
  const out = ev(`git commit -m "${subj(101)}"`);
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /101/);
  assert.match(out.reason, /100/);
});

test("evaluate: длина считается в UTF-16 code units как в commitlint", () => {
  const head = "feat: " + "x".repeat(93) + "🚀";
  assert.equal([...head].length, 100);
  assert.equal(head.length, 101);
  const out = ev(`git commit -m "${head}"`);
  assert.equal(out.decision, "deny");
});

test("evaluate: длинное тело при коротком заголовке не блокирует", () => {
  const cmd = `git commit -m "$(cat <<'EOF'\nfeat: коротко\n\n${"b".repeat(400)}\nEOF\n)"`;
  assert.equal(ev(cmd), null);
});

test("evaluate: ignored-префикс не блокируется даже при 200 символах", () => {
  assert.equal(ev(`git commit -m "fixup! ${"x".repeat(200)}"`), null);
});

test("evaluate: reason называет фактическую длину, лимит и опт-аут", () => {
  const out = ev(`git commit -m "${subj(140)}"`);
  assert.match(out.reason, /commit-msg-guard/);
  assert.match(out.reason, /140/);
  assert.match(out.reason, /MAIN_SKILL_COMMIT_CHECK=0/);
});

test("evaluate: MAIN_SKILL_COMMIT_CHECK=0 отключает гард", () => {
  assert.equal(
    ev(`git commit -m "${subj(200)}"`, { MAIN_SKILL_COMMIT_CHECK: "0" }),
    null,
  );
});

test("evaluate: MAIN_SKILL_COMMIT_HEADER_MAX задаёт свой лимит", () => {
  const env = { MAIN_SKILL_COMMIT_HEADER_MAX: "72" };
  assert.equal(ev(`git commit -m "${subj(72)}"`, env), null);
  assert.equal(ev(`git commit -m "${subj(73)}"`, env).decision, "deny");
});

test("evaluate: мусорный MAIN_SKILL_COMMIT_HEADER_MAX откатывается на дефолт 100", () => {
  for (const raw of ["0", "-5", "abc", "", "99999"]) {
    const env = { MAIN_SKILL_COMMIT_HEADER_MAX: raw };
    assert.equal(ev(`git commit -m "${subj(100)}"`, env), null, raw);
    assert.equal(ev(`git commit -m "${subj(101)}"`, env).decision, "deny", raw);
  }
});

test("evaluate: сентинел per-session disable глушит гард", () => {
  assert.equal(
    ev(`git commit -m "${subj(200)}"`, { MAIN_SKILL_OFF: "1" }),
    null,
  );
});

test("evaluate: не-Bash инструмент и мусорный payload — no-op", () => {
  assert.equal(
    g.evaluate(
      { tool_name: "Edit", tool_input: { new_string: "x" } },
      { env: {} },
    ),
    null,
  );
  assert.equal(
    g.evaluate({ tool_name: "Bash", tool_input: {} }, { env: {} }),
    null,
  );
  assert.equal(g.evaluate(null, { env: {} }), null);
  assert.equal(
    g.evaluate({ tool_name: "Bash", tool_input: { command: 42 } }, { env: {} }),
    null,
  );
});

test("sanitize: управляющие и BiDi-символы не эхо-ятся в reason", () => {
  const out = ev(`git commit -m "feat: [2K‮supersneaky${"x".repeat(120)}"`);
  assert.ok(!out.reason.includes(""));
  assert.ok(!out.reason.includes("‮"));
});

test("main: печатает PreToolUse-deny в stdout", () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => (chunks.push(s), true);
  try {
    g.main(bash(`git commit -m "${subj(150)}"`));
  } finally {
    process.stdout.write = orig;
  }
  const out = JSON.parse(chunks.join(""));
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /150/);
});

test("extractCommitHeader: глобальные опции git с отдельным аргументом (-c / -C)", () => {
  assert.equal(
    g.extractCommitHeader(`git -c user.name=bot commit -m "feat: бот-коммит"`),
    "feat: бот-коммит",
  );
  assert.equal(
    g.extractCommitHeader(`git -C /workspace commit -m "feat: из каталога"`),
    "feat: из каталога",
  );
  assert.equal(
    g.extractCommitHeader(`git --no-pager commit -m "feat: без пейджера"`),
    "feat: без пейджера",
  );
});

test("extractCommitHeader: чужая подкоманда после git не притягивает commit", () => {
  assert.equal(
    g.extractCommitHeader(`git status && npm run commit -- -m "x"`),
    null,
  );
  assert.equal(g.extractCommitHeader(`git status; yarn commit -m "x"`), null);
});

test("extractCommitHeader: -m следующей команды в цепочке не считается заголовком", () => {
  const cmd = `git commit -F msg.txt && npm run notify -- -m "${"x".repeat(200)}"`;
  assert.equal(g.extractCommitHeader(cmd), null);
});

test("extractCommitHeader: пример коммита внутри heredoc-тела не считается вызовом", () => {
  const cmd = [
    `cat > docs/CONTRIBUTING.md <<'EOF'`,
    "## Как коммитить",
    `Пример: git commit -m "feat(scope): ${"x".repeat(120)}"`,
    "EOF",
  ].join("\n");
  assert.equal(g.extractCommitHeader(cmd), null);
});

test("extractCommitHeader: кавычки внутри heredoc-тела не обрывают заголовок", () => {
  const header = `feat: переименовал "foo" в "bar" ${"x".repeat(80)}`;
  const cmd = `git commit -m "$(cat <<'EOF'\n${header}\n\nТело.\nEOF\n)"`;
  assert.equal(g.extractCommitHeader(cmd), header);
});

test("extractCommitHeader: ANSI-C quoting -m$'…' читается целиком", () => {
  const header = "feat: " + "x".repeat(120);
  assert.equal(g.extractCommitHeader(`git commit -m$'${header}'`), header);
});

test("extractCommitHeader: значение целиком из переменной не разрешается — null", () => {
  assert.equal(g.extractCommitHeader(`git commit -m "$MSG"`), null);
  assert.equal(g.extractCommitHeader(`git commit -m "\${MSG}"`), null);
  assert.equal(
    g.extractCommitHeader(`git commit -m "$MSG suffix"`),
    "$MSG suffix",
  );
});

test("extractCommitHeader: обратный слэш сохраняется как в bash — длина не занижается", () => {
  assert.equal(
    g.extractCommitHeader(`git commit -m "fix: путь C:\\temp\\file"`),
    "fix: путь C:\\temp\\file",
  );
  assert.equal(
    g.extractCommitHeader(`git commit -m "fix: кавычка \\" внутри"`),
    `fix: кавычка " внутри`,
  );
});

test("extractCommitHeader: heredoc-метка аномальной длины не роняет модуль", () => {
  const label = "E".repeat(40000);
  const cmd = `git commit -m "$(cat <<'${label}'\nfeat: длинная метка\n${label}\n)"`;
  assert.doesNotThrow(() => g.extractCommitHeader(cmd));
});

test("isIgnoredHeader: merge tag / Merged PR / Auto-merged покрыты", () => {
  assert.ok(
    g.isIgnoredHeader("Merge tag 'v2.0.0' into main " + "x".repeat(120)),
  );
  assert.ok(g.isIgnoredHeader("Merged PR 4321: " + "x".repeat(150)));
  assert.ok(g.isIgnoredHeader("Merged release into main " + "x".repeat(120)));
  assert.ok(
    g.isIgnoredHeader("Auto-merged hotfix into develop " + "x".repeat(120)),
  );
});

test("isIgnoredHeader: semver с pre-release и build-метаданными", () => {
  assert.ok(g.isIgnoredHeader("v1.2.3-alpha.1"));
  assert.ok(g.isIgnoredHeader("1.2.3-rc-2"));
  assert.ok(g.isIgnoredHeader("v1.2.3+build.7"));
});

test("isIgnoredHeader: semver-подобный вход с дефисами не уходит в бэктрекинг", () => {
  const header = "v1.0.0" + "-a".repeat(60) + "!";
  const started = process.hrtime.bigint();
  g.isIgnoredHeader(header);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(
    ms < 500,
    `isIgnoredHeader занял ${ms} мс — катастрофический бэктрекинг`,
  );
});

test("extractCommitHeader: длинная цепочка флагов не уходит в бэктрекинг", () => {
  const started = process.hrtime.bigint();
  assert.equal(
    g.extractCommitHeader("git " + "-c k=v ".repeat(3000) + "x"),
    null,
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 500, `extractCommitHeader занял ${ms} мс на цепочке флагов`);
});

test("evaluate: заголовок в пределах лимита не доходит до ignore-регулярок", () => {
  const header = "v1.0.0" + "-a".repeat(30) + "!";
  assert.ok(header.length < 100);
  const started = process.hrtime.bigint();
  assert.equal(ev(`git commit -m "${header}"`), null);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 500, `evaluate занял ${ms} мс на входе короче лимита`);
});

test("main: короткий заголовок ничего не печатает", () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => (chunks.push(s), true);
  try {
    g.main(bash(`git commit -m "feat: ок"`));
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(chunks.length, 0);
});
