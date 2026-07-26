#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isShellShebang, repositoryFiles } from "./hygiene-files.mjs";
import { projectRoot, resolveTool } from "./hygiene-tools-lib.mjs";

try {
  const files = repositoryFiles(projectRoot);
  const shellFiles = [];
  for (const file of files) {
    const absolute = path.join(projectRoot, file);
    const shellExtension = /\.(?:bash|sh)$/.test(file);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      if (shellExtension) {
        throw new Error(`${file}:1: shell hygiene refuses symbolic links`);
      }
      continue;
    }
    if (!stat.isFile()) continue;
    if (shellExtension) {
      shellFiles.push(file);
      continue;
    }
    const handle = await fs.open(absolute, "r");
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
      if (isShellShebang(firstLine)) shellFiles.push(file);
    } finally {
      await handle.close();
    }
  }
  if (shellFiles.length === 0) throw new Error("repository:1: no tracked shell scripts found");

  const shellcheck = await resolveTool("shellcheck");
  const result = spawnSync(shellcheck, ["--format=gcc", "--severity=style", ...shellFiles], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`shellcheck passed for ${shellFiles.length} tracked shell script(s).`);
} catch (error) {
  console.error(`shell hygiene failed: ${error.message}`);
  process.exit(1);
}
