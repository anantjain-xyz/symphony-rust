import assert from "node:assert/strict";
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
