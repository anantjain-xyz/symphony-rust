#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIOME_VERSION = "2.5.5";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(projectRoot, "node_modules", "@biomejs", "biome", "package.json");
const baselinePath = path.join(projectRoot, "scripts", "biome-format-baseline.json");
const executable = path.join(projectRoot, "node_modules", ".bin", "biome");

function hash(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(projectRoot, file)))
    .digest("hex");
}

try {
  const installed = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
  if (installed !== BIOME_VERSION) {
    throw new Error(
      `expected @biomejs/biome ${BIOME_VERSION}, found ${installed}; run "pnpm install --frozen-lockfile"`,
    );
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const result = spawnSync(
    executable,
    ["format", "--reporter=json", "--max-diagnostics=none", "."],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  const reportLine = result.stdout.split("\n").find((line) => line.startsWith("{"));
  if (!reportLine) {
    throw new Error(`Biome did not emit its JSON report:\n${result.stderr.trim()}`);
  }
  const report = JSON.parse(reportLine);
  if (report.command !== "format") throw new Error("Biome returned an unexpected report");

  const unformatted = new Set();
  const problems = [];
  for (const diagnostic of report.diagnostics) {
    const file = diagnostic.location?.path;
    if (diagnostic.category !== "format" || !file) {
      problems.push(`Biome reported an unexpected ${diagnostic.category ?? "unknown"} diagnostic`);
      continue;
    }
    unformatted.add(file);
    const expected = baseline[file];
    if (!expected || hash(file) !== expected) {
      problems.push(`${file}:1: file is not formatted; run "pnpm biome format --write ${file}"`);
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!unformatted.has(file)) {
      problems.push(
        `${file}:1: format baseline is stale; remove its entry from scripts/biome-format-baseline.json`,
      );
    }
  }
  if (problems.length > 0) {
    console.error(problems.sort().join("\n"));
    process.exit(1);
  }
  if (result.status !== 0 && report.summary.errors !== unformatted.size) {
    throw new Error(`Biome format failed with exit ${result.status}`);
  }
  console.log(
    `Biome formatting passed; ${unformatted.size} pre-existing file(s) remain hash-pinned in the baseline.`,
  );
} catch (error) {
  console.error(`format hygiene failed: ${error.message}`);
  process.exit(1);
}
