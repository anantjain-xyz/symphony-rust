import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  scanRestrictedSources,
  verifyBoundaries,
  verifyCargoMetadata,
} from "./check-boundaries-lib.mjs";

function policy(overrides = {}) {
  return {
    version: 1,
    packages: {
      core: { allowedInternalDependencies: [] },
      storage: { allowedInternalDependencies: ["core"] },
      worker: { allowedInternalDependencies: ["core", "storage"] },
    },
    restrictedDependencies: { sqlx: ["storage"] },
    sourceRules: [
      {
        id: "direct-sqlx",
        pattern: "\\bsqlx\\s*::",
        allowedPackages: ["storage"],
        message: "direct sqlx use belongs in storage",
      },
      {
        id: "storage-sqlx-construction",
        pattern: "\\bStorageError\\s*::\\s*Sqlx\\b",
        allowedPackages: ["storage"],
        message: "do not disguise non-storage failures",
      },
    ],
    ...overrides,
  };
}

function metadata(root, dependencies = {}, targetPaths = {}) {
  const names = ["core", "storage", "worker"];
  const packages = names.map((name) => ({
    id: `path+file://${root}/${name}#0.0.0`,
    name,
    manifest_path: path.join(root, name, "Cargo.toml"),
    dependencies: (dependencies[name] ?? []).map((dependency) => ({
      name: dependency,
    })),
    targets: (targetPaths[name] ?? ["src/lib.rs"]).map((srcPath) => ({
      src_path: path.join(root, name, srcPath),
    })),
  }));
  return {
    workspace_root: root,
    workspace_members: packages.map((pkg) => pkg.id),
    packages,
  };
}

async function fixtureWorkspace(sources = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "boundary-check-"));
  for (const name of ["core", "storage", "worker"]) {
    await fs.mkdir(path.join(root, name, "src"), { recursive: true });
    await fs.writeFile(path.join(root, name, "Cargo.toml"), `[package]\nname = "${name}"\n`);
    await fs.writeFile(
      path.join(root, name, "src", "lib.rs"),
      sources[name] ?? "pub fn ok() {}\n",
    );
  }
  return root;
}

