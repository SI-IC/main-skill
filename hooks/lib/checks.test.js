// Unit-tests для lib/checks.js. Запуск: node --test hooks/lib/checks.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const checks = require("./checks");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msc-"));
}
function writeFile(dir, rel, body) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

test("isTestFile распознаёт стандартные конвенции", () => {
  assert.ok(checks.isTestFile("src/foo.test.ts"));
  assert.ok(checks.isTestFile("src/foo.spec.js"));
  assert.ok(checks.isTestFile("src/__tests__/foo.ts"));
  assert.ok(checks.isTestFile("tests/unit/foo.ts"));
  assert.ok(checks.isTestFile("tests/test_foo.py"));
  assert.ok(checks.isTestFile("foo_test.go"));
  assert.ok(checks.isTestFile("e2e/login.e2e.ts"));
  assert.ok(!checks.isTestFile("src/foo.ts"));
  assert.ok(!checks.isTestFile("src/controllers/auth.ts"));
});

test("isCodeFile отсеивает конфиги/ассеты/стили", () => {
  assert.ok(checks.isCodeFile("src/foo.ts"));
  assert.ok(checks.isCodeFile("main.py"));
  assert.ok(checks.isCodeFile("cli.go"));
  assert.ok(checks.isCodeFile("scripts/deploy.sh"));
  assert.ok(!checks.isCodeFile("plugin.json"));
  assert.ok(!checks.isCodeFile("config.yaml"));
  assert.ok(!checks.isCodeFile("Dockerfile"));
  assert.ok(!checks.isCodeFile("logo.png"));
  // Стили / разметка — не code-файлы для триггера D (визуальная верификация,
  // не unit-тест на сам файл стиля).
  assert.ok(!checks.isCodeFile("app/styles.css"));
  assert.ok(!checks.isCodeFile("src/theme.scss"));
  assert.ok(!checks.isCodeFile("src/legacy.sass"));
  assert.ok(!checks.isCodeFile("src/vars.less"));
  assert.ok(!checks.isCodeFile("public/index.html"));
  assert.ok(!checks.isCodeFile("public/legacy.htm"));
});

test("isControllerOrRoute распознаёт endpoints", () => {
  assert.ok(checks.isControllerOrRoute("app/controllers/auth_controller.ts"));
  assert.ok(checks.isControllerOrRoute("src/routes/users.ts"));
  assert.ok(checks.isControllerOrRoute("app/api/auth/route.ts"));
  assert.ok(checks.isControllerOrRoute("pages/api/login.ts"));
  assert.ok(checks.isControllerOrRoute("src/UserController.ts"));
  assert.ok(!checks.isControllerOrRoute("src/services/auth.ts"));
  assert.ok(
    !checks.isControllerOrRoute("src/controllers/auth_controller.test.ts"),
  );
});

test("isCriticalEndpoint: доступ/деньги критичны, рядовые CRUD — нет", () => {
  // критичные: auth / доступ
  assert.ok(checks.isCriticalEndpoint("app/controllers/auth_controller.ts"));
  assert.ok(checks.isCriticalEndpoint("pages/api/login.ts"));
  assert.ok(checks.isCriticalEndpoint("src/routes/admin.ts"));
  assert.ok(checks.isCriticalEndpoint("app/api/session/route.ts"));
  // критичные: деньги
  assert.ok(checks.isCriticalEndpoint("app/api/checkout/route.ts"));
  assert.ok(
    checks.isCriticalEndpoint("app/controllers/payments_controller.rb"),
  );
  assert.ok(checks.isCriticalEndpoint("src/routes/transfer.ts"));
  // рядовые — не критичны (покрываются триггером D)
  assert.ok(!checks.isCriticalEndpoint("app/controllers/posts_controller.ts"));
  assert.ok(!checks.isCriticalEndpoint("app/api/articles/route.ts"));
  assert.ok(!checks.isCriticalEndpoint("src/routes/health.ts"));
  // generic `api` в пути сам по себе критичности не даёт
  assert.ok(!checks.isCriticalEndpoint("app/api/comments/route.ts"));
  // короткие токены (acl/sso/...) — с границами: substring внутри слова не матчит
  assert.ok(!checks.isCriticalEndpoint("app/controllers/oracle_controller.ts"));
  assert.ok(
    !checks.isCriticalEndpoint("app/controllers/associate_controller.ts"),
  );
  assert.ok(checks.isCriticalEndpoint("src/routes/sso.ts"));
  assert.ok(checks.isCriticalEndpoint("app/controllers/acl_controller.ts"));
  // пустое / null — не критичны (fail-soft)
  assert.ok(!checks.isCriticalEndpoint(""));
  assert.ok(!checks.isCriticalEndpoint(null));
});

test("isPublicSurface — manifest, SKILL.md, CLI", () => {
  assert.ok(checks.isPublicSurface(".claude-plugin/plugin.json"));
  assert.ok(checks.isPublicSurface("skills/foo/SKILL.md"));
  assert.ok(checks.isPublicSurface("bin/cli.js"));
  assert.ok(!checks.isPublicSurface("src/internal/util.ts"));
});

test("findPairedTestFile находит парный тест на диске", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "export const x = 1;");
  writeFile(dir, "src/foo.test.ts", 'test("x", () => {})');
  const found = checks.findPairedTestFile("src/foo.ts", dir);
  assert.strictEqual(found, path.join("src", "foo.test.ts"));
});

test("findPairedTestFile возвращает null если нет", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  assert.strictEqual(checks.findPairedTestFile("src/foo.ts", dir), null);
});

test("findPairedTestFile считает session-edit как валидный парный", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  const sessionFiles = new Set([path.join(dir, "src/foo.test.ts")]);
  const found = checks.findPairedTestFile("src/foo.ts", dir, sessionFiles);
  assert.ok(found);
});

test("findPairedTestFile: .vue ↔ .spec.ts (Vue + Vitest)", () => {
  const dir = tmp();
  writeFile(dir, "frontend/src/App.vue", "<template/>");
  writeFile(dir, "frontend/src/App.spec.ts", 'test("x", () => {})');
  const found = checks.findPairedTestFile("frontend/src/App.vue", dir);
  assert.strictEqual(found, path.join("frontend", "src", "App.spec.ts"));
});

test("findPairedTestFile: .vue ↔ .test.ts", () => {
  const dir = tmp();
  writeFile(dir, "src/App.vue", "x");
  writeFile(dir, "src/App.test.ts", "x");
  const found = checks.findPairedTestFile("src/App.vue", dir);
  assert.strictEqual(found, path.join("src", "App.test.ts"));
});

test("findPairedTestFile: .vue ↔ .spec.js", () => {
  const dir = tmp();
  writeFile(dir, "src/App.vue", "x");
  writeFile(dir, "src/App.spec.js", "x");
  const found = checks.findPairedTestFile("src/App.vue", dir);
  assert.strictEqual(found, path.join("src", "App.spec.js"));
});

test("findPairedTestFile: .svelte ↔ .spec.ts", () => {
  const dir = tmp();
  writeFile(dir, "src/Button.svelte", "x");
  writeFile(dir, "src/Button.spec.ts", "x");
  const found = checks.findPairedTestFile("src/Button.svelte", dir);
  assert.strictEqual(found, path.join("src", "Button.spec.ts"));
});

test("findPairedTestFile: .svelte ↔ .svelte.test.ts (vitest-plugin-svelte)", () => {
  const dir = tmp();
  writeFile(dir, "src/Card.svelte", "x");
  writeFile(dir, "src/Card.svelte.test.ts", "x");
  const found = checks.findPairedTestFile("src/Card.svelte", dir);
  assert.strictEqual(found, path.join("src", "Card.svelte.test.ts"));
});

test("findPairedTestFile: .vue ↔ __tests__/App.ts", () => {
  const dir = tmp();
  writeFile(dir, "src/App.vue", "x");
  writeFile(dir, "src/__tests__/App.ts", "x");
  const found = checks.findPairedTestFile("src/App.vue", dir);
  assert.ok(found, `expected paired test, got ${found}`);
  assert.match(found, /__tests__/);
});

test("findPairedTestFile: .vue ↔ tests/unit/App.spec.ts", () => {
  const dir = tmp();
  writeFile(dir, "src/App.vue", "x");
  writeFile(dir, "tests/unit/App.spec.ts", "x");
  const found = checks.findPairedTestFile("src/App.vue", dir);
  assert.ok(found);
  assert.match(found, /tests[\\/]unit[\\/]App\.spec\.ts/);
});

test("findPairedTestFile: .tsx ↔ .test.ts (логика без JSX в тесте)", () => {
  const dir = tmp();
  writeFile(dir, "src/Button.tsx", "x");
  writeFile(dir, "src/Button.test.ts", "x");
  const found = checks.findPairedTestFile("src/Button.tsx", dir);
  assert.strictEqual(found, path.join("src", "Button.test.ts"));
});

test("findPairedTestFile: .vue без парного теста → null", () => {
  const dir = tmp();
  writeFile(dir, "src/App.vue", "x");
  // Голый src/App.ts рядом — это не тест (helper-файл), не должен матчиться.
  writeFile(dir, "src/App.ts", "x");
  assert.strictEqual(checks.findPairedTestFile("src/App.vue", dir), null);
});

test("findPairedTestFile: .vue session-edit App.spec.ts валидный парный", () => {
  const dir = tmp();
  writeFile(dir, "src/App.vue", "x");
  const sessionFiles = new Set([path.join(dir, "src/App.spec.ts")]);
  const found = checks.findPairedTestFile("src/App.vue", dir, sessionFiles);
  assert.ok(found);
});

test("findPairedTestFile: pnpm workspace — backend/tests/unit/foo.spec.ts от repoRoot", () => {
  const dir = tmp();
  // monorepo структура
  writeFile(
    dir,
    "package.json",
    '{"name":"root","workspaces":["backend","frontend"]}',
  );
  writeFile(dir, "backend/package.json", '{"name":"backend"}');
  writeFile(dir, "backend/app/services/audit_log_service.ts", "export {}");
  writeFile(
    dir,
    "backend/tests/unit/audit_log_service.spec.ts",
    'test("x", () => {})',
  );
  const found = checks.findPairedTestFile(
    "backend/app/services/audit_log_service.ts",
    dir,
  );
  assert.ok(found, `expected paired test in workspace, got ${found}`);
  assert.match(
    found,
    /backend[\\/]tests[\\/]unit[\\/]audit_log_service\.spec\.ts/,
  );
});

test("findPairedTestFile: pnpm workspace — абсолютный srcPath", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "backend/package.json", "{}");
  writeFile(dir, "backend/app/middleware/session_version_middleware.ts", "x");
  writeFile(dir, "backend/tests/unit/session_version_middleware.spec.ts", "x");
  const abs = path.join(
    dir,
    "backend/app/middleware/session_version_middleware.ts",
  );
  const found = checks.findPairedTestFile(abs, dir);
  assert.ok(found, `expected paired test for absolute srcPath, got ${found}`);
  assert.match(
    found,
    /tests[\\/]unit[\\/]session_version_middleware\.spec\.ts/,
  );
});

test("findPairedTestFile: Vue компонент в frontend workspace ↔ frontend/tests/unit/App.spec.ts", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "frontend/package.json", "{}");
  writeFile(dir, "frontend/src/views/DashboardView.vue", "<template/>");
  writeFile(
    dir,
    "frontend/tests/unit/DashboardView.spec.ts",
    'test("x", () => {})',
  );
  const found = checks.findPairedTestFile(
    "frontend/src/views/DashboardView.vue",
    dir,
  );
  assert.ok(found, `expected paired test for .vue in workspace, got ${found}`);
  assert.match(
    found,
    /frontend[\\/]tests[\\/]unit[\\/]DashboardView\.spec\.ts/,
  );
});

test("findPairedTestFile: Python monorepo — pyproject.toml + pkg/tests/test_foo.py", () => {
  const dir = tmp();
  writeFile(dir, "pyproject.toml", '[project]\nname="root"');
  writeFile(dir, "pkg/pyproject.toml", '[project]\nname="pkg"');
  writeFile(dir, "pkg/src/foo.py", "x = 1");
  writeFile(dir, "pkg/tests/test_foo.py", "def test_x(): pass");
  const found = checks.findPairedTestFile("pkg/src/foo.py", dir);
  assert.ok(found, `expected paired Python test in package, got ${found}`);
  assert.match(found, /pkg[\\/]tests[\\/]test_foo\.py/);
});

test("findPairedTestFile: Cargo workspace — crate/tests/foo.rs не подходит, but src/foo.rs c #[test] не паттерн → null", () => {
  // Sanity-check: Rust не имеет конвенции «<base>_test.rs» рядом, кладём фолбек на module-test → null.
  const dir = tmp();
  writeFile(dir, "Cargo.toml", '[workspace]\nmembers=["crate"]');
  writeFile(dir, "crate/Cargo.toml", '[package]\nname="crate"');
  writeFile(dir, "crate/src/foo.rs", "pub fn foo(){}");
  // Никакого парного файла не пишем
  assert.strictEqual(checks.findPairedTestFile("crate/src/foo.rs", dir), null);
});

test("findPairedTestFile: nested go module — module/tests/unit/foo.go не нужен, foo_test.go рядом", () => {
  const dir = tmp();
  writeFile(dir, "go.mod", "module root");
  writeFile(dir, "svc/go.mod", "module svc");
  writeFile(dir, "svc/internal/foo.go", "package foo");
  writeFile(dir, "svc/internal/foo_test.go", "package foo");
  const found = checks.findPairedTestFile("svc/internal/foo.go", dir);
  assert.ok(found);
  assert.match(found, /svc[\\/]internal[\\/]foo_test\.go/);
});

// ─── Mirror src↔test/tests/__tests__/spec на любой глубине ─────────────────

test("findPairedTestFile: mirror src/.../foo.ts ↔ tests/.../foo.spec.ts", () => {
  const dir = tmp();
  writeFile(dir, "src/services/auth/login.ts", "x");
  writeFile(dir, "tests/services/auth/login.spec.ts", "x");
  const found = checks.findPairedTestFile("src/services/auth/login.ts", dir);
  assert.ok(found, `mirror tests/ should match, got ${found}`);
  assert.match(found, /tests[\\/]services[\\/]auth[\\/]login\.spec\.ts/);
});

test("findPairedTestFile: mirror src/.../foo.ts ↔ __tests__/.../foo.test.ts", () => {
  const dir = tmp();
  writeFile(dir, "src/api/client.ts", "x");
  writeFile(dir, "src/__tests__/api/client.test.ts", "x");
  const found = checks.findPairedTestFile("src/api/client.ts", dir);
  assert.ok(found, `mirror __tests__ should match, got ${found}`);
  assert.match(found, /__tests__[\\/]api[\\/]client\.test\.ts/);
});

test("findPairedTestFile: same-dir tests/ подкаталог — src/decrypt.ts ↔ src/tests/decrypt.test.ts (node:test-конвенция, кейс conveyor)", () => {
  const dir = tmp();
  writeFile(dir, "packages/proxy/package.json", "{}");
  writeFile(dir, "packages/proxy/src/decrypt.ts", "export const x = 1;");
  writeFile(
    dir,
    "packages/proxy/src/tests/decrypt.test.ts",
    "import '../decrypt.js'",
  );
  const found = checks.findPairedTestFile("packages/proxy/src/decrypt.ts", dir);
  assert.ok(found, `same-dir tests/ should match, got ${found}`);
  assert.match(found, /src[\\/]tests[\\/]decrypt\.test\.ts/);
});

test("findPairedTestFile: same-dir test/ (singular) — lib/parse.ts ↔ lib/test/parse.spec.ts", () => {
  const dir = tmp();
  writeFile(dir, "lib/parse.ts", "x");
  writeFile(dir, "lib/test/parse.spec.ts", "x");
  const found = checks.findPairedTestFile("lib/parse.ts", dir);
  assert.ok(found, `same-dir test/ should match, got ${found}`);
  assert.match(found, /lib[\\/]test[\\/]parse\.spec\.ts/);
});

