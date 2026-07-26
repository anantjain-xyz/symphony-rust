import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { repositoryFiles } from "./hygiene-files.mjs";
import {
  extractArchiveBinary,
  loadToolPolicy,
  platformKey,
  releaseUrl,
} from "./hygiene-tools-lib.mjs";

test("tool policy pins checksummed release assets for macOS and Linux", async () => {
  const policy = await loadToolPolicy();
  for (const [name, tool] of Object.entries(policy)) {
    for (const key of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      const asset = tool.assets[key];
      assert.match(asset.sha256, /^[a-f0-9]{64}$/, `${name}/${key}`);
      assert.match(asset.archive, new RegExp(tool.version.replaceAll(".", "\\.")));
      assert.equal(
        releaseUrl(tool, asset),
        `https://github.com/${tool.repository}/releases/download/v${tool.version}/${asset.archive}`,
      );
    }
  }
});

test("unsupported platforms fail with an actionable error", () => {
  assert.throws(() => platformKey("win32", "x64"), /supported: macOS or Linux/);
});

test("ShellCheck policy selects the published tar.xz assets", async () => {
  const policy = await loadToolPolicy();
  for (const asset of Object.values(policy.shellcheck.assets)) {
    assert.match(asset.archive, /\.tar\.xz$/);
  }
});

test("repository files omit tracked paths deleted from the worktree", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-hygiene-files-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  const git = (...arguments_) => {
    const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };

  git("init", "--quiet");
  await fs.writeFile(path.join(root, "deleted.md"), "# Deleted\n");
  await fs.writeFile(path.join(root, "kept.md"), "# Kept\n");
  git("add", "deleted.md", "kept.md");
  await fs.rm(path.join(root, "deleted.md"));

  assert.deepEqual(repositoryFiles(root), ["kept.md"]);
});

test("secure archive extraction supports pinned tar.xz assets", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-hygiene-xz-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  const member = "shellcheck-v0.11.0/shellcheck";
  const payloadRoot = path.join(root, "payload");
  await fs.mkdir(path.join(payloadRoot, path.dirname(member)), { recursive: true });
  await fs.writeFile(path.join(payloadRoot, member), "#!/bin/sh\necho shellcheck\n");
  const archivePath = path.join(root, "shellcheck-v0.11.0.test.tar.xz");
  const packed = spawnSync("tar", ["-cJf", archivePath, "-C", payloadRoot, member], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);

  const binary = extractArchiveBinary(archivePath, {
    archive: path.basename(archivePath),
    binaryPath: member,
  });
  assert.equal(binary.toString("utf8"), "#!/bin/sh\necho shellcheck\n");
  assert.throws(
    () =>
      extractArchiveBinary(archivePath, {
        archive: path.basename(archivePath),
        binaryPath: "../shellcheck",
      }),
    /safe relative path/,
  );
});