test("accepts the declared internal DAG and storage ownership", async (t) => {
  const root = await fixtureWorkspace({
    storage: "pub fn query() { let _ = sqlx::query(\"select 1\"); }\n",
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await verifyBoundaries(
    metadata(root, { storage: ["core", "sqlx"], worker: ["core", "storage"] }),
    policy(),
  );

  assert.deepEqual(errors, []);
});

test("rejects unknown packages, forbidden internal edges, and restricted dependencies", () => {
  const root = "/fixture";
  const value = metadata(root, {
    core: ["worker"],
    storage: ["core"],
    worker: ["core", "storage", "sqlx"],
  });
  value.packages.push({
    id: "path+file:///fixture/new-layer#0.0.0",
    name: "new-layer",
    manifest_path: "/fixture/new-layer/Cargo.toml",
    dependencies: [],
  });
  value.workspace_members.push(value.packages.at(-1).id);

  const errors = verifyCargoMetadata(value, policy());

  assert(errors.some((error) => error.includes("new-layer is missing")));
  assert(errors.some((error) => error.includes("core may not depend on internal crate worker")));
  assert(errors.some((error) => error.includes("worker may not declare restricted dependency sqlx")));
});

test("reports forbidden source tokens with deterministic file and line diagnostics", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "fn workspace_error() {",
      "    let _ = StorageError::Sqlx(sqlx::Error::Protocol(\"wrong layer\".into()));",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:2: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
    "worker/src/lib.rs:2: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("ignores forbidden spellings in Rust comments and literals", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "// sqlx::query and StorageError::Sqlx are documentation examples.",
      'const NORMAL: &str = "sqlx::query StorageError::Sqlx";',
      'const RAW: &str = r#"sqlx::query StorageError::Sqlx"#;',
      'const BYTES: &[u8] = br"sqlx::query StorageError::Sqlx";',
      "const CHARACTER: char = ':';",
      "/* sqlx::query /* StorageError::Sqlx */ */",
      'macro_rules! separated { () => { sqlx "not a path" :: query }; }',
      "macro_rules! char_separated { () => { StorageError ':' :: Sqlx }; }",
      "fn borrow<'sqlx>(value: &'sqlx str) -> &'sqlx str { value }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, []);
});

test("detects multiline forbidden paths reached through use aliases", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "use sqlx as database;",
      "use symphony_storage::StorageError as StoreError;",
      "fn wrong() {",
      "    let _ = database",
      "        ::",
      '        query("select 1");',
      "    let _ = StoreError",
      "        ::",
      "        Sqlx(problem);",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:4: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
    "worker/src/lib.rs:7: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("keeps aliases lexical across sibling modules and local item shadowing", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod forbidden {",
      "    use symphony_storage::StorageError as E;",
      "    fn wrong() { let _ = E::Sqlx(problem); }",
      "}",
      "mod sibling {",
      "    enum E { Sqlx }",
      "    fn allowed() { let _ = E::Sqlx; }",
      "}",
      "use symphony_storage::StorageError as OuterError;",
      "fn locally_shadowed() {",
      "    enum OuterError { Sqlx }",
      "    let _ = OuterError::Sqlx;",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:3: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("resolves complete import paths and independent block aliases", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod mocks { pub mod sqlx { pub fn query() {} } }",
      "mod errors { pub enum StorageError { Sqlx } }",
      "use crate::mocks::sqlx as database;",
      "use crate::errors::StorageError as OtherError;",
      "use crate::errors::StorageError;",
      "use crate::mocks::{sqlx::query as mock_query};",
      "use crate::errors::{StorageError::Sqlx as OtherSqlx};",
      "fn allowed() {",
      "    database::query();",
      "    let _ = OtherError::Sqlx;",
      "    let _ = StorageError::Sqlx;",
      "    mock_query();",
      "    let _ = OtherSqlx;",
      "}",
      "fn scoped() {",
      "    {",
      "        use sqlx as database;",
      '        let _ = database::query("select 1");',
      "    }",
      "    {",
      "        use crate::mocks::sqlx as database;",
      "        database::query();",
      "    }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:18: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("detects extern-crate and use aliases written as raw identifiers", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "extern crate sqlx as r#database;",
      "use symphony_storage::StorageError as r#Error;",
      "fn wrong() {",
      '    let _ = r#database::query("select 1");',
      "    let _ = r#Error::Sqlx(problem);",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:4: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
    "worker/src/lib.rs:5: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("detects StorageError variants imported through scoped glob uses", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub enum StorageError { Sqlx } }",
      "mod direct {",
      "    use symphony_storage::StorageError::*;",
      "    fn wrong() { let _ = Sqlx(problem); }",
      "    fn allowed() { let _ = crate::errors::StorageError::Sqlx; }",
      "}",
      "mod grouped {",
      "    use symphony_storage::StorageError::{*};",
      "    fn wrong() { let _ = Sqlx(problem); }",
      "}",
      "mod unrelated {",
      "    use crate::errors::StorageError::*;",
      "    fn allowed() { let _ = Sqlx; }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:4: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:9: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("skips import syntax inside macro definitions", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "macro_rules! scoped_import {",
      "    ($p:path) => {{ use $p; include!($p); }};",
      "}",
      "fn wrong() {",
      '    let _ = sqlx::query("select 1");',
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:5: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("resolves simple and chained Rust type aliases", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub enum StorageError { Sqlx } }",
      "type E = symphony_storage::StorageError;",
      "type Chained = E;",
      "type Parenthesized = ((symphony_storage::StorageError));",
      "fn direct() { let _ = E::Sqlx(problem); }",
      "fn chained() { let _ = Chained::Sqlx(problem); }",
      "fn parenthesized() { let _ = Parenthesized::Sqlx(problem); }",
      "mod unrelated {",
      "    type E = crate::errors::StorageError;",
      "    type Parenthesized = ((crate::errors::StorageError));",
      "    fn allowed() { let _ = E::Sqlx; }",
      "    fn allowed_parenthesized() { let _ = Parenthesized::Sqlx; }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:5: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:6: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:7: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("detects qualified StorageError variant paths", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub enum StorageError { Sqlx } }",
      "use symphony_storage::StorageError as E;",
      "fn direct() { let _ = <symphony_storage::StorageError>::Sqlx(problem); }",
      "fn absolute() { let _ = <::symphony_storage::StorageError>::Sqlx(problem); }",
      "fn aliased() { let _ = <E>::Sqlx(problem); }",
      "fn parenthesized() { let _ = <((symphony_storage::StorageError))>::Sqlx(problem); }",
      "fn allowed() { let _ = <crate::errors::StorageError>::Sqlx; }",
      "fn allowed_parenthesized() { let _ = <((crate::errors::StorageError))>::Sqlx; }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:3: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:4: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:5: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:6: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("recursively scans modules belonging to custom Cargo targets", async (t) => {
  const root = await fixtureWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated", "hidden"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "worker", "Cargo.toml"),
    [
      "[package]",
      'name = "worker"',
      "",
      "[[bin]]",
      'name = "tool"',
      'path = "generated/lib.rs"',
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "lib.rs"),
    ["mod hidden;", "fn main() {}", ""].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "hidden.rs"),
    ["mod deeper;", "pub fn hidden() {}", ""].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "hidden", "deeper.rs"),
    ["pub fn wrong() {", '    let _ = sqlx::query("select 1");', "}", ""].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "unused.rs"),
    'pub fn not_compiled() { let _ = sqlx::query("select 1"); }\n',
  );

  const errors = await scanRestrictedSources(
    metadata(root, {}, { worker: ["src/lib.rs", "generated/lib.rs"] }),
    policy(),
  );

  assert.deepEqual(errors, [
    "worker/generated/hidden/deeper.rs:2: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("recursively scans literal include! sources belonging to Cargo targets", async (t) => {
  const root = await fixtureWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated", "nested"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "worker", "generated", "lib.rs"),
    ['include!("generated.inc");', "fn main() {}", ""].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "generated.inc"),
    'include!["nested/deeper.inc"];\n',
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "nested", "deeper.inc"),
    ["pub fn wrong() {", '    let _ = sqlx::query("select 1");', "}", ""].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "unused.inc"),
    'pub fn not_compiled() { let _ = sqlx::query("select 1"); }\n',
  );

  const errors = await scanRestrictedSources(
    metadata(root, {}, { worker: ["src/lib.rs", "generated/lib.rs"] }),
    policy(),
  );

  assert.deepEqual(errors, [
    "worker/generated/nested/deeper.inc:2: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("preserves bindings across recursively included Rust fragments", async (t) => {
  const root = await fixtureWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated", "nested"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "worker", "generated", "lib.rs"),
    [
      "use symphony_storage::StorageError as Outer;",
      "use symphony_storage::StorageError::*;",
      'include!("nested/bridge.inc");',
      "fn after_include() { let _ = Inner::Sqlx(problem); }",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "nested", "bridge.inc"),
    'include!("shared.inc");\n',
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "nested", "shared.inc"),
    [
      "use symphony_storage::StorageError as Inner;",
      "fn from_outer() { let _ = Outer::Sqlx(problem); }",
      "fn from_glob() { let _ = Sqlx(problem); }",
      "",
    ].join("\n"),
  );

  const errors = await scanRestrictedSources(
    metadata(root, {}, { worker: ["src/lib.rs", "generated/lib.rs"] }),
    policy(),
  );

  assert.deepEqual(errors, [
    "worker/generated/lib.rs:4: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/generated/nested/shared.inc:2: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/generated/nested/shared.inc:3: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("resolves modules from the included fragment's directory", async (t) => {
  const root = await fixtureWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated", "nested"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "worker", "generated", "lib.rs"),
    'include!("nested/items.inc");\n',
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "nested", "items.inc"),
    "mod child;\n",
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "nested", "child.rs"),
    'fn wrong() { let _ = sqlx::query("select 1"); }\n',
  );

  const errors = await scanRestrictedSources(
    metadata(root, {}, { worker: ["src/lib.rs", "generated/lib.rs"] }),
    policy(),
  );

  assert.deepEqual(errors, [
    "worker/generated/nested/child.rs:1: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("fails closed when a custom target module cannot be resolved", async (t) => {
  const root = await fixtureWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated"), { recursive: true });
  await fs.writeFile(
    path.join(root, "worker", "generated", "lib.rs"),
    "mod missing;\n",
  );

  await assert.rejects(
    scanRestrictedSources(
      metadata(root, {}, { worker: ["src/lib.rs", "generated/lib.rs"] }),
      policy(),
    ),
    /cannot resolve Rust module missing/,
  );
});

test("fails closed when a literal include! source cannot be resolved", async (t) => {
  const root = await fixtureWorkspace({
    worker: 'include!("missing.inc");\n',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    scanRestrictedSources(metadata(root), policy()),
    /cannot resolve include! missing\.inc/,
  );
});

test("fails closed for an invalid or cyclic policy", () => {
  const root = "/fixture";
  const cyclic = policy({
    packages: {
      core: { allowedInternalDependencies: ["worker"] },
      storage: { allowedInternalDependencies: ["core"] },
      worker: { allowedInternalDependencies: ["storage"] },
    },
  });

  assert.throws(
    () => verifyCargoMetadata(metadata(root), cyclic),
    /contains a cycle/,
  );
});