test("findPairedTestFile: same-dir tests/ — файл БЕЗ test/spec-суффикса (хелпер) линк не доказывает", () => {
  const dir = tmp();
  writeFile(dir, "src/decrypt.ts", "x");
  writeFile(dir, "src/tests/decrypt.ts", "helper copy, not a test");
  const found = checks.findPairedTestFile("src/decrypt.ts", dir);
  assert.equal(
    found,
    null,
    `suffix-less file in tests/ must NOT count, got ${found}`,
  );
});

test("findPairedTestFile: same-dir tests/ — чужое имя не матчится", () => {
  const dir = tmp();
  writeFile(dir, "src/decrypt.ts", "x");
  writeFile(dir, "src/tests/other.test.ts", "x");
  const found = checks.findPairedTestFile("src/decrypt.ts", dir);
  assert.equal(found, null, `foreign spec name must NOT count, got ${found}`);
});

test("findPairedTestFile: mirror app/models/user.rb ↔ spec/models/user_spec.rb (RSpec)", () => {
  const dir = tmp();
  writeFile(dir, "Gemfile", "");
  writeFile(dir, "app/models/user.rb", "class User; end");
  writeFile(dir, "spec/models/user_spec.rb", "describe User do; end");
  const found = checks.findPairedTestFile("app/models/user.rb", dir);
  assert.ok(found, `Ruby RSpec mirror should match, got ${found}`);
  assert.match(found, /spec[\\/]models[\\/]user_spec\.rb/);
});

test("findPairedTestFile: mirror app/models/user.rb ↔ test/models/user_test.rb (Minitest)", () => {
  const dir = tmp();
  writeFile(dir, "Gemfile", "");
  writeFile(dir, "app/models/user.rb", "x");
  writeFile(dir, "test/models/user_test.rb", "x");
  const found = checks.findPairedTestFile("app/models/user.rb", dir);
  assert.ok(found);
  assert.match(found, /test[\\/]models[\\/]user_test\.rb/);
});

test("findPairedTestFile: PHP src/User.php ↔ tests/Unit/UserTest.php", () => {
  const dir = tmp();
  writeFile(dir, "composer.json", "{}");
  writeFile(dir, "src/Models/User.php", "<?php class User {}");
  writeFile(dir, "tests/Unit/Models/UserTest.php", "<?php class UserTest {}");
  const found = checks.findPairedTestFile("src/Models/User.php", dir);
  assert.ok(found, `PHP PHPUnit Unit mirror should match, got ${found}`);
  assert.match(found, /tests[\\/]Unit[\\/]Models[\\/]UserTest\.php/);
});

test("findPairedTestFile: PHP src/User.php ↔ tests/Feature/UserTest.php", () => {
  const dir = tmp();
  writeFile(dir, "composer.json", "{}");
  writeFile(dir, "src/Models/User.php", "x");
  writeFile(dir, "tests/Feature/Models/UserTest.php", "x");
  const found = checks.findPairedTestFile("src/Models/User.php", dir);
  assert.ok(found);
  assert.match(found, /tests[\\/]Feature[\\/]Models[\\/]UserTest\.php/);
});

test("findPairedTestFile: Java Maven src/main/java/com/X.java ↔ src/test/java/com/XTest.java", () => {
  const dir = tmp();
  writeFile(dir, "pom.xml", "<project/>");
  writeFile(dir, "src/main/java/com/foo/Bar.java", "class Bar{}");
  writeFile(dir, "src/test/java/com/foo/BarTest.java", "class BarTest{}");
  const found = checks.findPairedTestFile(
    "src/main/java/com/foo/Bar.java",
    dir,
  );
  assert.ok(found, `Maven src/main↔src/test mirror should match, got ${found}`);
  assert.match(
    found,
    /src[\\/]test[\\/]java[\\/]com[\\/]foo[\\/]BarTest\.java/,
  );
});

test("findPairedTestFile: Kotlin Gradle src/main/kotlin/X.kt ↔ src/test/kotlin/XTest.kt", () => {
  const dir = tmp();
  writeFile(dir, "build.gradle.kts", "");
  writeFile(dir, "src/main/kotlin/com/foo/Bar.kt", "x");
  writeFile(dir, "src/test/kotlin/com/foo/BarTest.kt", "x");
  const found = checks.findPairedTestFile(
    "src/main/kotlin/com/foo/Bar.kt",
    dir,
  );
  assert.ok(found);
});

test("findPairedTestFile: Swift SPM Sources/Foo/Bar.swift ↔ Tests/FooTests/BarTests.swift", () => {
  const dir = tmp();
  writeFile(dir, "Package.swift", "");
  writeFile(dir, "Sources/Foo/Bar.swift", "x");
  writeFile(dir, "Tests/FooTests/BarTests.swift", "x");
  const found = checks.findPairedTestFile("Sources/Foo/Bar.swift", dir);
  assert.ok(found, `Swift SPM Sources↔Tests mirror should match, got ${found}`);
  assert.match(found, /Tests[\\/]FooTests[\\/]BarTests\.swift/);
});

test("findPairedTestFile: суффикс <Base>Test.ts (Java-style тоже валиден в JS-коде)", () => {
  const dir = tmp();
  writeFile(dir, "src/foo.ts", "x");
  writeFile(dir, "src/fooTest.ts", "x");
  // fooTest.ts ловится через TEST_FILE_RE? нет — там нужен .test/.spec/test_/_test
  // Но как mirror-пара по конвенции <Base>Test — да, должно матчиться.
  const found = checks.findPairedTestFile("src/foo.ts", dir);
  assert.ok(found, `<base>Test convention should match, got ${found}`);
});

test("findPairedTestFile: shell — common.sh ↔ common.test.sh рядом", () => {
  const dir = tmp();
  writeFile(dir, "infra/openvpn/common.sh", "#!/bin/bash");
  writeFile(dir, "infra/openvpn/common.test.sh", "#!/bin/bash");
  const found = checks.findPairedTestFile("infra/openvpn/common.sh", dir);
  assert.ok(found, `shell same-dir .test.sh should match, got ${found}`);
  assert.match(found, /infra[\\/]openvpn[\\/]common\.test\.sh/);
});

test("findPairedTestFile: shell — common.sh ↔ common.spec.sh рядом", () => {
  const dir = tmp();
  writeFile(dir, "scripts/common.sh", "#!/bin/bash");
  writeFile(dir, "scripts/common.spec.sh", "#!/bin/bash");
  const found = checks.findPairedTestFile("scripts/common.sh", dir);
  assert.ok(found, `shell same-dir .spec.sh should match, got ${found}`);
});

test("findPairedTestFile: shell — common.bash ↔ common_test.bash (underscore-вариант)", () => {
  const dir = tmp();
  writeFile(dir, "tools/common.bash", "#!/bin/bash");
  writeFile(dir, "tools/common_test.bash", "#!/bin/bash");
  const found = checks.findPairedTestFile("tools/common.bash", dir);
  assert.ok(found, `shell underscore-test should match, got ${found}`);
});

test("findPairedTestFile: shell session-edit — тест ещё не на диске, но в sessionFiles", () => {
  const dir = tmp();
  writeFile(dir, "install.sh", "#!/bin/bash");
  const sessionFiles = new Set([path.join(dir, "install.test.sh")]);
  const found = checks.findPairedTestFile("install.sh", dir, sessionFiles);
  assert.ok(found, `session-edit shell test should match, got ${found}`);
});

test("findPairedTestFile: shell без парного теста → null", () => {
  const dir = tmp();
  writeFile(dir, "infra/openvpn/install.sh", "#!/bin/bash");
  assert.strictEqual(
    checks.findPairedTestFile("infra/openvpn/install.sh", dir),
    null,
  );
});

test("findPairedTestFile: lua — main.lua ↔ main.test.lua (нестандартное расширение тоже работает)", () => {
  const dir = tmp();
  writeFile(dir, "src/main.lua", "");
  writeFile(dir, "src/main.test.lua", "");
  const found = checks.findPairedTestFile("src/main.lua", dir);
  assert.ok(found, `lua same-dir .test.lua should match, got ${found}`);
});

test("findPairedTestFile: AdonisJS app/services/X.ts ↔ tests/functional/X.spec.ts", () => {
  const dir = tmp();
  writeFile(dir, "app/services/user_backfill.ts", "export class X {}");
  writeFile(
    dir,
    "tests/functional/user_backfill.spec.ts",
    'test("x", () => {})',
  );
  const found = checks.findPairedTestFile("app/services/user_backfill.ts", dir);
  assert.ok(found, `tests/functional spec should match, got ${found}`);
  assert.match(found, /tests\/functional\/user_backfill\.spec\.ts$/);
});

test("findPairedTestFile: app/services/X.ts ↔ tests/integration/X.test.ts", () => {
  const dir = tmp();
  writeFile(dir, "app/services/report.ts", "export class X {}");
  writeFile(dir, "tests/integration/report.test.ts", 'test("x", () => {})');
  const found = checks.findPairedTestFile("app/services/report.ts", dir);
  assert.ok(found, `tests/integration test should match, got ${found}`);
  assert.match(found, /tests\/integration\/report\.test\.ts$/);
});

test("findPairedTestFile: AdonisJS monorepo apps/api/app/services/X.ts ↔ apps/api/tests/functional/X.spec.ts", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "apps/api/package.json", "{}");
  writeFile(dir, "apps/api/app/services/user_backfill.ts", "export class X {}");
  writeFile(
    dir,
    "apps/api/tests/functional/user_backfill.spec.ts",
    'test("x", () => {})',
  );
  const found = checks.findPairedTestFile(
    "apps/api/app/services/user_backfill.ts",
    dir,
  );
  assert.ok(found, `monorepo tests/functional should match, got ${found}`);
  assert.match(found, /apps\/api\/tests\/functional\/user_backfill\.spec\.ts$/);
});

test("findPairedTestFile: app/services/X.ts без теста нигде → null (детект не ослаблен)", () => {
  const dir = tmp();
  writeFile(dir, "app/services/orphan.ts", "export class X {}");
  assert.strictEqual(
    checks.findPairedTestFile("app/services/orphan.ts", dir),
    null,
  );
});

// ─── findReviewAgentCalls ─────────────────────────────────────────────────

function asstTool(name, input) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  };
}

test("findReviewAgentCalls: распознаёт code+security через name=Task", () => {
  const r = checks.findReviewAgentCalls([
    asstTool("Task", {
      subagent_type: "general-purpose",
      prompt: "code review: качество",
    }),
    asstTool("Task", {
      subagent_type: "general-purpose",
      prompt: "security review OWASP injection",
    }),
  ]);
  assert.strictEqual(r.code, true);
  assert.strictEqual(r.security, true);
});

test("findReviewAgentCalls: распознаёт code+security через name=Agent", () => {
  const r = checks.findReviewAgentCalls([
    asstTool("Agent", {
      subagent_type: "general-purpose",
      prompt: "code review: паттерны, дублирование",
    }),
    asstTool("Agent", {
      subagent_type: "general-purpose",
      prompt: "security review per OWASP, auth bypass",
    }),
  ]);
  assert.strictEqual(r.code, true);
  assert.strictEqual(r.security, true);
});

test("findReviewAgentCalls: нерелевантный Agent-вызов без review-маркеров не засчитывается", () => {
  const r = checks.findReviewAgentCalls([
    asstTool("Agent", {
      subagent_type: "Explore",
      prompt: "найди где определён UserService",
    }),
  ]);
  assert.strictEqual(r.code, false);
  assert.strictEqual(r.security, false);
  assert.strictEqual(r.edge, false);
});

test("findReviewAgentCalls: premortem-линза распознаётся (edge) по en/ru маркеру", () => {
  const en = checks.findReviewAgentCalls([
    asstTool("Task", {
      subagent_type: "general-purpose",
      description: "premortem review",
      prompt: "top-5 гипотез, что сломается в проде",
    }),
  ]);
  assert.strictEqual(en.edge, true);
  const ru = checks.findReviewAgentCalls([
    asstTool("Agent", {
      subagent_type: "general-purpose",
      prompt: "премортем: система + ограничение с числом + вход + симптом",
    }),
  ]);
  assert.strictEqual(ru.edge, true);
});

// ─── премортем: parsePremortemBlock / validatePremortem / findPremortemBlocks ─

test("parsePremortemBlock: валидные записи с → и ->", () => {
  const p = checks.parsePremortemBlock(
    "sendMessage: text >4096 → 400 MESSAGE_TOO_LONG → чанковать\n" +
      "raw `*` in name -> 400 cant parse entities -> escape\n" +
      "# коммент пропускается\n",
  );
  assert.strictEqual(p.entries.length, 2);
  assert.ok(p.entries.every((e) => e.valid));
  assert.strictEqual(p.entries[0].segments.length, 3);
});

test("parsePremortemBlock: одна стрелка / пустой сегмент → invalid-запись", () => {
  const p = checks.parsePremortemBlock(
    "лимит 4096 → учесть\n" + "вход → → решение",
  );
  assert.strictEqual(p.entries.length, 2);
  assert.ok(p.entries.every((e) => !e.valid));
});

test("parsePremortemBlock: `;` НЕ разделитель — гипотеза с `;` внутри остаётся одной записью", () => {
  const p = checks.parsePremortemBlock(
    "batch из 50 записей; каждая до 1KB → 413 payload too large → чанковать",
  );
  assert.strictEqual(p.entries.length, 1);
  assert.ok(p.entries[0].valid);
});

test("validatePremortem: generic без числа/идентификатора/термина отсекается", () => {
  const v = checks.validatePremortem(
    checks.parsePremortemBlock(
      "сеть может упасть → запрос не пройдёт → обработать ошибку",
    ),
  );
  assert.strictEqual(v[0].ok, false);
  assert.match(v[0].reason, /generic/);
});

test("validatePremortem: кириллическая гипотеза с термином механизма — сигнал", () => {
  const ok = (s) =>
    checks.validatePremortem(checks.parsePremortemBlock(s))[0].ok;
  // кейс премортем-ревьюера: специфично, но ни латиницы, ни цифр
  assert.ok(
    ok(
      "вебхук приходит повторно при ретрае поставщика → повторная запись начисления → обеспечить идемпотентность по внешнему идентификатору",
    ),
  );
  assert.ok(
    ok("непарные кавычки в имени → отказ разметки → экранировать текст"),
  );
  assert.ok(
    ok("две вкладки шлют одновременно → гонка записи → блокировка строки"),
  );
});

test("validatePremortem: нумерация записи не считается числом-сигналом", () => {
  const v = checks.validatePremortem(
    checks.parsePremortemBlock(
      "1. сеть может упасть → запрос не пройдёт → обработать ошибку\n" +
        "2) что-то пойдёт не так → будет плохо → починим\n" +
        "шаг 3: вход кривой → падение → добавить проверку",
    ),
  );
  assert.ok(v.every((x) => !x.ok));
});

test("parsePremortemBlock: тело > PREMORTEM_MAX_BODY → invalid-маркер без парсинга", () => {
  const p = checks.parsePremortemBlock(
    "a → b → c\n".repeat(Math.ceil(checks.PREMORTEM_MAX_BODY / 10) + 100),
  );
  assert.strictEqual(p.entries.length, 1);
  assert.strictEqual(p.entries[0].valid, false);
  assert.match(p.entries[0].reason, /тело блока/);
});

