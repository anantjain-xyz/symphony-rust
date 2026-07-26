import assert from "node:assert/strict";
import test from "node:test";
import { loadToolPolicy, platformKey, releaseUrl } from "./hygiene-tools-lib.mjs";

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
