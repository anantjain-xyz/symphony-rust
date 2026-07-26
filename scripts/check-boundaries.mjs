#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyBoundaries } from "./check-boundaries-lib.mjs";

const projectRoot = process.cwd();
const policyPath = path.join(projectRoot, "architecture", "boundaries.json");

let policy;
try {
  policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
} catch (error) {
  console.error(`architecture/boundaries.json:1: cannot load boundary policy: ${error.message}`);
  process.exit(1);
}

const cargo = spawnSync(
  "cargo",
  ["metadata", "--locked", "--no-deps", "--format-version", "1"],
  { cwd: projectRoot, encoding: "utf8" },
);
if (cargo.error || cargo.status !== 0) {
  const detail = cargo.error?.message ?? cargo.stderr.trim() ?? `exit ${cargo.status}`;
  console.error(`Cargo.toml:1: cargo metadata failed: ${detail}`);
  process.exit(1);
}

let metadata;
try {
  metadata = JSON.parse(cargo.stdout);
} catch (error) {
  console.error(`Cargo.toml:1: cargo metadata returned invalid JSON: ${error.message}`);
  process.exit(1);
}

const rustc = spawnSync("rustc", ["--print", "cfg"], {
  cwd: projectRoot,
  encoding: "utf8",
});
if (rustc.error || rustc.status !== 0) {
  const detail = rustc.error?.message ?? rustc.stderr.trim() ?? `exit ${rustc.status}`;
  console.error(`Cargo.toml:1: rustc cfg discovery failed: ${detail}`);
  process.exit(1);
}
const activeCfg = rustc.stdout
  .split(/\r?\n/u)
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

try {
  const errors = await verifyBoundaries(metadata, policy, { activeCfg });
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    console.error(`Boundary check failed with ${errors.length} violation(s).`);
    process.exit(1);
  }
  console.log(
    `Boundary check passed for ${metadata.workspace_members.length} workspace packages.`,
  );
} catch (error) {
  console.error(`architecture/boundaries.json:1: boundary check failed closed: ${error.message}`);
  process.exit(1);
}