test("parsePremortemBlock: записей > PREMORTEM_MAX_PARSED → overflow-маркер (блок не засчитывается)", () => {
  const lines = Array.from(
    { length: checks.PREMORTEM_MAX_PARSED + 5 },
    (_, i) => `вход ${i} → отказ → решение`,
  ).join("\n");
  const p = checks.parsePremortemBlock(lines);
  assert.strictEqual(p.entries.length, checks.PREMORTEM_MAX_PARSED + 1);
  const last = p.entries[p.entries.length - 1];
  assert.strictEqual(last.valid, false);
  assert.match(last.reason, /записей/);
});

test("extractTagBlocks: adversarial незакрытые теги — линейно и 0 блоков", () => {
  const text = "<premortem>".repeat(30_000);
  const t0 = Date.now();
  const blocks = checks.extractTagBlocks(text, "premortem");
  const elapsed = Date.now() - t0;
  assert.strictEqual(blocks.length, 0);
  assert.ok(elapsed < 1000, `extractTagBlocks занял ${elapsed}ms`);
});

test("extractTagBlocks: пары, регистр, кап", () => {
  const blocks = checks.extractTagBlocks(
    "<PREMORTEM>a</PREMORTEM> x <premortem>b</premortem>",
    "premortem",
  );
  assert.deepStrictEqual(blocks, ["a", "b"]);
  const many = checks.extractTagBlocks("<t>x</t>".repeat(500), "t");
  assert.strictEqual(many.length, 100);
});

test("validatePremortem: число / camelCase / UPPER_SNAKE / `литерал` — сигналы", () => {
  const ok = (s) =>
    checks.validatePremortem(checks.parsePremortemBlock(s))[0].ok;
  assert.ok(ok("лимит текста 4096 → отказ доставки → чанковать"));
  assert.ok(ok("вызов sendMessage в цикле → отказ → троттлить"));
  assert.ok(ok("превышение → ошибка MESSAGE_TOO_LONG → чанковать"));
  assert.ok(ok("непарный `*` в тексте → отказ парсера → экранировать"));
  assert.ok(ok("поле retry_after игнорируется → бан → уважать паузу"));
});

test("validatePremortem: «e.g.» не считается идентификатором (сегменты ≥2)", () => {
  const v = checks.validatePremortem(
    checks.parsePremortemBlock(
      "внешний сервис недоступен, e.g. на деплое → отказ → повторить вызов",
    ),
  );
  assert.strictEqual(v[0].ok, false);
});

test("findPremortemBlocks: собирает блоки из всех assistant-текстов с idx", () => {
  const mk = (text) => ({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  const blocks = checks.findPremortemBlocks([
    mk("<premortem>a → b → c</premortem>"),
    { type: "user", message: { content: "<premortem>x → y → z</premortem>" } },
    mk("без блока"),
    mk("до <premortem>d → e → f</premortem> после"),
  ]);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].idx, 0);
  assert.strictEqual(blocks[1].idx, 3);
  assert.match(blocks[1].body, /d → e → f/);
});

test("parseSelfReview: edge-секция парсится", () => {
  const r = checks.parseSelfReview(
    "<self-review>code:none-found\nsecurity:none-found\nedge:applied:чанкование по 4096</self-review>",
  );
  assert.strictEqual(r.edge.status, "applied");
  assert.match(r.edge.reason, /4096/);
});

test("parseReviewTriage: edge-источник валиден", () => {
  const r = checks.parseReviewTriage(
    "<review-triage>edge:1:applied:src/notify.ts:12 — чанкование текста по 4096</review-triage>",
  );
  assert.strictEqual(r.entries.length, 1);
  assert.ok(r.entries[0].valid);
  assert.strictEqual(r.entries[0].source, "edge");
});

// ─── shouldSkipForTestPairing ─────────────────────────────────────────────

test("shouldSkipForTestPairing: миграции (Knex/Adonis/Django/Rails)", () => {
  assert.ok(
    checks.shouldSkipForTestPairing(
      "backend/database/migrations/1777287343989_create_users_table.ts",
    ),
  );
  assert.ok(
    checks.shouldSkipForTestPairing("db/migrate/20231112_add_users.rb"),
  );
  assert.ok(checks.shouldSkipForTestPairing("alembic/versions/abc123_init.py"));
  assert.ok(checks.shouldSkipForTestPairing("migrations/0001_initial.py"));
});

test("shouldSkipForTestPairing: timestamped filenames без папки migrations", () => {
  // Knex/Adonis иногда кладёт файлы прямо в корень с timestamp
  assert.ok(
    checks.shouldSkipForTestPairing("1777287343989_create_users_table.ts"),
  );
  assert.ok(checks.shouldSkipForTestPairing("20231112120000_add_index.sql"));
});

test("shouldSkipForTestPairing: seeders / fixtures / locales / i18n", () => {
  assert.ok(checks.shouldSkipForTestPairing("database/seeders/UserSeeder.ts"));
  assert.ok(checks.shouldSkipForTestPairing("db/seeds/users.rb"));
  assert.ok(checks.shouldSkipForTestPairing("tests/fixtures/users.json"));
  assert.ok(checks.shouldSkipForTestPairing("src/locales/en.ts"));
  assert.ok(checks.shouldSkipForTestPairing("src/i18n/ru.json"));
  assert.ok(checks.shouldSkipForTestPairing("src/translations/de.yaml"));
});

test("shouldSkipForTestPairing: generated файлы (path)", () => {
  assert.ok(checks.shouldSkipForTestPairing("src/__generated__/api.ts"));
  assert.ok(checks.shouldSkipForTestPairing(".generated/types.ts"));
});

test("shouldSkipForTestPairing: generated файлы (filename)", () => {
  assert.ok(checks.shouldSkipForTestPairing("src/api.generated.ts"));
  assert.ok(checks.shouldSkipForTestPairing("src/types.gen.ts"));
  assert.ok(checks.shouldSkipForTestPairing("proto/messages.pb.go"));
  assert.ok(checks.shouldSkipForTestPairing("proto/messages_pb2.py"));
  assert.ok(checks.shouldSkipForTestPairing("proto/messages_pb2_grpc.py"));
  assert.ok(checks.shouldSkipForTestPairing("db/queries.sql.go"));
  assert.ok(checks.shouldSkipForTestPairing("src/types.d.ts"));
});

test("shouldSkipForTestPairing: framework configs", () => {
  assert.ok(checks.shouldSkipForTestPairing("vite.config.ts"));
  assert.ok(checks.shouldSkipForTestPairing("next.config.js"));
  assert.ok(checks.shouldSkipForTestPairing("nuxt.config.ts"));
  assert.ok(checks.shouldSkipForTestPairing("vitest.config.ts"));
  assert.ok(checks.shouldSkipForTestPairing("tailwind.config.js"));
  assert.ok(checks.shouldSkipForTestPairing("jest.config.cjs"));
  assert.ok(checks.shouldSkipForTestPairing("postcss.config.js"));
  assert.ok(checks.shouldSkipForTestPairing("playwright.config.ts"));
  assert.ok(checks.shouldSkipForTestPairing("playwright.config.js"));
  assert.ok(checks.shouldSkipForTestPairing("playwright.config.mjs"));
  assert.ok(checks.shouldSkipForTestPairing("/workspace/playwright.config.ts"));
  assert.ok(checks.shouldSkipForTestPairing("apps/web/playwright.config.ts"));
  // boundary: не путать с произвольным префиксом
  assert.ok(!checks.shouldSkipForTestPairing("src/myplaywright.config.ts"));
});

test("shouldSkipForTestPairing: wiring/start/bootstrap", () => {
  assert.ok(checks.shouldSkipForTestPairing("start/kernel.ts"));
  assert.ok(checks.shouldSkipForTestPairing("start/routes.ts"));
  assert.ok(checks.shouldSkipForTestPairing("bootstrap/app.ts"));
});

test("shouldSkipForTestPairing: infra/ infrastructure/ — IaC/operational каталоги", () => {
  assert.ok(checks.shouldSkipForTestPairing("infra/server/bootstrap.sh"));
  assert.ok(checks.shouldSkipForTestPairing("infra/server/lib/common.sh"));
  assert.ok(
    checks.shouldSkipForTestPairing("infra/server/templates/ufw-rules.sh"),
  );
  assert.ok(
    checks.shouldSkipForTestPairing("/workspace/infra/server/install.sh"),
  );
  assert.ok(
    checks.shouldSkipForTestPairing("infrastructure/k8s/manifests.yaml"),
  );
  // boundary: не путать с произвольным префиксом
  assert.ok(!checks.shouldSkipForTestPairing("src/myinfra/foo.ts"));
  // config/ и deploy/ намеренно НЕ skip-ятся (могут содержать логику);
  // юзер выключает их через MAIN_SKILL_VERIFY_IGNORE_GLOBS на уровне проекта.
  assert.ok(!checks.shouldSkipForTestPairing("backend/config/database.ts"));
  assert.ok(!checks.shouldSkipForTestPairing("apps/web/config/env.ts"));
  assert.ok(!checks.shouldSkipForTestPairing("deploy/staging.sh"));
});

test("shouldSkipForTestPairing: Storybook stories", () => {
  assert.ok(
    checks.shouldSkipForTestPairing("src/components/Button.stories.tsx"),
  );
  assert.ok(checks.shouldSkipForTestPairing("src/Card.stories.jsx"));
  assert.ok(checks.shouldSkipForTestPairing("packages/ui/Modal.stories.ts"));
  assert.ok(checks.shouldSkipForTestPairing("Form.stories.js"));
  // boundary: не путать с произвольным префиксом
  assert.ok(!checks.shouldSkipForTestPairing("src/Button.story.tsx")); // singular
  assert.ok(!checks.shouldSkipForTestPairing("src/MyStories.tsx")); // не суффикс
  assert.ok(!checks.shouldSkipForTestPairing("src/userStories.ts")); // не суффикс
});

test("shouldSkipForTestPairing: __mocks__/ — Jest module mocks", () => {
  assert.ok(checks.shouldSkipForTestPairing("__mocks__/axios.ts"));
  assert.ok(checks.shouldSkipForTestPairing("src/__mocks__/api.ts"));
  assert.ok(checks.shouldSkipForTestPairing("packages/ui/__mocks__/theme.ts"));
  // boundary: не путать с произвольным префиксом
  assert.ok(!checks.shouldSkipForTestPairing("src/mocks/foo.ts")); // без подчёркиваний
  assert.ok(!checks.shouldSkipForTestPairing("src/_mocks_/foo.ts")); // одинарные
  assert.ok(!checks.shouldSkipForTestPairing("src/mymocks/foo.ts"));
});

test("shouldSkipForTestPairing: операционные shell-скрипты по имени файла", () => {
  assert.ok(checks.shouldSkipForTestPairing("install.sh"));
  assert.ok(checks.shouldSkipForTestPairing("deploy.sh"));
  assert.ok(checks.shouldSkipForTestPairing("bootstrap.sh"));
  assert.ok(checks.shouldSkipForTestPairing("setup.sh"));
  assert.ok(checks.shouldSkipForTestPairing("provision.sh"));
  assert.ok(checks.shouldSkipForTestPairing("teardown.sh"));
  assert.ok(checks.shouldSkipForTestPairing("sync-config.sh"));
  assert.ok(checks.shouldSkipForTestPairing("sync_config.sh"));
  assert.ok(checks.shouldSkipForTestPairing("scripts/install.sh"));
  assert.ok(checks.shouldSkipForTestPairing("/workspace/deploy.sh"));
  // ops-имя + [-_]суффикс — тоже операционный скрипт (кейс ERP_NEW).
  assert.ok(checks.shouldSkipForTestPairing("deploy-server.sh"));
  assert.ok(checks.shouldSkipForTestPairing("setup-test-db.sh"));
  assert.ok(checks.shouldSkipForTestPairing("install-deps.sh"));
  assert.ok(checks.shouldSkipForTestPairing("provision_node.sh"));
  assert.ok(checks.shouldSkipForTestPairing("sync-config-prod.sh"));
  assert.ok(checks.shouldSkipForTestPairing("scripts/deploy_staging.sh"));
  // boundary: суффикс bounded ({1,40}) — сверхдлинный хвост не матчится
  assert.ok(!checks.shouldSkipForTestPairing(`deploy-${"x".repeat(41)}.sh`));
  // boundary: не путать с произвольным префиксом / приросшим словом
  assert.ok(!checks.shouldSkipForTestPairing("my-deploy.sh"));
  assert.ok(!checks.shouldSkipForTestPairing("installer.sh"));
  assert.ok(!checks.shouldSkipForTestPairing("reinstall.sh"));
  assert.ok(!checks.shouldSkipForTestPairing("deployment.sh"));
  // generic ops-имена намеренно НЕ skip-ятся — могут содержать логику.
  assert.ok(!checks.shouldSkipForTestPairing("entrypoint.sh"));
  assert.ok(!checks.shouldSkipForTestPairing("healthcheck.sh"));
  assert.ok(!checks.shouldSkipForTestPairing("run.sh"));
});

test("shouldSkipForTestPairing: AdonisJS wiring — providers/, bin/-entrypoints, adonisrc", () => {
  // providers/*_provider.(ts|js) — Adonis-конвенция имени, не каталог целиком.
  assert.ok(checks.shouldSkipForTestPairing("providers/app_provider.ts"));
  assert.ok(
    checks.shouldSkipForTestPairing(
      "apps/api/providers/http_server_provider.ts",
    ),
  );
  assert.ok(checks.shouldSkipForTestPairing("providers/queue_provider.js"));
  // cross-stack providers/ с реальной логикой — НЕ skip:
  // NestJS-сервисы (dot-case), React-контексты (PascalCase), Flutter (.dart).
  assert.ok(
    !checks.shouldSkipForTestPairing("src/providers/payment.service.ts"),
  );
  assert.ok(!checks.shouldSkipForTestPairing("src/providers/user.provider.ts"));
  assert.ok(!checks.shouldSkipForTestPairing("src/providers/AuthProvider.tsx"));
  assert.ok(!checks.shouldSkipForTestPairing("src/providers/AuthProvider.ts"));
  assert.ok(
    !checks.shouldSkipForTestPairing("lib/providers/cart_provider.dart"),
  );
  // не прямой потомок providers/ — НЕ skip
  assert.ok(
    !checks.shouldSkipForTestPairing("providers/http/server_provider.ts"),
  );
  // bin/-entrypoints — ТОЧЕЧНО три Adonis-имени, не bin/**.
  assert.ok(checks.shouldSkipForTestPairing("bin/server.ts"));
  assert.ok(checks.shouldSkipForTestPairing("bin/console.ts"));
  assert.ok(checks.shouldSkipForTestPairing("bin/test.ts"));
  assert.ok(checks.shouldSkipForTestPairing("bin/server.js"));
  assert.ok(checks.shouldSkipForTestPairing("apps/api/bin/server.ts"));
  // только прямой потомок bin/ (контракт паттерна)
  assert.ok(!checks.shouldSkipForTestPairing("bin/nested/server.ts"));
  // adonisrc — framework-config (Adonis 6), оба расширения.
  assert.ok(checks.shouldSkipForTestPairing("adonisrc.ts"));
  assert.ok(checks.shouldSkipForTestPairing("adonisrc.js"));
  assert.ok(checks.shouldSkipForTestPairing("apps/api/adonisrc.ts"));
  // ace.js — корневая JIT-обёртка Adonis 6; только .js.
  assert.ok(checks.shouldSkipForTestPairing("ace.js"));
  assert.ok(checks.shouldSkipForTestPairing("apps/api/ace.js"));
  assert.ok(!checks.shouldSkipForTestPairing("myace.js"));
  assert.ok(!checks.shouldSkipForTestPairing("src/ace.ts"));
  // boundary: произвольный префикс не считается
  assert.ok(!checks.shouldSkipForTestPairing("src/myproviders/x_provider.ts"));
  assert.ok(!checks.shouldSkipForTestPairing("myadonisrc.ts"));
  // bin/ с CLI-логикой — НЕ skip (точечность паттерна).
  assert.ok(!checks.shouldSkipForTestPairing("bin/report_logic.ts"));
  assert.ok(!checks.shouldSkipForTestPairing("bin/cleanup.sh"));
  // ace-команды (commands/) — бывает реальная логика, НЕ skip каталогом.
  assert.ok(!checks.shouldSkipForTestPairing("commands/korp_migrate.ts"));
});

