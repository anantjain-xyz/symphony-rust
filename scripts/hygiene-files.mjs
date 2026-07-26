import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const GENERATED_OR_VENDOR_ROOTS = [
  ".cache",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "target",
  "test-results",
];

export function isGeneratedOrVendor(file) {
  const normalized = file.split(path.sep).join("/");
  return GENERATED_OR_VENDOR_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

export function isShellShebang(firstLine) {
  return /^#!.*(?:\/|[ \t])(?:ash|bash|dash|ksh|sh|zsh)(?:\s|$)/.test(firstLine);
}

export function repositoryFiles(root) {
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (listed.error || listed.status !== 0) {
    const detail = listed.error?.message ?? listed.stderr.trim() ?? `exit ${listed.status}`;
    throw new Error(`git ls-files failed: ${detail}`);
  }

  const deleted = spawnSync("git", ["ls-files", "--deleted", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (deleted.error || deleted.status !== 0) {
    const detail = deleted.error?.message ?? deleted.stderr.trim() ?? `exit ${deleted.status}`;
    throw new Error(`git ls-files --deleted failed: ${detail}`);
  }
  const deletedFiles = new Set(deleted.stdout.split("\0").filter(Boolean));

  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => !deletedFiles.has(file))
    .filter((file) => !isGeneratedOrVendor(file))
    .sort();
}

export async function refuseSymlink(root, file) {
  const absolute = path.join(root, file);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`${file}:1: hygiene checks refuse symbolic links`);
  }
}
