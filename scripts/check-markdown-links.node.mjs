import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkMarkdownFiles, githubHeadingSlug } from "./check-markdown-links-lib.mjs";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "markdown-links",
);

test("GitHub-compatible headings de-duplicate", () => {
  assert.equal(githubHeadingSlug("Hello, _World_!"), "hello-world");
});

test("GitHub-compatible headings decode named and numeric HTML entities", () => {
  assert.equal(githubHeadingSlug("&AElig;sop and Bob&#39;s guide"), "æsop-and-bobs-guide");
  assert.equal(githubHeadingSlug("Cr&#xE8;me"), "crème");
});

test("accepts local files, headings, images, references, and external URLs", async () => {
  const problems = await checkMarkdownFiles(path.join(fixtureRoot, "positive"), [
    "guide.md.fixture",
    "root.md.fixture",
  ]);
  assert.deepEqual(problems, []);
});

test("reports missing files, headings, and references with line numbers", async () => {
  const problems = await checkMarkdownFiles(path.join(fixtureRoot, "negative"), [
    "guide.md.fixture",
    "root.md.fixture",
  ]);
  assert.deepEqual(problems, [
    'root.md.fixture:1:1: missing local target "missing.md"',
    'root.md.fixture:2:1: missing heading "#not-here" in guide.md.fixture',
    "root.md.fixture:3:1: undefined link reference [unknown]",
  ]);
});

test("percent-encoded URI delimiters remain filename characters", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-markdown-delimiters-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await Promise.all([
    fs.writeFile(
      path.join(root, "root.md"),
      [
        "[Hash](guide%23one.md#encoded-delimiter)",
        "[Query](guide%3Ftwo.md#encoded-delimiter)",
      ].join("\n"),
    ),
    fs.writeFile(path.join(root, "guide#one.md"), "# Encoded delimiter\n"),
    fs.writeFile(path.join(root, "guide?two.md"), "# Encoded delimiter\n"),
  ]);

  const problems = await checkMarkdownFiles(root, ["guide#one.md", "guide?two.md", "root.md"]);
  assert.deepEqual(problems, []);
});