test("shouldSkipForTestPairing: type-only файл по содержимому (только interface/type/const enum)", () => {
  const dir = tmp();
  writeFile(
    dir,
    "src/types/role.ts",
    `export type Role = 'admin' | 'user';\nexport interface Permission { name: string }\nexport const enum Level { Low, High }`,
  );
  assert.ok(checks.shouldSkipForTestPairing("src/types/role.ts", dir));
});

test("shouldSkipForTestPairing: НЕ skip-ит сервис с runtime-логикой", () => {
  const dir = tmp();
  writeFile(
    dir,
    "src/services/auth.ts",
    `export class AuthService {\n  login(u: string) { return u.length > 0 }\n}`,
  );
  assert.ok(!checks.shouldSkipForTestPairing("src/services/auth.ts", dir));
});

test("shouldSkipForTestPairing: @generated в первых строках", () => {
  const dir = tmp();
  writeFile(
    dir,
    "src/api.ts",
    `// @generated by graphql-codegen\nexport class Foo {\n  bar() { return 1 }\n}`,
  );
  assert.ok(checks.shouldSkipForTestPairing("src/api.ts", dir));
});

test('shouldSkipForTestPairing: "Code generated by" в первых строках (Go/Python)', () => {
  const dir = tmp();
  writeFile(
    dir,
    "pb/foo.go",
    `// Code generated by protoc-gen-go. DO NOT EDIT.\npackage pb\nfunc X() {}`,
  );
  assert.ok(checks.shouldSkipForTestPairing("pb/foo.go", dir));
});

test("shouldSkipForTestPairing: обычный сервисный файл — false", () => {
  assert.ok(!checks.shouldSkipForTestPairing("app/services/access_service.ts"));
  assert.ok(
    !checks.shouldSkipForTestPairing("app/controllers/auth_controller.ts"),
  );
  assert.ok(!checks.shouldSkipForTestPairing("src/components/Button.tsx"));
});

// ─── isDeclarativeModelFile (Lucid/TypeORM content heuristic) ──────────────

// Реалистичная голая Lucid-модель (кейс ERP_NEW: ai_conversation.ts).
const LUCID_BARE = `import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, belongsTo } from '@adonisjs/lucid/orm'
import type { HasMany, BelongsTo } from '@adonisjs/lucid/types/relations'
import AiMessage from '#models/ai_message'
import User from '#models/user'

export default class AiConversation extends BaseModel {
  static table = 'ai_conversations'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number

  @column({ columnName: 'return_url' })
  declare returnUrl: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => AiMessage)
  declare messages: HasMany<typeof AiMessage>

  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>
}`;

test("isDeclarativeModelFile: голая Lucid-модель (колонки+relations+static table) → skip", () => {
  assert.ok(checks.isDeclarativeModelFile(LUCID_BARE));
});

