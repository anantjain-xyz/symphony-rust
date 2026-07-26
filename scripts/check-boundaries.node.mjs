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

test("resolves self, super, and crate import roots by module", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub enum StorageError { Sqlx } }",
      "use symphony_storage::StorageError;",
      "mod outer {",
      "    use super::StorageError as FromSuper;",
      "    use crate::StorageError as FromCrate;",
      "    use self::FromSuper as FromSelf;",
      "    fn from_super() { let _ = FromSuper::Sqlx(problem); }",
      "    fn from_crate() { let _ = FromCrate::Sqlx(problem); }",
      "    fn from_self() { let _ = FromSelf::Sqlx(problem); }",
      "    mod nested {",
      "        use super::FromSuper as FromTwoLevels;",
      "        fn wrong() { let _ = FromTwoLevels::Sqlx(problem); }",
      "    }",
      "}",
      "mod unrelated {",
      "    use crate::errors::StorageError as E;",
      "    fn allowed() { let _ = E::Sqlx; }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:12: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:7: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:8: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:9: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("resolves relative imports across module source files", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "use symphony_storage::StorageError;",
      "mod child;",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "worker", "src", "child.rs"),
    [
      "use super::StorageError as FromSuper;",
      "use crate::StorageError as FromCrate;",
      "use self::FromSuper as FromSelf;",
      "fn from_super() { let _ = FromSuper::Sqlx(problem); }",
      "fn from_crate() { let _ = FromCrate::Sqlx(problem); }",
      "fn from_self() { let _ = FromSelf::Sqlx(problem); }",
      "",
    ].join("\n"),
  );

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/child.rs:4: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/child.rs:5: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/child.rs:6: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
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

