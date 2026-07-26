#!/usr/bin/env node

import { installTool } from "./hygiene-tools-lib.mjs";

try {
  for (const name of ["actionlint", "shellcheck"]) {
    await installTool(name);
  }
} catch (error) {
  console.error(`hygiene tool installation failed: ${error.message}`);
  process.exit(1);
}