test("isDeclarativeModelFile: TypeORM entity (колонки + inverse-side thunks) → skip", () => {
  const src = `import { Entity, PrimaryGeneratedColumn, Column, OneToMany, ManyToOne } from 'typeorm'
import { Photo } from './photo'

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ length: 100 })
  firstName: string

  @Column({ default: true })
  isActive: boolean

  @OneToMany(() => Photo, (photo) => photo.user)
  photos: Photo[]

  @ManyToOne(() => Photo, (photo: Photo) => photo.owner)
  avatar: Photo
}`;
  assert.ok(checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: multiline relation + manyToMany с options + hasManyThrough → skip", () => {
  const src = `import { BaseModel, column, manyToMany, hasManyThrough, hasMany } from '@adonisjs/lucid/orm'
import Tag from '#models/tag'
import Project from '#models/project'
import Team from '#models/team'

export default class Post extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @manyToMany(() => Tag, { pivotTable: 'post_tags', localKey: 'id' })
  declare tags: ManyToMany<typeof Tag>

  @hasManyThrough([() => Project, () => Team])
  declare projects: HasManyThrough<typeof Project>

  @hasMany(
    () => Tag,
    { foreignKey: 'postId' },
  )
  declare drafts: HasMany<typeof Tag>
}`;
  assert.ok(checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: enum/type/interface рядом с моделью → skip", () => {
  const src = `import { BaseModel, column } from '@adonisjs/lucid/orm'

export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
}

export type ConversationStatus = 'active' | 'archived'

export default class Conversation extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare role: UserRole
}`;
  assert.ok(checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: закомментированная логика не считается логикой", () => {
  const src = `import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class Note extends BaseModel {
  /* get fullName() { return this.a + this.b } */
  @column({ isPrimary: true })
  declare id: number
  // markAsRead() { this.readAt = DateTime.now() }
}`;
  assert.ok(checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: @computed getter → НЕ skip", () => {
  const src = `${LUCID_BARE.slice(0, -1)}
  @computed()
  get title() {
    return this.id
  }
}`;
  assert.ok(!checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: метод в теле класса → НЕ skip", () => {
  const src = `${LUCID_BARE.slice(0, -1)}
  markAsRead() {
    this.readAt = DateTime.now()
  }
}`;
  assert.ok(!checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: lifecycle-hook (@beforeSave / @BeforeInsert) → НЕ skip", () => {
  const lucid = `${LUCID_BARE.slice(0, -1)}
  @beforeSave()
  static async hashPassword(user: AiConversation) {
    user.userId = 1
  }
}`;
  assert.ok(!checks.isDeclarativeModelFile(lucid));
  const typeorm = `import { Entity, Column, BeforeInsert } from 'typeorm'
@Entity()
export class User {
  @Column()
  name: string

  @BeforeInsert()
  normalize() {
    this.name = this.name.trim()
  }
}`;
  assert.ok(!checks.isDeclarativeModelFile(typeorm));
});

test("isDeclarativeModelFile: get/set accessor без @computed → НЕ skip", () => {
  const src = `${LUCID_BARE.slice(0, -1)}
  get isRecent() {
    return true
  }
}`;
  assert.ok(!checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: стрелка как значение (static / serialize / onQuery) → НЕ skip", () => {
  // static-инициализатор со стрелкой — логика, аргументная позиция не при чём.
  assert.ok(
    !checks.isDeclarativeModelFile(`${LUCID_BARE.slice(0, -1)}
  static active = () => AiConversation.query()
}`),
  );
  // serialize/prepare-трансформы в опциях колонки — логика.
  assert.ok(
    !checks.isDeclarativeModelFile(`import { BaseModel, column } from '@adonisjs/lucid/orm'
export default class Doc extends BaseModel {
  @column({ serialize: (value) => value?.toISO() })
  declare publishedAt: DateTime | null
}`),
  );
  // onQuery-скоуп в опциях relation — логика (стрелка после двоеточия).
  assert.ok(
    !checks.isDeclarativeModelFile(`import { BaseModel, hasMany } from '@adonisjs/lucid/orm'
export default class Doc extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @hasMany(() => Doc, { onQuery: (query) => query.whereNull('deletedAt') })
  declare drafts: HasMany<typeof Doc>
}`),
  );
});

test("isDeclarativeModelFile: Lucid scope / serializeExtras / static-вызов → НЕ skip", () => {
  assert.ok(
    !checks.isDeclarativeModelFile(`${LUCID_BARE.slice(0, -1)}
  static published = scope((query) => query.where('published', true))
}`),
  );
  assert.ok(
    !checks.isDeclarativeModelFile(`${LUCID_BARE.slice(0, -1)}
  serializeExtras = true
}`),
  );
  // Присваивание результата вызова (компутед-статик через хелпер).
  assert.ok(
    !checks.isDeclarativeModelFile(`${LUCID_BARE.slice(0, -1)}
  static sorted = orderBy((m) => m.rank)
}`),
  );
});

test("isDeclarativeModelFile: гейт — не-модель / compose-mixin / пустота → НЕ skip", () => {
  // Обычный сервис — нет extends BaseModel / @Entity.
  assert.ok(
    !checks.isDeclarativeModelFile(
      `export class AuthService {\n  login(u: string) { return u.length > 0 }\n}`,
    ),
  );
  // Mixin через compose() — поведение из миксина, консервативно НЕ skip.
  assert.ok(
    !checks.isDeclarativeModelFile(`import { compose } from '@adonisjs/core/helpers'
import { BaseModel, column } from '@adonisjs/lucid/orm'
const AuthFinder = withAuthFinder(() => hash.use('scrypt'), { uids: ['email'] })
export default class User extends compose(BaseModel, AuthFinder) {
  @column({ isPrimary: true })
  declare id: number
}`),
  );
  // Класс extends BaseModel, но БЕЗ единого column/relation/declare-поля.
  assert.ok(
    !checks.isDeclarativeModelFile(
      `import { BaseModel } from '@adonisjs/lucid/orm'\nexport default class Stub extends BaseModel {}`,
    ),
  );
  assert.ok(!checks.isDeclarativeModelFile(""));
  assert.ok(!checks.isDeclarativeModelFile(null));
});

test("isDeclarativeModelFile: многострочная сигнатура метода → НЕ skip (ревью-HIGH)", () => {
  // Prettier-перенос параметров; тело без this/return-маркеров — ловится по `){`.
  const src = `${LUCID_BARE.slice(0, -1)}
  static seedDefaults(
    trx: TransactionClientContract,
    opts: SeedOptions,
  ) { trx.insert(opts) }
}`;
  assert.ok(!checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: static initialization block → НЕ skip", () => {
  const src = `${LUCID_BARE.slice(0, -1)}
  static {
    registry.add('conversations')
  }
}`;
  assert.ok(!checks.isDeclarativeModelFile(src));
  // static-КОНСТАНТА с объектным литералом — по-прежнему skip (не block).
  assert.ok(
    checks.isDeclarativeModelFile(`${LUCID_BARE.slice(0, -1)}
  static metaDefaults = { pinned: false }
}`),
  );
});

test("isDeclarativeModelFile: computed/unicode/private имена методов → НЕ skip", () => {
  assert.ok(
    !checks.isDeclarativeModelFile(`${LUCID_BARE.slice(0, -1)}
  ['refresh']() { registry.tick() }
}`),
  );
  assert.ok(
    !checks.isDeclarativeModelFile(`${LUCID_BARE.slice(0, -1)}
  обновить() { registry.tick() }
}`),
  );
  assert.ok(
    !checks.isDeclarativeModelFile(`${LUCID_BARE.slice(0, -1)}
  #sync() { registry.tick() }
}`),
  );
});

test("isDeclarativeModelFile: кастомная база `extends AppBaseModel` (суффикс-конвенция) → skip", () => {
  const src = `import AppBaseModel from '#models/app_base_model'
import { column } from '@adonisjs/lucid/orm'

export default class Invoice extends AppBaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare total: number
}`;
  assert.ok(checks.isDeclarativeModelFile(src));
  // Не-суффиксная база (BaseModelWithSoftDeletes) — гейт НЕ проходит.
  assert.ok(
    !checks.isDeclarativeModelFile(
      src.replace("AppBaseModel {", "BaseModelWithSoftDeletes {"),
    ),
  );
});

test("isDeclarativeModelFile: @Entity внутри строки — гейт НЕ проходит (ревью-MED)", () => {
  const src = `const doc = "Use @Entity() to mark a class as a table."
declare global { interface Window { flag: boolean } }
export class NotAnEntity {}`;
  assert.ok(!checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: логика после relations (function / хвостовой хелпер) → НЕ skip", () => {
  const src = `${LUCID_BARE}

export function normalizeTitle(t: string) {
  return t.trim()
}`;
  assert.ok(!checks.isDeclarativeModelFile(src));
});

test("isDeclarativeModelFile: ReDoS-guard — adversarial ~200KB линеен", () => {
  const gate =
    "export default class X extends BaseModel {\n@column()\ndeclare id: number\n";
  // Незакрытые relation-вызовы: гоняют thunk-нейтрализацию и method-body regex.
  const advA = gate + "@hasMany(() => M, ".repeat(8000) + "\n}";
  // Скобочно-знаковый мусор без сигналов + реальная логика в хвосте:
  // независимо от мусора детектор обязан дойти и вернуть false.
  const advB = gate + "=((".repeat(60000) + "\nmarkAsRead() { return 1 }\n}";
  const t = Date.now();
  const rA = checks.isDeclarativeModelFile(advA);
  const rB = checks.isDeclarativeModelFile(advB);
  const ms = Date.now() - t;
  assert.strictEqual(rA, true); // мусор без валидной логики — сигналов нет
  assert.strictEqual(rB, false); // логика в хвосте найдена за мусором
  assert.ok(
    ms < 1000,
    `ожидал < 1000ms, получил ${ms}ms (catastrophic backtracking?)`,
  );
});

test("shouldSkipForTestPairing: декларативная Lucid-модель по содержимому → skip", () => {
  const dir = tmp();
  writeFile(dir, "apps/api/app/models/ai_conversation.ts", LUCID_BARE);
  assert.ok(
    checks.shouldSkipForTestPairing(
      "apps/api/app/models/ai_conversation.ts",
      dir,
    ),
  );
});

test("shouldSkipForTestPairing: декларативная модель в .js — тоже skip", () => {
  const dir = tmp();
  writeFile(
    dir,
    "app/models/tag.js",
    `import { BaseModel, column } from '@adonisjs/lucid/orm'
export default class Tag extends BaseModel {
  @column({ isPrimary: true })
  declare id
}`,
  );
  assert.ok(checks.shouldSkipForTestPairing("app/models/tag.js", dir));
});

test("shouldSkipForTestPairing: модель С логикой (@computed/метод) → НЕ skip", () => {
  const dir = tmp();
  writeFile(
    dir,
    "apps/api/app/models/user.ts",
    `${LUCID_BARE.slice(0, -1)}
  @computed()
  get displayName() {
    return this.userId
  }
}`,
  );
  assert.ok(
    !checks.shouldSkipForTestPairing("apps/api/app/models/user.ts", dir),
  );
});

// ─── isPresentationalSFC (Vue/Svelte/Astro content heuristic) ─────────────

test("isPresentationalSFC: template-only (нет <script>) → презентационный", () => {
  assert.ok(checks.isPresentationalSFC("<template><div>hi</div></template>"));
  assert.ok(
    checks.isPresentationalSFC(
      "<template><slot/></template>\n<style scoped>.x{color:red}</style>",
    ),
  );
});

test("isPresentationalSFC: <script setup> только defineProps/defineEmits/import → презентационный", () => {
  const src = `<template><h1>{{ title }}</h1></template>
<script setup lang="ts">
import Icon from './Icon.vue'
const props = defineProps<{ title: string; items: string[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()
</script>`;
  assert.ok(checks.isPresentationalSFC(src));
});

test("isPresentationalSFC: типизированный callback-проп `() => void` НЕ ложно-логика", () => {
  const src = `<script setup lang="ts">
const props = defineProps<{ onSelect: (id: number) => void; format: (v: number) => string }>()
</script>`;
  assert.ok(checks.isPresentationalSFC(src));
});

test("isPresentationalSFC: defineProps runtime-форма (массив/объект) → презентационный", () => {
  assert.ok(
    checks.isPresentationalSFC(
      `<script setup>\nconst props = defineProps(['title', 'count'])\n</script>`,
    ),
  );
});

test("isPresentationalSFC: computed() → логика", () => {
  const src = `<script setup>
const full = computed(() => first.value + ' ' + last.value)
</script>`;
  assert.ok(!checks.isPresentationalSFC(src));
});

test("isPresentationalSFC: watch() → логика", () => {
  const src = `<script setup>
watch(count, (n) => { console.log(n) })
</script>`;
  assert.ok(!checks.isPresentationalSFC(src));
});

test("isPresentationalSFC: function-объявление → логика", () => {
  const src = `<script setup>
const n = ref(0)
function increment() { n.value++ }
</script>`;
  assert.ok(!checks.isPresentationalSFC(src));
});

test("isPresentationalSFC: arrow-функция как значение → логика", () => {
  assert.ok(
    !checks.isPresentationalSFC(
      `<script setup>\nconst fmt = (x) => x.toFixed(2)\n</script>`,
    ),
  );
  assert.ok(
    !checks.isPresentationalSFC(
      `<script setup>\nconst handler = async () => { await save() }\n</script>`,
    ),
  );
});

test("isPresentationalSFC: control-flow → логика", () => {
  assert.ok(
    !checks.isPresentationalSFC(
      `<script setup>\nconst label = ref('')\nif (props.active) { label.value = 'on' }\n</script>`,
    ),
  );
});

test("isPresentationalSFC: data-transform (.map/.filter) → логика", () => {
  assert.ok(
    !checks.isPresentationalSFC(
      `<script setup>\nconst names = props.users.map((u) => u.name)\n</script>`,
    ),
  );
});

test("isPresentationalSFC: lifecycle-хук onMounted → логика", () => {
  assert.ok(
    !checks.isPresentationalSFC(
      `<script setup>\nonMounted(() => { fetchData() })\n</script>`,
    ),
  );
});

test("isPresentationalSFC: Options API props/name-only → презентационный", () => {
  const src = `<script>
export default {
  name: 'UserBadge',
  props: { title: String, count: Number },
}
</script>`;
  assert.ok(checks.isPresentationalSFC(src));
});

test("isPresentationalSFC: Options API methods/computed → логика", () => {
  assert.ok(
    !checks.isPresentationalSFC(
      `<script>\nexport default { methods: { inc() { this.n++ } } }\n</script>`,
    ),
  );
  assert.ok(
    !checks.isPresentationalSFC(
      `<script>\nexport default { computed: { full() { return this.a + this.b } } }\n</script>`,
    ),
  );
});

test("isPresentationalSFC: закомментированная логика не считается логикой", () => {
  const src = `<script setup>
// function increment() { n++ }  ← закомментировано
const props = defineProps(['title'])
</script>`;
  assert.ok(checks.isPresentationalSFC(src));
});

test("isPresentationalSFC: ref()/reactive() состояние → логика", () => {
  assert.ok(
    !checks.isPresentationalSFC(
      `<script setup>\nconst open = ref(false)\n</script>`,
    ),
  );
  assert.ok(
    !checks.isPresentationalSFC(
      `<script setup>\nconst state = reactive({ n: 0 })\n</script>`,
    ),
  );
});

test("isPresentationalSFC: object method shorthand (defineExpose) → логика", () => {
  assert.ok(
    !checks.isPresentationalSFC(
      `<script setup>\nconst el = ref()\ndefineExpose({ focus() { el.value.focus() } })\n</script>`,
    ),
  );
  assert.ok(
    !checks.isPresentationalSFC(
      `<script>\nexport default { data() { return { n: 0 } } }\n</script>`,
    ),
  );
});

test("isPresentationalSFC: Svelte 5 руна $state → логика", () => {
  assert.ok(
    !checks.isPresentationalSFC(`<script>\nlet count = $state(0)\n</script>`),
  );
});

test("isPresentationalSFC: многострочная сигнатура (arrow-значение / method shorthand) → логика", () => {
  // Prettier-перенос параметров arrow-значения — раньше [^)\n] в _ARG пропускал.
  assert.ok(
    !checks.isPresentationalSFC(`<script setup>
const fmt = (
  value,
) => value.toLocaleString()
</script>`),
  );
  // Многострочный object-method shorthand (defineExpose).
  assert.ok(
    !checks.isPresentationalSFC(`<script setup>
defineExpose({
  focus(
    opts,
  ) { el.focus(opts) },
})
</script>`),
  );
  // static initialization block внутри class в script — исполняемая логика.
  assert.ok(
    !checks.isPresentationalSFC(
      `<script>\nclass Registry { static { register() } }\n</script>`,
    ),
  );
});

test("isPresentationalSFC: withDefaults / object-return-type аннотация НЕ ложно-логика", () => {
  // `withDefaults(defineProps<Props>(), {...})` — `),` и `} )` без `){`.
  assert.ok(
    checks.isPresentationalSFC(`<script setup lang="ts">
import type { Props } from './types'
withDefaults(defineProps<Props>(), { size: 'md' })
</script>`),
  );
  // Тип-аннотация с объектным return-type: `) => {` режется стрелкой, не `){`.
  assert.ok(
    checks.isPresentationalSFC(`<script setup lang="ts">
defineProps<{ handler: (e: Event) => { ok: boolean } }>()
</script>`),
  );
});

test("isPresentationalSFC: ReDoS-guard — adversarial 200KB ввод линеен", () => {
  const big = "<script>" + "f((".repeat(66000) + "</script>"; // ~200KB
  const t = Date.now();
  const res = checks.isPresentationalSFC(big);
  const ms = Date.now() - t;
  assert.strictEqual(res, true); // нет валидной логики — презентационный
  assert.ok(
    ms < 1000,
    `ожидал < 1000ms, получил ${ms}ms (catastrophic backtracking?)`,
  );
});

test("isPresentationalSFC: Svelte reactive $: → логика", () => {
  assert.ok(
    !checks.isPresentationalSFC(
      `<script>\nexport let count = 0\n$: doubled = count * 2\n</script>`,
    ),
  );
});

test("isPresentationalSFC: Svelte только export let (props) → презентационный", () => {
  assert.ok(
    checks.isPresentationalSFC(
      `<script>\nexport let title\nexport let count = 0\n</script>\n<h1>{title}</h1>`,
    ),
  );
});

test("isPresentationalSFC: Astro frontmatter с логикой → логика", () => {
  const src = `---
const { items } = Astro.props
const names = items.map((i) => i.name)
---
<ul>{names.map((n) => <li>{n}</li>)}</ul>`;
  assert.ok(!checks.isPresentationalSFC(src));
});

test("isPresentationalSFC: Astro frontmatter только props-destructure → презентационный", () => {
  const src = `---
const { title } = Astro.props
---
<h1>{title}</h1>`;
  assert.ok(checks.isPresentationalSFC(src));
});

// ─── shouldSkipForTestPairing: презентационные SFC по содержимому ──────────

test("shouldSkipForTestPairing: презентационный .vue → skip", () => {
  const dir = tmp();
  writeFile(
    dir,
    "src/components/Badge.vue",
    `<template><span class="badge">{{ label }}</span></template>
<script setup lang="ts">
const props = defineProps<{ label: string }>()
</script>`,
  );
  assert.ok(checks.shouldSkipForTestPairing("src/components/Badge.vue", dir));
});

test("shouldSkipForTestPairing: .vue с логикой → НЕ skip (тест обязателен)", () => {
  const dir = tmp();
  writeFile(
    dir,
    "src/components/Counter.vue",
    `<template><button @click="inc">{{ doubled }}</button></template>
<script setup lang="ts">
import { ref, computed } from 'vue'
const n = ref(0)
const doubled = computed(() => n.value * 2)
function inc() { n.value++ }
</script>`,
  );
  assert.ok(
    !checks.shouldSkipForTestPairing("src/components/Counter.vue", dir),
  );
});

test("shouldSkipForTestPairing: template-only .vue (нет script) → skip", () => {
  const dir = tmp();
  writeFile(
    dir,
    "src/components/Divider.vue",
    `<template><hr class="divider"/></template>\n<style scoped>.divider{margin:8px 0}</style>`,
  );
  assert.ok(checks.shouldSkipForTestPairing("src/components/Divider.vue", dir));
});

test("shouldSkipForTestPairing: .svelte с логикой → НЕ skip", () => {
  const dir = tmp();
  writeFile(
    dir,
    "src/Toggle.svelte",
    `<script>\nexport let on = false\nfunction flip() { on = !on }\n</script>\n<button on:click={flip}>{on}</button>`,
  );
  assert.ok(!checks.shouldSkipForTestPairing("src/Toggle.svelte", dir));
});

test("shouldSkipForTestPairing: презентационный .astro → skip", () => {
  const dir = tmp();
  writeFile(
    dir,
    "src/Hero.astro",
    `---\nconst { title } = Astro.props\n---\n<section><h1>{title}</h1></section>`,
  );
  assert.ok(checks.shouldSkipForTestPairing("src/Hero.astro", dir));
});

// ─── matchAnyGlob (env override helper) ───────────────────────────────────

test("matchAnyGlob: базовые glob-паттерны", () => {
  assert.ok(checks.matchAnyGlob("src/foo.ts", ["**/*.ts"]));
  assert.ok(
    checks.matchAnyGlob("backend/migrations/001.ts", ["**/migrations/**"]),
  );
  assert.ok(checks.matchAnyGlob("src/types/foo.ts", ["**/types/**"]));
  assert.ok(!checks.matchAnyGlob("src/services/foo.ts", ["**/types/**"]));
  assert.ok(checks.matchAnyGlob("foo.config.js", ["*.config.js"]));
});

test("matchAnyGlob: пустой/falsy глоб-список → false", () => {
  assert.ok(!checks.matchAnyGlob("src/foo.ts", []));
  assert.ok(!checks.matchAnyGlob("src/foo.ts", null));
});

// ─── isBroadIgnoreGlob (breadth-классификатор для ignore-glob-guard) ────────

test("isBroadIgnoreGlob: каталог-глоб (последний сегмент — голый wildcard) = broad", () => {
  assert.ok(checks.isBroadIgnoreGlob("**"));
  assert.ok(checks.isBroadIgnoreGlob("*"));
  assert.ok(checks.isBroadIgnoreGlob("**/scripts/**"));
  assert.ok(checks.isBroadIgnoreGlob("src/services/**"));
  assert.ok(checks.isBroadIgnoreGlob("dir/*"));
  assert.ok(checks.isBroadIgnoreGlob("packages/*/src/**"));
  assert.ok(checks.isBroadIgnoreGlob("legacy/**/")); // trailing slash не мешает
});

test("isBroadIgnoreGlob: голое расширение по всему дереву = broad (не обойти *.ts)", () => {
  // Освобождает от D весь язык целиком — по эффекту шире, чем dir/**.
  assert.ok(checks.isBroadIgnoreGlob("**/*.ts"));
  assert.ok(checks.isBroadIgnoreGlob("**/*.js"));
  assert.ok(checks.isBroadIgnoreGlob("**/*.py"));
  assert.ok(checks.isBroadIgnoreGlob("dir/*.*"));
  assert.ok(checks.isBroadIgnoreGlob("**/*.*"));
  assert.ok(checks.isBroadIgnoreGlob("src/**/*.*"));
  assert.ok(checks.isBroadIgnoreGlob("*.ts"));
});

test("isBroadIgnoreGlob: якорь по имени/составному расширению = narrow", () => {
  assert.ok(!checks.isBroadIgnoreGlob("**/*.gen.ts")); // .gen — анкер
  assert.ok(!checks.isBroadIgnoreGlob("**/*.pb.go"));
  assert.ok(!checks.isBroadIgnoreGlob("**/*.d.ts"));
  assert.ok(!checks.isBroadIgnoreGlob("**/*.config.ts"));
  assert.ok(!checks.isBroadIgnoreGlob("scripts/build-*.sh"));
  assert.ok(!checks.isBroadIgnoreGlob("src/generated/schema.ts"));
  assert.ok(!checks.isBroadIgnoreGlob("dir/**/*.pb.go"));
  assert.ok(!checks.isBroadIgnoreGlob("Button.tsx"));
  assert.ok(!checks.isBroadIgnoreGlob("src/*/index.ts"));
});

test("isBroadIgnoreGlob: пустой/мусорный вход → false (не broad)", () => {
  assert.ok(!checks.isBroadIgnoreGlob(""));
  assert.ok(!checks.isBroadIgnoreGlob(null));
  assert.ok(!checks.isBroadIgnoreGlob(undefined));
  assert.ok(!checks.isBroadIgnoreGlob("   "));
});

test("findE2eFile находит functional-парный", () => {
  const dir = tmp();
  writeFile(dir, "app/controllers/auth_controller.ts", "x");
  writeFile(dir, "tests/functional/auth.spec.ts", 'test("login", () => {})');
  const found = checks.findE2eFile("app/controllers/auth_controller.ts", dir);
  assert.ok(found);
});

test("findE2eFile находит integration-парный (anti-drift: общий с D набор)", () => {
  const dir = tmp();
  writeFile(dir, "app/controllers/auth_controller.ts", "x");
  writeFile(dir, "tests/integration/auth.test.ts", 'test("login", () => {})');
  const found = checks.findE2eFile("app/controllers/auth_controller.ts", dir);
  assert.ok(found, `tests/integration should match in E too, got ${found}`);
});

test("findE2eFile: pnpm workspace — backend/tests/functional/auth.spec.ts", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "backend/package.json", "{}");
  writeFile(dir, "backend/app/controllers/auth_controller.ts", "x");
  writeFile(
    dir,
    "backend/tests/functional/auth.spec.ts",
    'test("login", () => {})',
  );
  const found = checks.findE2eFile(
    "backend/app/controllers/auth_controller.ts",
    dir,
  );
  assert.ok(found, `expected e2e in workspace, got ${found}`);
  assert.match(found, /backend[\\/]tests[\\/]functional[\\/]auth\.spec\.ts/);
});

test("findE2eFile: dual bases — тест по полному имени файла контроллера", () => {
  const dir = tmp();
  writeFile(dir, "app/controllers/auth_controller.ts", "x");
  writeFile(
    dir,
    "tests/integration/auth_controller.test.ts",
    'test("login", () => {})',
  );
  const found = checks.findE2eFile("app/controllers/auth_controller.ts", dir);
  assert.ok(found, `полное имя auth_controller.test.ts должно матчиться`);
});

test("findE2eFile: directory-based роутинг (Next.js App Router route.ts)", () => {
  const dir = tmp();
  writeFile(dir, "app/api/auth/login/route.ts", "x");
  writeFile(dir, "tests/e2e/login.test.ts", 'test("login", () => {})');
  const found = checks.findE2eFile("app/api/auth/login/route.ts", dir);
  assert.ok(found, `route.ts должен искаться по имени родительской директории`);
  assert.match(found, /login\.test\.ts/);
  // без теста — null (basename `route` сам по себе бесполезен)
  writeFile(dir, "app/api/posts/comments/route.ts", "x");
  assert.strictEqual(
    checks.findE2eFile("app/api/posts/comments/route.ts", dir),
    null,
  );
});

test("parseEdgeCasesBlock парсит однострочный формат", () => {
  const t =
    "<edge-cases>empty:tests/auth.test.ts:test_empty; race:tests/auth.test.ts:test_race</edge-cases>";
  const r = checks.parseEdgeCasesBlock(t);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.entries[0].name, "empty");
  assert.strictEqual(r.entries[0].test_file, "tests/auth.test.ts");
  assert.strictEqual(r.entries[0].test_name, "test_empty");
});

test("parseEdgeCasesBlock — нет блока → null", () => {
  assert.strictEqual(
    checks.parseEdgeCasesBlock("просто текст без блока"),
    null,
  );
});

test("validateEdgeCases — test_name найден в файле", () => {
  const dir = tmp();
  writeFile(
    dir,
    "tests/auth.test.ts",
    `it('handles empty password', () => {});\nit('handles concurrent_login', () => {});`,
  );
  const parsed = checks.parseEdgeCasesBlock(
    "<edge-cases>empty:tests/auth.test.ts:empty password; race:tests/auth.test.ts:concurrent_login</edge-cases>",
  );
  const v = checks.validateEdgeCases(parsed, dir);
  assert.ok(v.every((x) => x.ok));
});

test("validateEdgeCases — test_name отсутствует → не ok", () => {
  const dir = tmp();
  writeFile(dir, "tests/auth.test.ts", `it('happy path', () => {});`);
  const parsed = checks.parseEdgeCasesBlock(
    "<edge-cases>empty:tests/auth.test.ts:test_empty</edge-cases>",
  );
  const v = checks.validateEdgeCases(parsed, dir);
  assert.strictEqual(v[0].ok, false);
});

test("validateEdgeCases — test_file не существует → не ok", () => {
  const dir = tmp();
  const parsed = checks.parseEdgeCasesBlock(
    "<edge-cases>empty:tests/missing.test.ts:test_empty</edge-cases>",
  );
  const v = checks.validateEdgeCases(parsed, dir);
  assert.strictEqual(v[0].ok, false);
  assert.match(v[0].reason, /не найден/);
});

test("parseEdgeCasesBlock: test_name с двоеточием не теряет хвост", () => {
  // Регрессия: старый парсер (rest.pop()) терял всё кроме последнего сегмента
  // и склеивал test_file с куском test_name.
  const t =
    "<edge-cases>empty:hooks/auto-format.test.ts:main: empty stdin → no-op</edge-cases>";
  const r = checks.parseEdgeCasesBlock(t);
  assert.strictEqual(r.entries[0].name, "empty");
  assert.strictEqual(r.entries[0].test_file, "hooks/auto-format.test.ts");
  assert.strictEqual(r.entries[0].test_name, "main: empty stdin → no-op");
});

test("validateEdgeCases: test_name с двоеточием находится в файле", () => {
  const dir = tmp();
  writeFile(
    dir,
    "tests/auth.test.ts",
    `it('main: empty stdin → no-op', () => {});`,
  );
  const parsed = checks.parseEdgeCasesBlock(
    "<edge-cases>empty:tests/auth.test.ts:main: empty stdin</edge-cases>",
  );
  const v = checks.validateEdgeCases(parsed, dir);
  assert.strictEqual(v[0].ok, true);
});

test("validateEdgeCases: N/A test_file — допустим, требует непустую причину", () => {
  // SKILL.md: «Если конкретный кейс реально N/A — пиши явно: name:N/A:<причина>».
  const dir = tmp();
  const parsed = checks.parseEdgeCasesBlock(
    "<edge-cases>concurrency:N/A:сериализуется хук-протоколом</edge-cases>",
  );
  const v = checks.validateEdgeCases(parsed, dir);
  assert.strictEqual(v[0].ok, true);
  assert.strictEqual(v[0].na, true);
});

test("validateEdgeCases: N/A с пустой причиной — не ok", () => {
  const dir = tmp();
  const parsed = checks.parseEdgeCasesBlock(
    "<edge-cases>concurrency:N/A:</edge-cases>",
  );
  // У парсера на segs.length<3 валится — это уже покрыто. Здесь — N/A с whitespace.
  const parsed2 = checks.parseEdgeCasesBlock(
    "<edge-cases>concurrency:N/A:   </edge-cases>",
  );
  const v = checks.validateEdgeCases(parsed2, dir);
  assert.strictEqual(v[0].ok, false);
  assert.match(v[0].reason, /причин/i);
});

test("runLint возвращает null если ничего не настроено", () => {
  const dir = tmp();
  const r = checks.runLint(dir);
  assert.strictEqual(r, null);
});

// ────────────────────────────────────────────────────────────────────────────
// Триггер L: парсеры manifest-форматов + поиск version-lookup-ов в transcript
// ────────────────────────────────────────────────────────────────────────────

test("parseManifestDeps: package.json фрагмент в Edit", () => {
  const content = `"react": "^18.0.0",\n"next": "^13.4.0"`;
  const deps = checks.parseManifestDeps("package.json", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ["next", "react"]);
  assert.ok(deps.every((d) => d.type === "npm"));
});

test("parseManifestDeps: package.json полный файл с dependencies/devDependencies", () => {
  const content = JSON.stringify({
    name: "my-app",
    version: "1.0.0",
    description: "x",
    dependencies: { react: "^18.0.0" },
    devDependencies: { jest: "^29.0.0" },
  });
  const deps = checks.parseManifestDeps("package.json", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ["jest", "react"]);
});

test("parseManifestDeps: package.json — корневые поля name/version не в deps", () => {
  // Когда пишется фрагмент `"name": "my-app"` он НЕ должен попасть как dep.
  const content = `"name": "my-app",\n"version": "1.0.0"`;
  const deps = checks.parseManifestDeps("package.json", content);
  assert.deepStrictEqual(deps, []);
});

test("parseManifestDeps: package.json engines.node — это runtime", () => {
  const content = JSON.stringify({
    name: "x",
    engines: { node: ">=20" },
  });
  const deps = checks.parseManifestDeps("package.json", content);
  const node = deps.find((d) => d.name === "node");
  assert.ok(node);
  assert.strictEqual(node.type, "runtime");
});

test("parseManifestDeps: requirements.txt", () => {
  const content = `django==4.2.0\nrequests>=2.31.0\n# comment\n  flask~=2.3.0\n-r other.txt\n`;
  const deps = checks.parseManifestDeps("requirements.txt", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ["django", "flask", "requests"]);
  assert.ok(deps.every((d) => d.type === "pip"));
});

test("parseManifestDeps: pyproject.toml [project.dependencies] и [tool.poetry.dependencies]", () => {
  const content = `[project]\nname = "my-app"\nversion = "0.1.0"\n[project.dependencies]\ndjango = "^4.2"\n[tool.poetry.dependencies]\nrequests = "^2.31"\nfastapi = { version = "^0.100", extras = ["all"] }\n[tool.ruff]\nline-length = 100\n`;
  const deps = checks.parseManifestDeps("pyproject.toml", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ["django", "fastapi", "requests"]);
  assert.ok(deps.every((d) => d.type === "pip"));
});

test("parseManifestDeps: pyproject.toml dependencies = [...] список (PEP-621)", () => {
  const content = `[project]\nname = "my-app"\ndependencies = [\n  "django>=4.2",\n  "requests",\n]\n`;
  const deps = checks.parseManifestDeps("pyproject.toml", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ["django", "requests"]);
});

test("parseManifestDeps: Cargo.toml [dependencies] + [dev-dependencies]", () => {
  const content = `[package]\nname = "x"\nversion = "0.1.0"\n[dependencies]\nserde = "1.0"\ntokio = { version = "1.35", features = ["full"] }\n[dev-dependencies]\nrstest = "0.18"\n[build-dependencies]\ncc = "1.0"\n`;
  const deps = checks.parseManifestDeps("Cargo.toml", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ["cc", "rstest", "serde", "tokio"]);
  assert.ok(deps.every((d) => d.type === "cargo"));
});

test("parseManifestDeps: go.mod require block + single-line require", () => {
  const content = `module my/app\n\ngo 1.21\n\nrequire (\n  github.com/gin-gonic/gin v1.9.1\n  go.uber.org/zap v1.26.0\n)\n\nrequire golang.org/x/sync v0.5.0\n`;
  const deps = checks.parseManifestDeps("go.mod", content);
  const goModules = deps.filter((d) => d.type === "go").map((d) => d.name);
  goModules.sort();
  assert.deepStrictEqual(goModules, [
    "github.com/gin-gonic/gin",
    "go.uber.org/zap",
    "golang.org/x/sync",
  ]);
  // Также `go 1.21` должно попасть как runtime
  const goRuntime = deps.find((d) => d.type === "runtime" && d.name === "go");
  assert.ok(goRuntime);
  assert.strictEqual(goRuntime.version, "1.21");
});

test("parseManifestDeps: go.mod — 'go 1.21' не должен попасть как dep", () => {
  const content = `module my/app\ngo 1.21\n`;
  const deps = checks.parseManifestDeps("go.mod", content);
  // Go runtime version — это runtime, должен попасть как runtime/go
  const goRuntime = deps.find(
    (d) => d.type === "runtime" && (d.name === "go" || d.name === "golang"),
  );
  assert.ok(goRuntime);
  // Никаких "module my/app" как dep
  const namesNotRuntime = deps
    .filter((d) => d.type === "go")
    .map((d) => d.name);
  assert.deepStrictEqual(namesNotRuntime, []);
});

test("parseManifestDeps: Dockerfile FROM lines", () => {
  const content = `FROM node:18-alpine AS builder\nWORKDIR /app\nFROM python:3.11\nFROM nginx:1.25\n`;
  const deps = checks.parseManifestDeps("Dockerfile", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ["nginx", "node", "python"]);
  assert.ok(deps.every((d) => d.type === "docker"));
});

test("parseManifestDeps: Dockerfile.dev / Dockerfile.prod", () => {
  const content = `FROM golang:1.21\n`;
  const deps = checks.parseManifestDeps("Dockerfile.prod", content);
  assert.strictEqual(deps.length, 1);
  assert.strictEqual(deps[0].name, "golang");
});

test("parseManifestDeps: Dockerfile FROM scratch / FROM image:latest — skip (нет точной version)", () => {
  const content = `FROM scratch\nFROM node:latest\nFROM python\n`;
  const deps = checks.parseManifestDeps("Dockerfile", content);
  // scratch — нет version. latest — placeholder, не version. Без tag — нет version.
  assert.deepStrictEqual(deps, []);
});

test("parseManifestDeps: .nvmrc", () => {
  const deps = checks.parseManifestDeps(".nvmrc", "20.10.0\n");
  assert.deepStrictEqual(deps, [
    { type: "runtime", name: "node", version: "20.10.0" },
  ]);
});

test("parseManifestDeps: .python-version", () => {
  const deps = checks.parseManifestDeps(".python-version", "3.12\n");
  assert.deepStrictEqual(deps, [
    { type: "runtime", name: "python", version: "3.12" },
  ]);
});

test("parseManifestDeps: .tool-versions (asdf)", () => {
  const content = `nodejs 20.10.0\npython 3.12.1\nruby 3.2.0\n# comment\n`;
  const deps = checks.parseManifestDeps(".tool-versions", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ["nodejs", "python", "ruby"]);
  assert.ok(deps.every((d) => d.type === "runtime"));
});

test("parseManifestDeps: GitHub Actions workflow uses:", () => {
  const content = `name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v3\n      - uses: actions/setup-node@v4\n      - uses: docker/build-push-action@v5\n      - uses: ./.github/actions/local  # local action — skip\n`;
  const deps = checks.parseManifestDeps(".github/workflows/ci.yml", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, [
    "actions/checkout",
    "actions/setup-node",
    "docker/build-push-action",
  ]);
  assert.ok(deps.every((d) => d.type === "gh-action"));
});

test("parseManifestDeps: возвращает [] для не-manifest файлов", () => {
  assert.deepStrictEqual(checks.parseManifestDeps("src/foo.ts", "x"), []);
  assert.deepStrictEqual(checks.parseManifestDeps("README.md", "x"), []);
  assert.deepStrictEqual(checks.parseManifestDeps("config.yml", "x"), []);
});

test("parseManifestDeps: пустой / null content", () => {
  assert.deepStrictEqual(checks.parseManifestDeps("package.json", ""), []);
  assert.deepStrictEqual(checks.parseManifestDeps("package.json", null), []);
});

test("parseManifestDeps: requirements.txt с extras и markers", () => {
  const content = `requests[security]>=2.31.0\nuvicorn[standard]==0.24.0; python_version >= "3.8"\n`;
  const deps = checks.parseManifestDeps("requirements.txt", content);
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ["requests", "uvicorn"]);
});

test("findVersionLookups: npm view / npm info / npm show", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "npm view react version" },
          },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "npm info next" },
          },
        ],
      },
    },
  ];
  const map = checks.findVersionLookups(lines);
  assert.ok(map.npm.has("react"));
  assert.ok(map.npm.has("next"));
});

