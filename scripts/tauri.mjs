#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("-"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(root, "node_modules/@tauri-apps/cli/tauri.js");
const env = { ...process.env };

// Tauri's default macOS DMG path uses Finder automation for cosmetic layout.
// In local non-interactive builds that AppleScript can time out; CI mode makes
// Tauri pass create-dmg's deterministic --skip-jenkins option.
if (
  process.platform === "darwin" &&
  (command === "build" || command === "bundle") &&
  env.TAURI_BUNDLER_DMG_IGNORE_CI !== "true" &&
  !env.CI
) {
  env.CI = "true";
}

const child = spawn(process.execPath, [cliPath, ...args], {
  cwd: root,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
