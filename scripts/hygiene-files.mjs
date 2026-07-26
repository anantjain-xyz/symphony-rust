import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

export function repositoryFiles(root) {
  const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (git.error || git.status !== 0) {
    const detail = git.error?.message ?? git.stderr.trim() ?? `exit ${git.status}`;
    throw new Error(`git ls-files failed: ${detail}`);
  }
  return git.stdout
    .split("\0")
    .filter(Boolean)
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
