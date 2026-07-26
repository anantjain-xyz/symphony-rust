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

test("scans custom Cargo target source paths outside conventional roots", async (t) => {
  const root = await fixtureWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "worker", "Cargo.toml"),
    [
      "[package]",
      'name = "worker"',
      "",
      "[[bin]]",
      'name = "tool"',
      'path = "tool.rs"',
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "worker", "tool.rs"),
    ["fn main() {", '    let _ = sqlx::query("select 1");', "}", ""].join("\n"),
  );

  const errors = await scanRestrictedSources(
    metadata(root, {}, { worker: ["src/lib.rs", "tool.rs"] }),
    policy(),
  );

  assert.deepEqual(errors, [
    "worker/tool.rs:2: [direct-sqlx] direct sqlx use belongs in storage (package worker)",
  ]);
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