test("findVersionLookups: pip index versions / pip show", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "pip index versions django" },
          },
        ],
      },
    },
  ];
  const map = checks.findVersionLookups(lines);
  assert.ok(map.pip.has("django"));
});

test("findVersionLookups: cargo search / go list -m -versions", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "cargo search serde --limit 1" },
          },
          {
            type: "tool_use",
            name: "Bash",
            input: {
              command: "go list -m -versions golang.org/x/sync",
            },
          },
        ],
      },
    },
  ];
  const map = checks.findVersionLookups(lines);
  assert.ok(map.cargo.has("serde"));
  assert.ok(map.go.has("golang.org/x/sync"));
});

test("findVersionLookups: WebFetch на endoflife.date / nodejs.org → runtime", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "WebFetch",
            input: { url: "https://endoflife.date/api/nodejs.json" },
          },
        ],
      },
    },
  ];
  const map = checks.findVersionLookups(lines);
  // 'nodejs' — нормализуется в 'node' для соответствия type='runtime', name='node'
  assert.ok(map.runtime.has("node") || map.runtime.has("nodejs"));
});

test("findVersionLookups: WebFetch registry.npmjs.org → npm", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "WebFetch",
            input: { url: "https://registry.npmjs.org/react/latest" },
          },
        ],
      },
    },
  ];
  const map = checks.findVersionLookups(lines);
  assert.ok(map.npm.has("react"));
});

test("findVersionLookups: gh api releases/latest → gh-action", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: {
              command: "gh api repos/actions/checkout/releases/latest",
            },
          },
        ],
      },
    },
  ];
  const map = checks.findVersionLookups(lines);
  assert.ok(map["gh-action"].has("actions/checkout"));
});

test("findVersionLookups: docker hub WebFetch → docker", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "WebFetch",
            input: { url: "https://hub.docker.com/_/node" },
          },
        ],
      },
    },
  ];
  const map = checks.findVersionLookups(lines);
  assert.ok(map.docker.has("node"));
});

test("getDepsWithoutLookup: возвращает только deps без lookup", () => {
  const deps = [
    { type: "npm", name: "react", version: "^18" },
    { type: "npm", name: "next", version: "^13" },
    { type: "pip", name: "django", version: "==4.2" },
  ];
  const map = {
    npm: new Set(["react"]),
    pip: new Set(["django"]),
    cargo: new Set(),
    go: new Set(),
    docker: new Set(),
    "gh-action": new Set(),
    runtime: new Set(),
  };
  const missing = checks.getDepsWithoutLookup(deps, map);
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].name, "next");
});

test("getDepsWithoutLookup: latest / * версии не требуют lookup", () => {
  const deps = [
    { type: "npm", name: "x", version: "latest" },
    { type: "npm", name: "y", version: "*" },
    { type: "npm", name: "z", version: "^1.2.3" },
  ];
  const empty = {
    npm: new Set(),
    pip: new Set(),
    cargo: new Set(),
    go: new Set(),
    docker: new Set(),
    "gh-action": new Set(),
    runtime: new Set(),
  };
  const missing = checks.getDepsWithoutLookup(deps, empty);
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].name, "z");
});

test("getDepsWithoutLookup: case-insensitive matching", () => {
  const deps = [{ type: "npm", name: "React", version: "^18" }];
  const map = {
    npm: new Set(["react"]),
    pip: new Set(),
    cargo: new Set(),
    go: new Set(),
    docker: new Set(),
    "gh-action": new Set(),
    runtime: new Set(),
  };
  const missing = checks.getDepsWithoutLookup(deps, map);
  assert.strictEqual(missing.length, 0);
});