test("propagates extern-crate aliases into descendant modules", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "extern crate symphony_storage as store;",
      "mod child {",
      "    fn wrong() { let _ = store::StorageError::Sqlx(problem); }",
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

test("resolves extern-crate self aliases through crate-root reexports", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "pub use symphony_storage::StorageError;",
      "extern crate self as facade;",
      "mod child {",
      "    fn wrong() { let _ = facade::StorageError::Sqlx(problem); }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:4: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("tokenizes Unicode Rust identifiers in imports", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub enum StorageError { Sqlx } }",
      "use std::fmt as 格式;",
      "use symphony_storage::StorageError as 存储错误;",
      "fn allowed_unicode() { let _ = 格式::Error; }",
      "fn wrong() { let _ = 存储错误::Sqlx(problem); }",
      "mod unrelated {",
      "    use crate::errors::StorageError as 本地错误;",
      "    fn allowed() { let _ = 本地错误::Sqlx; }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:5: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("honors Cargo dependency renames when normalizing paths", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "fn wrong() { let _ = store::StorageError::Sqlx(problem); }",
      "mod unrelated {",
      "    mod store { pub enum StorageError { Sqlx } }",
      "    fn allowed() { let _ = store::StorageError::Sqlx; }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = metadata(root);
  value.packages
    .find((pkg) => pkg.name === "worker")
    .dependencies.push({ name: "symphony-storage", rename: "store" });

  const errors = await scanRestrictedSources(value, policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:1: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
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

test("resolves named items imported through local module globs", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod local_parent {",
      "    enum StorageError { Sqlx(Problem) }",
      "    mod child {",
      "        use super::*;",
      "        fn allowed() { let _ = StorageError::Sqlx(problem); }",
      "    }",
      "}",
      "mod restricted_parent {",
      "    pub use symphony_storage::StorageError;",
      "    mod child {",
      "        use super::*;",
      "        fn wrong() { let _ = StorageError::Sqlx(problem); }",
      "    }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:12: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("detects grouped StorageError variant imports", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub enum StorageError { Sqlx } }",
      "use symphony_storage::StorageError::{Sqlx as DbFailure};",
      "fn wrong() { let _ = DbFailure(problem); }",
      "mod unrelated {",
      "    use crate::errors::StorageError::{Sqlx as DbFailure};",
      "    fn allowed() { let _ = DbFailure; }",
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

test("does not classify variant imports as constructions", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "use symphony_storage::StorageError::Sqlx;",
      "fn wrong() { let _ = Sqlx(problem); }",
      "mod unused { use symphony_storage::StorageError::Sqlx; }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:2: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
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

test("skips import syntax passed to opaque macro invocations", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "macro_rules! consume { ($($tt:tt)*) => {} }",
      "fn allowed() { consume!(use $path;); }",
      "fn wrong() { let _ = StorageError::Sqlx(problem); }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:3: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("skips import syntax inside attribute token trees", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "#[cfg_attr(any(), arbitrary(use $path;))]",
      "fn allowed() {}",
      "fn wrong() { let _ = StorageError::Sqlx(problem); }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:3: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("resolves fixed imports inside macro definitions", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub enum StorageError { Sqlx } }",
      "macro_rules! fixed_import {",
      "    () => {{",
      "        use symphony_storage::StorageError as E;",
      "        E::Sqlx(problem)",
      "    }};",
      "}",
      "macro_rules! unrelated_import {",
      "    () => {{",
      "        use crate::errors::StorageError as E;",
      "        E::Sqlx",
      "    }};",
      "}",
      "fn invoke() { let _ = (fixed_import!(), unrelated_import!()); }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:14: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:5: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("expands simple macro metavariables before checking variants", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "enum LocalError { Sqlx }",
      "macro_rules! make { ($error:ty) => { <$error>::Sqlx(problem) } }",
      "fn wrong() { let _ = make!(symphony_storage::StorageError); }",
      "fn allowed() { let _ = make!(LocalError); }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:3: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("expands multiple simple macro captures before checking variants", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "enum LocalError { Sqlx }",
      "macro_rules! make { ($error:ty, $value:expr) => { <$error>::Sqlx($value) } }",
      "fn wrong() { let _ = make!(symphony_storage::StorageError, wrap(problem, context)); }",
      "fn allowed() { let _ = make!(LocalError, problem); }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:3: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("expands simple macro arms with literal matcher tokens", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "enum LocalError { Sqlx(Problem) }",
      "macro_rules! make { ($error:ty => $value:expr) => { <$error>::Sqlx($value) } }",
      "fn wrong() { let _ = make!(symphony_storage::StorageError => wrap(problem, context)); }",
      "fn allowed() { let _ = make!(LocalError => problem); }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:3: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("preserves module scopes through local module aliases", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub use symphony_storage::StorageError; }",
      "mod local { pub enum StorageError { Sqlx(Problem) } }",
      "use crate::errors as errs;",
      "use crate::local as local_errors;",
      "fn wrong() { let _ = errs::StorageError::Sqlx(problem); }",
      "fn allowed() { let _ = local_errors::StorageError::Sqlx(problem); }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:5: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
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

test("retains cfg-conditioned import alternatives", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub enum StorageError { Sqlx } }",
      "#[cfg(unix)]",
      "use unix::Backend;",
      "#[cfg(not(unix))]",
      "use portable::Backend;",
      "fn allowed() { Backend::connect(); }",
      "mod mixed {",
      "    #[cfg(unix)]",
      "    use symphony_storage::StorageError as E;",
      "    #[cfg(not(unix))]",
      "    use crate::errors::StorageError as E;",
      "    fn wrong() { let _ = E::Sqlx(problem); }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:12: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("detects qualified and turbofish StorageError variant paths", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "mod errors { pub enum StorageError { Sqlx } }",
      "use symphony_storage::StorageError as E;",
      "fn direct() { let _ = <symphony_storage::StorageError>::Sqlx(problem); }",
      "fn absolute() { let _ = <::symphony_storage::StorageError>::Sqlx(problem); }",
      "fn aliased() { let _ = <E>::Sqlx(problem); }",
      "fn parenthesized() { let _ = <((symphony_storage::StorageError))>::Sqlx(problem); }",
      "fn turbofish() { let _ = symphony_storage::StorageError::<>::Sqlx(problem); }",
      "fn aliased_turbofish() { let _ = E::<>::Sqlx(problem); }",
      "fn allowed() { let _ = <crate::errors::StorageError>::Sqlx; }",
      "fn allowed_parenthesized() { let _ = <((crate::errors::StorageError))>::Sqlx; }",
      "fn allowed_turbofish() { let _ = crate::errors::StorageError::<>::Sqlx; }",
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
    "worker/src/lib.rs:7: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:8: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("distinguishes matching StorageError variants from constructing them", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "use symphony_storage::StorageError;",
      "fn inspect(error: StorageError) {",
      "    match error {",
      "        StorageError::Sqlx(inner) => consume(inner),",
      "        _ => {}",
      "    }",
      "}",
      "fn destructure(error: StorageError) { let StorageError::Sqlx(inner) = error else { return; }; consume(inner); }",
      "fn predicate(error: StorageError) -> bool { matches!(error, StorageError::Sqlx(_)) }",
      "fn bracket(error: StorageError) -> bool { matches![error, StorageError::Sqlx(_)] }",
      "fn brace(error: StorageError) -> bool { matches!{error, StorageError::Sqlx(_)} }",
      "fn wrong() { let _ = StorageError::Sqlx(problem); }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:12: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("distinguishes match guard expressions from arm patterns", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "use symphony_storage::StorageError;",
      "fn inspect(error: StorageError) {",
      "    match error {",
      "        StorageError::Sqlx(inner) if keep(inner) => {}",
      "        _ if StorageError::Sqlx(problem).is_transient() => {}",
      "        _ if check(StorageError::Sqlx(problem)) => {}",
      "        _ => {}",
      "    }",
      "}",
      "fn predicate(error: StorageError) -> bool { matches!(error, _ if StorageError::Sqlx(problem) == other) }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:10: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:5: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
    "worker/src/lib.rs:6: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("tracks generic parameters that shadow restricted type names", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "trait Build { fn Sqlx(value: Problem) -> Self; }",
      "fn allowed<StorageError: Build>() { let _ = StorageError::Sqlx(problem); }",
      "fn allowed_const<const StorageError: usize>() { let _ = StorageError; }",
      "fn wrong() { let _ = StorageError::Sqlx(problem); }",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:4: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
  ]);
});

test("resolves Self against enclosing impl targets", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "trait Construct { fn construct(); }",
      "enum LocalError { Sqlx }",
      "impl Construct for symphony_storage::StorageError {",
      "    fn construct() { let _ = Self::Sqlx(problem); }",
      "}",
      "impl Construct for LocalError {",
      "    fn construct() { let _ = Self::Sqlx; }",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/src/lib.rs:4: [storage-sqlx-construction] do not disguise non-storage failures (package worker)",
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

test("traverses include! sources emitted by invoked local macros", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      'macro_rules! generated { () => { include!("../generated/part.rs"); } }',
      "generated!();",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated"), { recursive: true });
  await fs.writeFile(
    path.join(root, "worker", "generated", "part.rs"),
    'fn wrong() { let _ = sqlx::query("select 1"); }\n',
  );

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/generated/part.rs:1: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("recursively expands chained local macros before source traversal", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      'macro_rules! inner { () => { include!("../generated/part.rs"); } }',
      "macro_rules! outer { () => { inner!(); } }",
      "outer!();",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated"), { recursive: true });
  await fs.writeFile(
    path.join(root, "worker", "generated", "part.rs"),
    'fn wrong() { let _ = sqlx::query("select 1"); }\n',
  );

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, [
    "worker/generated/part.rs:1: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("fails closed on cyclic local macro expansion", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "macro_rules! first { () => { second!() } }",
      "macro_rules! second { () => { first!() } }",
      "first!();",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    scanRestrictedSources(metadata(root), policy()),
    /simple local macro expansion exceeds 64 passes/,
  );
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

test("does not scan included Rust fragments as standalone roots", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "enum StorageError { Sqlx }",
      'include!("fragment.rs");',
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "worker", "src", "fragment.rs"),
    "fn allowed() { let _ = StorageError::Sqlx; }\n",
  );

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, []);
});

test("skips cfg-disabled include invocations and their source roots", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      '#[cfg(any())] include!("missing.rs");',
      '#[cfg(any())] include!("disabled.rs");',
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "worker", "src", "disabled.rs"),
    'fn disabled() { let _ = sqlx::query("select 1"); }\n',
  );

  const errors = await scanRestrictedSources(metadata(root), policy());

  assert.deepEqual(errors, []);
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

test("resolves child modules relative to explicit #[path] files", async (t) => {
  const root = await fixtureWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated", "alt"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "worker", "generated", "lib.rs"),
    '#[path = "alt/bar.rs"] mod foo;\n',
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "alt", "bar.rs"),
    "mod child;\n",
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "alt", "child.rs"),
    'fn wrong() { let _ = sqlx::query("select 1"); }\n',
  );

  const errors = await scanRestrictedSources(
    metadata(root, {}, { worker: ["src/lib.rs", "generated/lib.rs"] }),
    policy(),
  );

  assert.deepEqual(errors, [
    "worker/generated/alt/child.rs:1: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("resolves active cfg_attr module paths", async (t) => {
  const root = await fixtureWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated", "unix"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "worker", "generated", "lib.rs"),
    '#[cfg_attr(unix, path = "unix/platform.rs")] mod imp;\n',
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "unix", "platform.rs"),
    'fn wrong() { let _ = sqlx::query("select 1"); }\n',
  );

  const errors = await scanRestrictedSources(
    metadata(root, {}, { worker: ["src/lib.rs", "generated/lib.rs"] }),
    policy(),
    { activeCfg: ["unix"] },
  );

  assert.deepEqual(errors, [
    "worker/generated/unix/platform.rs:1: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("resolves cfg_attr module paths selected by Cargo features", async (t) => {
  const root = await fixtureWorkspace({
    worker:
      '#[cfg_attr(feature = "generated", path = "../generated/feature.rs")] mod imp;\n',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker", "generated"), { recursive: true });
  await fs.writeFile(
    path.join(root, "worker", "src", "imp.rs"),
    "fn allowed() {}\n",
  );
  await fs.writeFile(
    path.join(root, "worker", "generated", "feature.rs"),
    'fn wrong() { let _ = sqlx::query("select 1"); }\n',
  );
  const value = metadata(root);
  const worker = value.packages.find((pkg) => pkg.name === "worker");
  worker.features = { default: ["generated"], generated: [] };
  value.resolve = {
    nodes: [
      {
        id: worker.id,
        features: ["default", "generated"],
      },
    ],
  };

  const errors = await scanRestrictedSources(value, policy());

  assert.deepEqual(errors, [
    "worker/generated/feature.rs:1: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("applies cfg attributes generated by active cfg_attr", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      '#[cfg_attr(unix, cfg(any()))] include!("missing.rs");',
      "#[cfg_attr(unix, cfg(any()))] mod absent;",
      'fn wrong() { let _ = sqlx::query("select 1"); }',
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors = await scanRestrictedSources(metadata(root), policy(), {
    activeCfg: ["unix"],
  });

  assert.deepEqual(errors, [
    "worker/src/lib.rs:3: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
});

test("skips cfg-disabled modules during source traversal", async (t) => {
  const root = await fixtureWorkspace({
    worker: [
      "#[cfg(any())] mod absent;",
      '#[cfg(target_os = "windows")] mod windows_only;',
      "mod active;",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "worker", "src", "windows_only.rs"),
    'fn disabled() { let _ = sqlx::query("select 1"); }\n',
  );
  await fs.writeFile(
    path.join(root, "worker", "src", "active.rs"),
    'fn wrong() { let _ = sqlx::query("select 1"); }\n',
  );

  const errors = await scanRestrictedSources(metadata(root), policy(), {
    activeCfg: ['target_os="linux"', "unix"],
  });

  assert.deepEqual(errors, [
    "worker/src/active.rs:1: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
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
