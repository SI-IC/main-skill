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

test("isCodeFile отсеивает конфиги/ассеты", () => {
  assert.ok(checks.isCodeFile("src/foo.ts"));
  assert.ok(checks.isCodeFile("main.py"));
  assert.ok(checks.isCodeFile("cli.go"));
  assert.ok(checks.isCodeFile("app/styles.css"));
  assert.ok(!checks.isCodeFile("plugin.json"));
  assert.ok(!checks.isCodeFile("config.yaml"));
  assert.ok(!checks.isCodeFile("Dockerfile"));
  assert.ok(!checks.isCodeFile("logo.png"));
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
});

test("shouldSkipForTestPairing: wiring/start/bootstrap", () => {
  assert.ok(checks.shouldSkipForTestPairing("start/kernel.ts"));
  assert.ok(checks.shouldSkipForTestPairing("start/routes.ts"));
  assert.ok(checks.shouldSkipForTestPairing("bootstrap/app.ts"));
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
