import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { verifyCargoMetadata } from "./check-boundaries-lib.mjs";

function policy(overrides = {}) {
  return {
    version: 1,
    packages: {
      core: { allowedInternalDependencies: [] },
      storage: { allowedInternalDependencies: ["core"] },
      worker: { allowedInternalDependencies: ["core", "storage"] },
    },
    restrictedDependencies: { sqlx: ["storage"] },
    ...overrides,
  };
}

function metadata(root, dependencies = {}) {
  const names = ["core", "storage", "worker"];
  const packages = names.map((name) => ({
    id: `path+file://${root}/${name}#0.0.0`,
    name,
    manifest_path: path.join(root, name, "Cargo.toml"),
    dependencies: (dependencies[name] ?? []).map((dependency) => ({ name: dependency })),
  }));
  return {
    workspace_root: root,
    workspace_members: packages.map((pkg) => pkg.id),
    packages,
  };
}

test("accepts the declared internal DAG and storage ownership", () => {
  const errors = verifyCargoMetadata(
    metadata("/fixture", {
      storage: ["core", "sqlx"],
      worker: ["core", "storage"],
    }),
    policy(),
  );

  assert.deepEqual(errors, []);
});

test("rejects forbidden internal edges and non-storage restricted dependencies", () => {
  const errors = verifyCargoMetadata(
    metadata("/fixture", {
      core: ["worker"],
      storage: ["core", "sqlx"],
      worker: ["core", "storage", "sqlx"],
    }),
    policy(),
  );

  assert.deepEqual(errors, [
    "core/Cargo.toml:1: core may not depend on internal crate worker",
    "worker/Cargo.toml:1: worker may not declare restricted dependency sqlx; allowed owner: storage",
  ]);
});

test("fails closed for invalid boundary policy graphs", () => {
  const cyclic = policy({
    packages: {
      core: { allowedInternalDependencies: ["worker"] },
      storage: { allowedInternalDependencies: ["core"] },
      worker: { allowedInternalDependencies: ["storage"] },
    },
  });

  assert.throws(
    () => verifyCargoMetadata(metadata("/fixture"), cyclic),
    /allowed internal dependency graph contains a cycle/,
  );
});