test("getDepsWithoutLookup: ReDoS-regression на _LOOSE_VERSION_RE (pathological version)", () => {
  // Атака: `>=0` + `.0`*N + хвост заставляли regex `(\.0)*(\.0)*` уходить в
  // catastrophic backtracking. Теперь `(?:\.0)*` (один star) — линейно.
  const pathological = ">=0" + ".0".repeat(10000) + "!";
  const deps = [{ type: "npm", name: "x", version: pathological }];
  const empty = {
    npm: new Set(),
    pip: new Set(),
    cargo: new Set(),
    go: new Set(),
    docker: new Set(),
    "gh-action": new Set(),
    runtime: new Set(),
  };
  const t0 = Date.now();
  const missing = checks.getDepsWithoutLookup(deps, empty);
  const elapsed = Date.now() - t0;
  // Раньше при 10K точек уходило в десятки секунд. Cap ставлю с большим запасом.
  assert.ok(elapsed < 200, `_LOOSE_VERSION_RE снова медленный: ${elapsed}ms`);
  // Pathological version НЕ должен скипаться (это не loose) — должен попасть в missing.
  assert.strictEqual(missing.length, 1);
});

test("findVersionLookups: pnpm view / yarn info / bun view / docker pull", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "pnpm view react version" },
          },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "yarn info next" },
          },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "bun view svelte version" },
          },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "docker pull node:20-alpine" },
          },
        ],
      },
    },
  ];
  const map = checks.findVersionLookups(lines);
  assert.ok(map.npm.has("react"));
  assert.ok(map.npm.has("next"));
  assert.ok(map.npm.has("svelte"));
  assert.ok(map.docker.has("node"));
});

test("collectManifestDepsFromEdits: extracts deps только из Edit/Write/MultiEdit content", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: {
              file_path: "/proj/package.json",
              new_string: `"react": "^18.0.0",\n"next": "^13.4.0"`,
            },
          },
          {
            type: "tool_use",
            name: "Write",
            input: {
              file_path: "/proj/Dockerfile",
              content: `FROM node:18-alpine\n`,
            },
          },
        ],
      },
    },
  ];
  const deps = checks.collectManifestDepsFromEdits(lines);
  const names = deps.map((d) => d.name).sort();
  assert.ok(names.includes("react"));
  assert.ok(names.includes("next"));
  assert.ok(names.includes("node"));
});

// ────────────────────────────────────────────────────────────────────────────
// Триггер M: render-verify
// ────────────────────────────────────────────────────────────────────────────

test("isRenderVerifyCmd: render-класс — браузер и curl localhost", () => {
  assert.ok(checks.isRenderVerifyCmd("curl -s http://localhost:3000/app"));
  assert.ok(checks.isRenderVerifyCmd("curl http://127.0.0.1:8080/"));
  assert.ok(checks.isRenderVerifyCmd("wget -qO- http://0.0.0.0:3000"));
  assert.ok(checks.isRenderVerifyCmd("npx playwright test e2e/smoke.spec.ts"));
  assert.ok(
    checks.isRenderVerifyCmd(
      "npx playwright screenshot http://localhost:3000 out.png",
    ),
  );
  assert.ok(checks.isRenderVerifyCmd("node render.js # puppeteer goto"));
  assert.ok(
    checks.isRenderVerifyCmd(
      "chromium --headless --dump-dom http://localhost:3000",
    ),
  );
  // cypress — реальный браузерный рендер (консистентность с триггером E)
  assert.ok(checks.isRenderVerifyCmd("npx cypress run --spec e2e/a.cy.ts"));
  assert.ok(checks.isRenderVerifyCmd("cypress open"));
  // НЕ render: unit-раннеры и внешний https
  assert.ok(!checks.isRenderVerifyCmd("npx vitest run"));
  assert.ok(!checks.isRenderVerifyCmd("jest --findRelatedTests src/Card.tsx"));
  assert.ok(!checks.isRenderVerifyCmd("curl -s https://example.com/health"));
  assert.ok(!checks.isRenderVerifyCmd("npm test"));
  // многострочная команда: «localhost» в ДРУГОЙ строке не засчитывается
  assert.ok(
    !checks.isRenderVerifyCmd(
      "curl -s https://staging.example.com/health\nnpm run build\n# works on localhost too",
    ),
  );
  assert.ok(!checks.isRenderVerifyCmd(""));
  assert.ok(!checks.isRenderVerifyCmd(null));
});

test("stripBlockComments: посимвольный O(n), безопасен на adversarial", () => {
  assert.strictEqual(checks.stripBlockComments("a /* b */ c"), "a  c");
  assert.strictEqual(checks.stripBlockComments("/* x */y/* z */"), "y");
  // незакрытый блок-комментарий съедает до конца ФАЙЛА, без зависания
  assert.strictEqual(checks.stripBlockComments("a /* никогда не закрыт"), "a ");
  assert.strictEqual(checks.stripBlockComments("a /* x\nb"), "a ");
  // adversarial: тысячи незакрытых `/*` — должен отработать мгновенно (O(n))
  const adversarial = "/*".repeat(50_000) + "x";
  const t0 = Date.now();
  checks.stripBlockComments(adversarial);
  assert.ok(Date.now() - t0 < 1000, "stripBlockComments квадратичен?");
  assert.strictEqual(checks.stripBlockComments(""), "");
});

test("stripBlockComments: state-machine — `/*` в line-comment/строке НЕ открывает блок", () => {
  // `//`-комментарий с wildcard-путём не съедает код после него (обход type-only exempt)
  const src =
    "// note: paths like /api/* are wildcards\nexport function Card() { return 1; }\n";
  const out = checks.stripBlockComments(src);
  assert.ok(out.includes("export function Card()"), `съеден код: ${out}`);
  // `/*` внутри строкового литерала — строка сохраняется как есть
  assert.strictEqual(
    checks.stripBlockComments('const g = "/*not a comment*/";'),
    'const g = "/*not a comment*/";',
  );
  // line-comment стрипается, перенос строки сохраняется
  assert.strictEqual(checks.stripBlockComments("a // tail\nb"), "a \nb");
  // escape внутри строки не ломает состояние
  assert.strictEqual(
    checks.stripBlockComments('s = "a\\"/*x"; y'),
    's = "a\\"/*x"; y',
  );
});

test("isRenderVerifyCmd: браузерные раннеры — render; jsdom — нет", () => {
  assert.ok(checks.isRenderVerifyCmd("npx vitest run --browser=chromium"));
  assert.ok(checks.isRenderVerifyCmd("npx cypress run --component"));
  assert.ok(!checks.isRenderVerifyCmd("npx vitest run"));
});

test("isTokenOnlyCss: @media/@supports-обёртка и attr-селектор токенов — exempt", () => {
  assert.ok(
    checks.isTokenOnlyCss(
      "@media (prefers-color-scheme: dark) {\n:root {\n--bg: #000;\n}\n}\n",
    ),
  );
  assert.ok(
    checks.isTokenOnlyCss(':root, [data-theme="dark"] {\n--bg: #000;\n}\n'),
  );
  // @media с реальными правилами — не exempt
  assert.ok(
    !checks.isTokenOnlyCss("@media print {\n.card { display: none; }\n}\n"),
  );
});

test("isRenderExemptFrontendFile: confinement — файл вне repoRoot не читается", () => {
  const dir = tmp();
  const outside = tmp();
  writeFile(outside, "types.tsx", "export interface X { a: string }\n");
  // абсолютный путь вне repoRoot → не exempt, даже если файл сам по себе type-only
  assert.ok(
    !checks.isRenderExemptFrontendFile(path.join(outside, "types.tsx"), dir),
  );
  // тот же контент внутри repoRoot → exempt (санити, что дело именно в confinement)
  writeFile(dir, "types.tsx", "export interface X { a: string }\n");
  assert.ok(
    checks.isRenderExemptFrontendFile(path.join(dir, "types.tsx"), dir),
  );
});

test("hasMutatingHandler: мутирующие сигнатуры — да; read-only/отсутствующий — нет", () => {
  const dir = tmp();
  const w = (rel, body) => (writeFile(dir, rel, body), rel);
  // Next.js app router
  assert.ok(
    checks.hasMutatingHandler(
      w("app/api/users/route.ts", "export async function DELETE(req) {}\n"),
      dir,
    ),
  );
  // Express-стиль
  assert.ok(
    checks.hasMutatingHandler(
      w("src/routes/orders.ts", "router.post('/orders', createOrder);\n"),
      dir,
    ),
  );
  // Rails destroy
  assert.ok(
    checks.hasMutatingHandler(
      w("app/controllers/users_controller.rb", "def destroy\nend\n"),
      dir,
    ),
  );
  // AdonisJS resource-метод
  assert.ok(
    checks.hasMutatingHandler(
      w(
        "app/controllers/items_controller.ts",
        "export default class ItemsController { async destroy({ params }) {} }\n",
      ),
      dir,
    ),
  );
  // read-only контроллер — нет сигнала
  assert.ok(
    !checks.hasMutatingHandler(
      w(
        "app/controllers/posts_controller.ts",
        "export default class PostsController { async index() {} async show() {} }\n",
      ),
      dir,
    ),
  );
  // мутирующая сигнатура в комментарии — стрипается, сигнала нет
  assert.ok(
    !checks.hasMutatingHandler(
      w(
        "app/controllers/notes_controller.ts",
        "// TODO: router.delete('/notes')\nexport default class NotesController { async index() {} }\n",
      ),
      dir,
    ),
  );
  // отсутствующий файл — нет сигнала (решает path-детект)
  assert.ok(!checks.hasMutatingHandler("app/controllers/nope.ts", dir));
});

test("isTokenOnlyCss: только токены — exempt, любые правила — нет", () => {
  assert.ok(
    checks.isTokenOnlyCss(":root {\n  --brand: #fff;\n  --gap: 8px;\n}\n"),
  );
  assert.ok(
    checks.isTokenOnlyCss("/* palette */\n$brand: #fff;\n$gap: 8px;\n"),
  );
  assert.ok(
    checks.isTokenOnlyCss('@import "./base.css";\n:root {\n--x: 1;\n}'),
  );
  // однострочные комментарии (SCSS/LESS) и LESS-переменные — тоже токен-файл
  assert.ok(checks.isTokenOnlyCss("// Color tokens\n$brand: #f00;\n"));
  assert.ok(checks.isTokenOnlyCss("@brand-color: #f00;\n@gap: 8px;\n"));
  // НЕ token-only: обычные правила / свойства / at-rule с блоком
  assert.ok(!checks.isTokenOnlyCss(".card { color: red; }"));
  assert.ok(!checks.isTokenOnlyCss(":root {\n  --x: 1;\n  color: red;\n}"));
  assert.ok(!checks.isTokenOnlyCss("@media (max-width: 600px) {\n}\n"));
  // пустой / без единого токена — не exempt (нечего исключать)
  assert.ok(!checks.isTokenOnlyCss(""));
  assert.ok(!checks.isTokenOnlyCss(":root {\n}\n"));
  // ReDoS-guard: adversarial длинная строка отклоняется мгновенно
  const evilLine = ":root" + " ".repeat(100_000) + "!";
  const t0css = Date.now();
  assert.ok(!checks.isTokenOnlyCss(evilLine));
  assert.ok(
    Date.now() - t0css < 500,
    "isTokenOnlyCss квадратичен на длинной строке",
  );
});

test("isRenderExemptFrontendFile: type-only/token-only/@generated exempt, остальное — нет", () => {
  const dir = tmp();
  // type-only .tsx
  const typesTsx = writeFile(
    dir,
    "src/types.tsx",
    "export interface CardProps { title: string }\n",
  );
  assert.ok(checks.isRenderExemptFrontendFile(typesTsx, dir));
  // .tsx с рендерящей логикой
  const cardTsx = writeFile(
    dir,
    "src/Card.tsx",
    "export function Card() { return <div>hi</div>; }\n",
  );
  assert.ok(!checks.isRenderExemptFrontendFile(cardTsx, dir));
  // token-only css
  const tokensCss = writeFile(
    dir,
    "src/tokens.css",
    ":root {\n--b: #fff;\n}\n",
  );
  assert.ok(checks.isRenderExemptFrontendFile(tokensCss, dir));
  // css с правилами
  const cardCss = writeFile(dir, "src/card.css", ".card { color: red; }\n");
  assert.ok(!checks.isRenderExemptFrontendFile(cardCss, dir));
  // @generated
  const genVue = writeFile(
    dir,
    "src/Gen.vue",
    "<!-- @generated -->\n<template><div/></template>\n",
  );
  assert.ok(checks.isRenderExemptFrontendFile(genVue, dir));
  // презентационный SFC — НЕ exempt (визуал именно там)
  const plainVue = writeFile(
    dir,
    "src/Plain.vue",
    "<template><div>hi</div></template>\n",
  );
  assert.ok(!checks.isRenderExemptFrontendFile(plainVue, dir));
  // несуществующий файл → fail toward требования (не exempt)
  assert.ok(
    !checks.isRenderExemptFrontendFile(path.join(dir, "nope.tsx"), dir),
  );
  // директория → не exempt
  assert.ok(!checks.isRenderExemptFrontendFile(dir, dir));
});

// ────────────────────────────────────────────────────────────────────────────
// findTestByImportScan: fallback триггера D — централизованные спеки,
// именованные по фиче, засчитываются через grep импортов (кейс ERP_NEW)
// ────────────────────────────────────────────────────────────────────────────

test("findTestByImportScan: находит спек по Adonis-алиасу #controllers/...", () => {
  const dir = tmp();
  writeFile(dir, "apps/api/package.json", "{}");
  writeFile(dir, "apps/api/app/controllers/auth_controller.ts", "export {}");
  writeFile(
    dir,
    "apps/api/tests/unit/auth_cookies.spec.ts",
    "import AuthController from '#controllers/auth_controller'\ntest('x', () => {})",
  );
  const found = checks.findTestByImportScan(
    "apps/api/app/controllers/auth_controller.ts",
    dir,
  );
  assert.strictEqual(
    found,
    path.join("apps", "api", "tests", "unit", "auth_cookies.spec.ts"),
  );
});

test("findTestByImportScan: находит по относительному пути с расширением", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export {}");
  writeFile(
    dir,
    "tests/unit/step_up.spec.ts",
    "import { calc } from '../../app/services/billing.js'\n",
  );
  const found = checks.findTestByImportScan("app/services/billing.ts", dir);
  assert.strictEqual(found, path.join("tests", "unit", "step_up.spec.ts"));
});

test("findTestByImportScan: находит по CJS require без расширения", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "src/services/billing.js", "module.exports = {}");
  writeFile(
    dir,
    "tests/checkout_flow.test.js",
    "const billing = require('../src/services/billing')\n",
  );
  const found = checks.findTestByImportScan("src/services/billing.js", dir);
  assert.ok(found);
});

test("findTestByImportScan: находит по vi.mock-строке", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/middleware/step_up.ts", "export {}");
  writeFile(
    dir,
    "tests/unit/session_flow.spec.ts",
    "vi.mock('#middleware/step_up')\n",
  );
  const found = checks.findTestByImportScan("app/middleware/step_up.ts", dir);
  assert.ok(found);
});

test("findTestByImportScan: Python from-import в централизованном тесте", () => {
  const dir = tmp();
  writeFile(dir, "pyproject.toml", "[project]");
  writeFile(dir, "app/services/billing.py", "x = 1");
  writeFile(
    dir,
    "tests/test_checkout_flow.py",
    "from app.services.billing import calc\n",
  );
  const found = checks.findTestByImportScan("app/services/billing.py", dir);
  assert.ok(found);
});

test("findTestByImportScan: null без упоминания источника", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export {}");
  writeFile(
    dir,
    "tests/unit/other.spec.ts",
    "import { x } from '../../app/services/other'\n",
  );
  assert.strictEqual(
    checks.findTestByImportScan("app/services/billing.ts", dir),
    null,
  );
});

