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
  // boundary: не путать с произвольным префиксом/суффиксом
  assert.ok(!checks.shouldSkipForTestPairing("my-deploy.sh"));
  assert.ok(!checks.shouldSkipForTestPairing("install-deps.sh"));
  // generic ops-имена намеренно НЕ skip-ятся — могут содержать логику.
  assert.ok(!checks.shouldSkipForTestPairing("entrypoint.sh"));
  assert.ok(!checks.shouldSkipForTestPairing("healthcheck.sh"));
  assert.ok(!checks.shouldSkipForTestPairing("run.sh"));
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

test("findE2eFile находит functional-парный", () => {
  const dir = tmp();
  writeFile(dir, "app/controllers/auth_controller.ts", "x");
  writeFile(dir, "tests/functional/auth.spec.ts", 'test("login", () => {})');
  const found = checks.findE2eFile("app/controllers/auth_controller.ts", dir);
  assert.ok(found);
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
