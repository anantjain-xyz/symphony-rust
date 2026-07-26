#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { refuseSymlink, repositoryFiles } from "./hygiene-files.mjs";
import { projectRoot, resolveTool } from "./hygiene-tools-lib.mjs";

try {
  const workflows = repositoryFiles(projectRoot).filter(
    (file) => file.startsWith(".github/workflows/") && /\.(?:yaml|yml)$/.test(file),
  );
  if (workflows.length === 0) {
    throw new Error(".github/workflows:1: no tracked GitHub workflows found");
  }
  await Promise.all(workflows.map((file) => refuseSymlink(projectRoot, file)));

  const [actionlint, shellcheck] = await Promise.all([
    resolveTool("actionlint"),
    resolveTool("shellcheck"),
  ]);
  const result = spawnSync(actionlint, workflows, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: [path.dirname(actionlint), path.dirname(shellcheck), process.env.PATH ?? ""].join(
        path.delimiter,
      ),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`actionlint passed for ${workflows.length} workflow(s).`);
} catch (error) {
  console.error(`workflow hygiene failed: ${error.message}`);
  process.exit(1);
}