test("findTestByImportScan: упоминание вне import-строки не считается", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/controllers/auth_controller.ts", "export {}");
  writeFile(
    dir,
    "tests/unit/misc.spec.ts",
    "test('kind', () => { expect(kind).toBe('auth_controller') })\n",
  );
  assert.strictEqual(
    checks.findTestByImportScan("app/controllers/auth_controller.ts", dir),
    null,
  );
});

test("findTestByImportScan: подстрочный матч чужого имени не считается", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/controllers/auth_controller.ts", "export {}");
  writeFile(
    dir,
    "tests/unit/reauth.spec.ts",
    "import Re from '#controllers/reauth_controller'\n",
  );
  assert.strictEqual(
    checks.findTestByImportScan("app/controllers/auth_controller.ts", dir),
    null,
  );
});

test("findTestByImportScan: не-спековые файлы в tests/ не считаются", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export {}");
  writeFile(
    dir,
    "tests/helpers.ts",
    "import { calc } from '../app/services/billing'\n",
  );
  assert.strictEqual(
    checks.findTestByImportScan("app/services/billing.ts", dir),
    null,
  );
});

test("findTestByImportScan: index.ts матчится по имени родительской диры", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "src/cart/index.ts", "export {}");
  writeFile(
    dir,
    "tests/unit/shopping.spec.ts",
    "import cart from '../../src/cart'\n",
  );
  const found = checks.findTestByImportScan("src/cart/index.ts", dir);
  assert.ok(found);
});

test("findTestByImportScan: index.ts с generic-родителем (src) не сканируется", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "src/index.ts", "export {}");
  writeFile(dir, "tests/unit/app.spec.ts", "import app from '../../src'\n");
  assert.strictEqual(checks.findTestByImportScan("src/index.ts", dir), null);
});

test("findTestByImportScan: кеш — повторный вызов не перечитывает спеки", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/a.ts", "export {}");
  writeFile(dir, "app/b.ts", "export {}");
  writeFile(dir, "tests/unit/feature.spec.ts", "import a from '../../app/a'\n");
  const cache = {};
  const first = checks.findTestByImportScan("app/a.ts", dir, cache);
  assert.ok(first);
  const readsAfterFirst = cache.filesRead;
  assert.ok(readsAfterFirst >= 1);
  const second = checks.findTestByImportScan("app/b.ts", dir, cache);
  assert.strictEqual(second, null);
  assert.strictEqual(cache.filesRead, readsAfterFirst);
});

test("findTestByImportScan: кап на число прочитанных файлов за прогон", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export {}");
  for (let i = 0; i < 210; i++) {
    writeFile(
      dir,
      `tests/unit/f${String(i).padStart(3, "0")}.spec.ts`,
      "// no imports\n",
    );
  }
  const cache = {};
  assert.strictEqual(
    checks.findTestByImportScan("app/services/billing.ts", dir, cache),
    null,
  );
  assert.ok(cache.filesRead <= 200, `filesRead=${cache.filesRead}`);
});

test("existsInsideRepo: внутри+существует / удалён / вне repoRoot / относительный / мусор", () => {
  const dir = tmp();
  const inside = writeFile(dir, "src/a.ts", "x");
  assert.strictEqual(checks.existsInsideRepo(inside, dir), true);
  assert.strictEqual(checks.existsInsideRepo("src/a.ts", dir), true); // относительный
  fs.rmSync(inside);
  assert.strictEqual(checks.existsInsideRepo(inside, dir), false); // удалён
  const outside = writeFile(tmp(), "b.js", "x");
  assert.strictEqual(checks.existsInsideRepo(outside, dir), false); // вне repoRoot
  assert.strictEqual(checks.existsInsideRepo(dir, dir), false); // сам корень
  assert.strictEqual(checks.existsInsideRepo(null, dir), false);
  assert.strictEqual(checks.existsInsideRepo("src/a.ts", null), false);
});

// ── rankSpecCandidates: релевантностный порядок чтения (баг-репорт: кэп 200
// отрезал алфавитно-хвостовой покрывающий спек → ложный D) ──────────────────

test("rankSpecCandidates: спек с basename источника в имени — первым", () => {
  const ranked = checks.rankSpecCandidates(
    ["/r/tests/unit/other.spec.ts", "/r/tests/unit/billing.spec.ts"],
    "app/services/billing.ts",
  );
  assert.strictEqual(ranked[0], "/r/tests/unit/billing.spec.ts");
});

test("rankSpecCandidates: parent-сегмент пути поднимает выше нейтральных", () => {
  const ranked = checks.rankSpecCandidates(
    [
      "/r/tests/unit/controllers/x.spec.ts",
      "/r/tests/unit/validators/y.spec.ts",
    ],
    "app/validators/auth_validator.ts",
  );
  assert.strictEqual(ranked[0], "/r/tests/unit/validators/y.spec.ts");
});

test("rankSpecCandidates: токен basename (auth_validator → auth) даёт сигнал", () => {
  const ranked = checks.rankSpecCandidates(
    ["/r/tests/unit/zzz.spec.ts", "/r/tests/unit/auth_flow.spec.ts"],
    "app/validators/auth_validator.ts",
  );
  assert.strictEqual(ranked[0], "/r/tests/unit/auth_flow.spec.ts");
});

test("rankSpecCandidates: tie → исходный порядок, вход не мутируется", () => {
  const input = ["/r/tests/b.spec.ts", "/r/tests/a.spec.ts"];
  const ranked = checks.rankSpecCandidates(input, "app/services/billing.ts");
  assert.deepStrictEqual(ranked, input);
  assert.deepStrictEqual(input, ["/r/tests/b.spec.ts", "/r/tests/a.spec.ts"]);
});

test("rankSpecCandidates: generic basename (index) ранжирует по родителю", () => {
  const ranked = checks.rankSpecCandidates(
    ["/r/tests/unit/checkout.spec.ts", "/r/tests/unit/cart.spec.ts"],
    "src/cart/index.ts",
  );
  assert.strictEqual(ranked[0], "/r/tests/unit/cart.spec.ts");
});

test("rankSpecCandidates: короткий base (db) не даёт шумного подстрочного сигнала", () => {
  // 'db' ⊂ 'redblue' — без гейта длины redblue.spec.ts ложно поднялся бы
  const input = ["/r/tests/redblue.spec.ts", "/r/tests/aaa.spec.ts"];
  const ranked = checks.rankSpecCandidates(input, "app/billing/db.ts");
  assert.deepStrictEqual(ranked, input);
});

// ── регресс баг-репорта: покрывающий спек в алфавитном хвосте за кэпом ───────

test("findTestByImportScan: хвостовой спек за кэпом находится благодаря ранжированию", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/validators/auth_validator.ts", "export {}");
  // 205 алфавитно-ранних наполнителей (controllers < validators)
  for (let i = 0; i < 205; i++) {
    const n = String(i).padStart(3, "0");
    writeFile(
      dir,
      `tests/unit/controllers/spec_${n}.spec.ts`,
      `import { t } from '#controllers/thing${n}'\n`,
    );
  }
  // покрывающий спек — имя по фиче (репро репорта), позиция в списке > 200
  writeFile(
    dir,
    "tests/unit/validators/auth_flow.spec.ts",
    "import { authValidator } from '#validators/auth_validator'\n",
  );
  const cache = {};
  const found = checks.findTestByImportScan(
    "app/validators/auth_validator.ts",
    dir,
    cache,
  );
  assert.strictEqual(
    found,
    path.join("tests", "unit", "validators", "auth_flow.spec.ts"),
  );
  // ранжирование обязано найти его задолго до кэпа
  assert.ok(cache.filesRead < 200, `filesRead=${cache.filesRead}`);
});

// ── cache.lastTruncated: обрыв по бюджету различим от «дочитал, матча нет» ───

test("findTestByImportScan: lastTruncated=true при обрыве без матча", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export {}");
  for (let i = 0; i < 210; i++) {
    writeFile(
      dir,
      `tests/unit/f${String(i).padStart(3, "0")}.spec.ts`,
      "import { x } from '#other/thing'\n",
    );
  }
  const cache = {};
  assert.strictEqual(
    checks.findTestByImportScan("app/services/billing.ts", dir, cache),
    null,
  );
  assert.strictEqual(cache.lastTruncated, true);
});

test("findTestByImportScan: lastTruncated=false когда список дочитан", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export {}");
  writeFile(dir, "tests/unit/other.spec.ts", "import { x } from '#other/y'\n");
  const cache = {};
  assert.strictEqual(
    checks.findTestByImportScan("app/services/billing.ts", dir, cache),
    null,
  );
  assert.strictEqual(cache.lastTruncated, false);
});

// ── env-ручка MAIN_SKILL_IMPORT_SCAN_MAX_FILES ───────────────────────────────

test("importScanMaxFiles: дефолт 200, валидное значение, гейты мусора и капа", () => {
  const KEY = "MAIN_SKILL_IMPORT_SCAN_MAX_FILES";
  const prev = process.env[KEY];
  try {
    delete process.env[KEY];
    assert.strictEqual(checks.importScanMaxFiles(), 200);
    process.env[KEY] = "300";
    assert.strictEqual(checks.importScanMaxFiles(), 300);
    process.env[KEY] = "abc";
    assert.strictEqual(checks.importScanMaxFiles(), 200);
    process.env[KEY] = "-5";
    assert.strictEqual(checks.importScanMaxFiles(), 200);
    process.env[KEY] = "0";
    assert.strictEqual(checks.importScanMaxFiles(), 200);
    process.env[KEY] = "999999999";
    assert.strictEqual(checks.importScanMaxFiles(), 10000);
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
});

test("findTestByImportScan: env-ручка поднимает лимит чтений", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export {}");
  for (let i = 0; i < 210; i++) {
    writeFile(
      dir,
      `tests/unit/f${String(i).padStart(3, "0")}.spec.ts`,
      "import { x } from '#other/thing'\n",
    );
  }
  // имя и папка намеренно нерелевантны — ранжирование не спасает,
  // спек алфавитно последний (z > f) → позиция 211
  writeFile(
    dir,
    "tests/unit/zzz_flow.spec.ts",
    "import { calc } from '#services/billing'\n",
  );
  assert.strictEqual(
    checks.findTestByImportScan("app/services/billing.ts", dir, {}),
    null,
  );
  const KEY = "MAIN_SKILL_IMPORT_SCAN_MAX_FILES";
  const prev = process.env[KEY];
  try {
    process.env[KEY] = "300";
    const cache = {};
    assert.strictEqual(
      checks.findTestByImportScan("app/services/billing.ts", dir, cache),
      path.join("tests", "unit", "zzz_flow.spec.ts"),
    );
    assert.strictEqual(cache.lastTruncated, false);
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
});

test("findTestByImportScan: lastTruncated=true когда кап СПИСКА обрезал кандидатов (cap≥400)", () => {
  // Регресс ревью: при env-cap ≥ 400 maxList === cap → список кандидатов
  // обрезан ровно до бюджета, цикл чтения дочитывает его целиком без break —
  // обрыв должен репортиться флагом обрезания СПИСКА, не только бюджета чтений.
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export {}");
  for (let i = 0; i < 450; i++) {
    writeFile(
      dir,
      `tests/unit/f${String(i).padStart(3, "0")}.spec.ts`,
      "import { x } from '#other/thing'\n",
    );
  }
  const KEY = "MAIN_SKILL_IMPORT_SCAN_MAX_FILES";
  const prev = process.env[KEY];
  try {
    process.env[KEY] = "400";
    const cache = {};
    assert.strictEqual(
      checks.findTestByImportScan("app/services/billing.ts", dir, cache),
      null,
    );
    assert.strictEqual(cache.lastTruncated, true);
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
});

test("rankSpecCandidates: гигантский base/parent не скорится (кап длины), вход цел", () => {
  const files = ["/r/tests/a.spec.ts", "/r/tests/b.spec.ts"];
  const hugeParent = "p".repeat(1_000_000);
  const ranked = checks.rankSpecCandidates(
    files,
    `app/${hugeParent}/billing.ts`,
  );
  assert.deepStrictEqual(ranked, files);
  const hugeBase = "b".repeat(1_000_000);
  const ranked2 = checks.rankSpecCandidates(files, `app/x/${hugeBase}.ts`);
  assert.deepStrictEqual(ranked2, files);
});

test("findTestByImportScan: спек-симлинк наружу репо не читается", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/services/billing.ts", "export {}");
  const outside = path.join(tmp(), "outside.spec.ts");
  fs.writeFileSync(outside, "import b from '../../app/services/billing'\n");
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(dir, "tests", "evil.spec.ts"));
  } catch {
    return; // среда без прав на symlink — тест неприменим
  }
  assert.strictEqual(
    checks.findTestByImportScan("app/services/billing.ts", dir),
    null,
  );
});

test("findTestByImportScan: одноимённый файл чужого модуля НЕ засчитывается", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/billing/db.ts", "export {}");
  writeFile(dir, "app/auth/db.ts", "export {}");
  // Спек покрывает billing/db — auth/db не должен засчитаться по коллизии basename.
  writeFile(
    dir,
    "tests/unit/billing.spec.ts",
    "import db from '../../app/billing/db'\n",
  );
  const foundBilling = checks.findTestByImportScan("app/billing/db.ts", dir);
  assert.ok(foundBilling, "billing/db должен найтись");
  assert.strictEqual(
    checks.findTestByImportScan("app/auth/db.ts", dir),
    null,
    "auth/db не покрыт — коллизия basename не считается",
  );
});

test("findTestByImportScan: голый импорт имени (без пути) засчитывается", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "app/middleware/step_up.ts", "export {}");
  writeFile(dir, "tests/unit/mfa.spec.ts", "vi.mock('step_up')\n");
  assert.ok(checks.findTestByImportScan("app/middleware/step_up.ts", dir));
});

test("findTestByImportScan: ближайший package-root сканируется первым", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "packages/foo/package.json", "{}");
  writeFile(dir, "packages/foo/sub/package.json", "{}");
  writeFile(dir, "packages/foo/sub/src/orders/utils.ts", "export {}");
  // Оба спека импортируют orders/utils — вернуться должен спек ближайшего пакета.
  writeFile(
    dir,
    "packages/foo/tests/far.spec.ts",
    "import u from './sub/src/orders/utils'\n",
  );
  writeFile(
    dir,
    "packages/foo/sub/tests/near.spec.ts",
    "import u from '../src/orders/utils'\n",
  );
  const found = checks.findTestByImportScan(
    "packages/foo/sub/src/orders/utils.ts",
    dir,
  );
  assert.strictEqual(
    found,
    path.join("packages", "foo", "sub", "tests", "near.spec.ts"),
  );
});

test("findTestByImportScan: Python `from pkg import module` засчитывается", () => {
  const dir = tmp();
  writeFile(dir, "pyproject.toml", "[project]");
  writeFile(dir, "app/services/billing.py", "x = 1");
  writeFile(
    dir,
    "tests/test_payments_flow.py",
    "from app.services import billing\n",
  );
  assert.ok(checks.findTestByImportScan("app/services/billing.py", dir));
});

test("findTestByImportScan: Python import из generic-родителя (from src import utils)", () => {
  const dir = tmp();
  writeFile(dir, "pyproject.toml", "[project]");
  writeFile(dir, "src/utils.py", "x = 1");
  writeFile(dir, "tests/test_tooling.py", "from src import helpers, utils\n");
  assert.ok(checks.findTestByImportScan("src/utils.py", dir));
});

test("findTestByImportScan: гигантский basename из транскрипта → null без throw", () => {
  const dir = tmp();
  writeFile(dir, "package.json", "{}");
  writeFile(dir, "tests/unit/a.spec.ts", "import a from '../../app/a'\n");
  const huge = "app/" + "a".repeat(60001) + ".ts";
  let result;
  assert.doesNotThrow(() => {
    result = checks.findTestByImportScan(huge, dir);
  });
  assert.strictEqual(result, null);
});
