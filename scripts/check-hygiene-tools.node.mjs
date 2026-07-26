import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  biomeBaselinePolicyProblems,
  loadTrustedBiomeBaseline,
} from "./check-biome-format-lib.mjs";
import { isShellShebang, repositoryFiles } from "./hygiene-files.mjs";
import {
  download,
  extractArchiveBinary,
  loadToolPolicy,
  platformKey,
  releaseUrl,
} from "./hygiene-tools-lib.mjs";

function fakeDownload(responseEvent) {
  return (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = (error) => request.emit("error", error);
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.complete = false;
      response.headers = {};
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit(responseEvent, new Error(`simulated ${responseEvent}`));
    });
    return request;
  };
}

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

test("shell hygiene recognizes supported extensionless sh-family interpreters", () => {
  for (const shell of ["ash", "bash", "dash", "ksh", "sh", "zsh"]) {
    assert.equal(isShellShebang(`#!/bin/${shell}`), true, shell);
    assert.equal(isShellShebang(`#!/usr/bin/env ${shell}`), true, `env ${shell}`);
  }
  assert.equal(isShellShebang("#!/usr/bin/fish"), false);
  assert.equal(isShellShebang("#!/usr/bin/my-sh"), false);
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

test("Biome format baseline permits deletions but rejects additions and re-pinning", () => {
  const trusted = {
    "formatted-later.ts": "a".repeat(64),
    "legacy.ts": "b".repeat(64),
  };

  assert.deepEqual(
    biomeBaselinePolicyProblems({ "legacy.ts": "b".repeat(64) }, trusted, "abc123"),
    [],
  );
  assert.deepEqual(
    biomeBaselinePolicyProblems(
      {
        "legacy.ts": "c".repeat(64),
        "new-exception.ts": "d".repeat(64),
      },
      trusted,
      "abc123",
    ),
    [
      "scripts/biome-format-baseline.json: legacy.ts was re-pinned after the trusted baseline at abc123; format the file instead",
      "scripts/biome-format-baseline.json: new-exception.ts was added after the trusted baseline at abc123; format the file instead",
    ],
  );
});

test("Biome format baseline trusts its introduction when the branch base predates it", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-biome-baseline-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  const git = (...arguments_) => {
    const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };

  git("init", "--quiet");
  git("config", "user.email", "hygiene@example.com");
  git("config", "user.name", "Hygiene Test");
  await fs.writeFile(path.join(root, "README.md"), "# Test\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "base");
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(
    path.join(root, "scripts", "biome-format-baseline.json"),
    `${JSON.stringify({ "legacy.ts": "a".repeat(64) }, null, 2)}\n`,
  );
  git("add", "scripts/biome-format-baseline.json");
  git("commit", "--quiet", "-m", "add baseline");
  await fs.writeFile(path.join(root, "README.md"), "# Test\n\nLater change.\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "later change");

  const trusted = loadTrustedBiomeBaseline(root, { BIOME_FORMAT_BASE_REF: "HEAD~2" });
  assert.deepEqual(trusted?.baseline, { "legacy.ts": "a".repeat(64) });
  assert.match(trusted?.revision ?? "", /^[a-f0-9]{40}$/);
});

test("Biome format baseline compares main pushes with the previous revision", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-biome-main-push-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  const git = (...arguments_) => {
    const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const baselinePath = path.join(root, "scripts", "biome-format-baseline.json");

  git("init", "--quiet");
  git("config", "user.email", "hygiene@example.com");
  git("config", "user.name", "Hygiene Test");
  await fs.mkdir(path.dirname(baselinePath));
  await fs.writeFile(baselinePath, `${JSON.stringify({ "legacy.ts": "a".repeat(64) }, null, 2)}\n`);
  git("add", "scripts/biome-format-baseline.json");
  git("commit", "--quiet", "-m", "add baseline");
  await fs.writeFile(baselinePath, `${JSON.stringify({ "legacy.ts": "b".repeat(64) }, null, 2)}\n`);
  git("add", "scripts/biome-format-baseline.json");
  git("commit", "--quiet", "-m", "re-pin baseline");

  const trusted = loadTrustedBiomeBaseline(root, {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
  });
  assert.deepEqual(trusted?.baseline, { "legacy.ts": "a".repeat(64) });
});

test("archive downloads reject response stream errors and aborts", async () => {
  await assert.rejects(
    download("https://example.test/tool.tar.gz", {
      get: fakeDownload("error"),
      timeoutMs: 100,
    }),
    /download stream failed.*simulated error/,
  );
  await assert.rejects(
    download("https://example.test/tool.tar.gz", {
      get: fakeDownload("aborted"),
      timeoutMs: 100,
    }),
    /download stream was aborted/,
  );
});

test("archive downloads time out instead of waiting indefinitely", async () => {
  const get = () => {
    const request = new EventEmitter();
    request.destroy = (error) => request.emit("error", error);
    return request;
  };

  await assert.rejects(
    download("https://example.test/tool.tar.gz", { get, timeoutMs: 10 }),
    /download timed out after 10ms/,
  );
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
