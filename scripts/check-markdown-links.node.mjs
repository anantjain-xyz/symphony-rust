import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkMarkdownFiles,
  githubHeadingSlug,
  isMarkdownFile,
} from "./check-markdown-links-lib.mjs";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "markdown-links",
);

async function checkSource(context, prefix, source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await fs.writeFile(path.join(root, "root.md"), source);
  return checkMarkdownFiles(root, ["root.md"]);
}

test("GitHub-compatible headings de-duplicate", () => {
  assert.equal(githubHeadingSlug("Hello, _World_!"), "hello-world");
});

test("GitHub-compatible headings decode named and numeric HTML entities", () => {
  assert.equal(githubHeadingSlug("&AElig;sop and Bob&#39;s guide"), "æsop-and-bobs-guide");
  assert.equal(githubHeadingSlug("Cr&#xE8;me"), "crème");
});

test("reference-style heading links slug their rendered labels", async (context) => {
  assert.equal(githubHeadingSlug("[Install][docs]"), "install");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-markdown-heading-ref-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await Promise.all([
    fs.writeFile(
      path.join(root, "root.md"),
      ["# [Install][docs]", "", "[Jump](#install)", "", "[docs]: guide.md"].join("\n"),
    ),
    fs.writeFile(path.join(root, "guide.md"), "# Guide\n"),
  ]);

  const problems = await checkMarkdownFiles(root, ["guide.md", "root.md"]);
  assert.deepEqual(problems, []);
});

test("multi-line Setext headings slug the complete paragraph", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-markdown-setext-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await fs.writeFile(
    path.join(root, "root.md"),
    ["First line", "second line", "---", "", "[Jump](#first-line-second-line)"].join("\n"),
  );

  const problems = await checkMarkdownFiles(root, ["root.md"]);
  assert.deepEqual(problems, []);
});

test("headings inside block quotes contribute GitHub anchors", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-quoted-heading-",
    [
      "> # Quoted ATX",
      ">",
      "> Quoted",
      "> Setext",
      "> ---",
      "",
      "[ATX](#quoted-atx)",
      "[Setext](#quoted-setext)",
    ].join("\n"),
  );

  assert.deepEqual(problems, []);
});

test("heading code spans preserve underscores in GitHub anchors", async (context) => {
  assert.equal(githubHeadingSlug("`foo_bar`"), "foo_bar");
  const problems = await checkSource(
    context,
    "symphony-markdown-code-heading-",
    ["# `foo_bar`", "", "[Jump](#foo_bar)"].join("\n"),
  );

  assert.deepEqual(problems, []);
});

test("literal heading underscores remain in GitHub anchors", async (context) => {
  assert.equal(githubHeadingSlug("foo_bar"), "foo_bar");
  assert.equal(githubHeadingSlug("foo\\_bar"), "foo_bar");
  const problems = await checkSource(
    context,
    "symphony-markdown-underscore-heading-",
    ["# foo_bar", "", "[Jump](#foo_bar)"].join("\n"),
  );

  assert.deepEqual(problems, []);
});

test("headings inside list items contribute GitHub anchors", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-list-heading-",
    ["- # Setup", "", "[Jump](#setup)"].join("\n"),
  );

  assert.deepEqual(problems, []);
});

test("reference definitions may wrap before their destination", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-markdown-wrapped-ref-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await Promise.all([
    fs.writeFile(
      path.join(root, "root.md"),
      ["Read the [guide][docs].", "", "[docs]:", "  <guide.md>"].join("\n"),
    ),
    fs.writeFile(path.join(root, "guide.md"), "# Guide\n"),
  ]);

  const problems = await checkMarkdownFiles(root, ["guide.md", "root.md"]);
  assert.deepEqual(problems, []);
});

test("reference definitions inside block quotes resolve with source locations", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-quoted-ref-",
    ["> Read the [guide][docs].", ">", "> [docs]: missing.md"].join("\n"),
  );

  assert.deepEqual(problems, ['root.md:3:11: missing local target "missing.md"']);
});

test("indented code blocks do not contribute link targets", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-indented-code-",
    "    [example](missing.md)\n",
  );

  assert.deepEqual(problems, []);
});

test("code spans crossing line boundaries do not contribute link targets", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-multiline-code-",
    ["`code", "[example][missing]`"].join("\n"),
  );

  assert.deepEqual(problems, []);
});

test("escaped backticks do not mask rendered links", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-escaped-backticks-",
    "\\`[Guide](missing.md)\\`\n",
  );

  assert.deepEqual(problems, ['root.md:1:3: missing local target "missing.md"']);
});

test("raw HTML block bodies do not contribute Markdown targets", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-html-block-",
    ["<pre>", "[example](not-a-link.md)", "<img src=missing.png>", "</pre>"].join("\n"),
  );

  assert.deepEqual(problems, ['root.md:3:6: missing local target "missing.png"']);
});

test("inline HTML tag syntax does not contribute Markdown targets", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-inline-html-",
    [
      '<span title="[ignored](attribute-missing.md)">plain</span>',
      "<span>[rendered](content-missing.md)</span>",
      '<a href="href-missing.md" title="[ignored](title-missing.md)">Guide</a>',
    ].join("\n"),
  );

  assert.deepEqual(problems, [
    'root.md:2:7: missing local target "content-missing.md"',
    'root.md:3:4: missing local target "href-missing.md"',
  ]);
});

test("inline links require an adjacent opening parenthesis", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-spaced-link-",
    "[not a link] (missing.md)\n",
  );

  assert.deepEqual(problems, []);
});

test("inline link destinations may begin on the following line", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-multiline-link-",
    ["[Guide](", "missing.md)"].join("\n"),
  );

  assert.deepEqual(problems, ['root.md:1:1: missing local target "missing.md"']);
});

test("unterminated inline links do not contribute targets", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-unterminated-link-",
    "[not a link](missing.md\n",
  );

  assert.deepEqual(problems, []);
});

test("linked images validate both the image and outer destination", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-markdown-linked-image-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await Promise.all([
    fs.writeFile(path.join(root, "root.md"), "[![Logo](missing.png)](guide.md)\n"),
    fs.writeFile(path.join(root, "guide.md"), "# Guide\n"),
  ]);

  const problems = await checkMarkdownFiles(root, ["guide.md", "root.md"]);
  assert.deepEqual(problems, ['root.md:1:2: missing local target "missing.png"']);
});

test("escaped reference openers remain literal text", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-escaped-reference-",
    "\\[label][unknown]\n",
  );

  assert.deepEqual(problems, []);
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

test("links to the current directory resolve to the repository root", async (context) => {
  const problems = await checkSource(
    context,
    "symphony-markdown-current-directory-",
    "[Home](./)\n",
  );

  assert.deepEqual(problems, []);
});

test("standard .markdown files are discovered and checked", async (context) => {
  assert.equal(isMarkdownFile("README.markdown"), true);
  assert.equal(isMarkdownFile("README.md"), true);
  assert.equal(isMarkdownFile("README.markdown.txt"), false);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-markdown-extension-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await fs.writeFile(path.join(root, "root.markdown"), "[Missing](missing.md)\n");

  const problems = await checkMarkdownFiles(root, ["root.markdown"]);
  assert.deepEqual(problems, ['root.markdown:1:1: missing local target "missing.md"']);
});

test("HTML metadata attributes are not treated as href or src targets", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-markdown-html-attrs-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await fs.writeFile(
    path.join(root, "root.md"),
    [
      "Document src=prose.png without creating an HTML image.",
      '<img data-src=placeholder.png data-href="metadata.md" xlink:href="sprite.svg">',
      '<img src="missing.png">',
      "<img src=unquoted.png>",
    ].join("\n"),
  );

  const problems = await checkMarkdownFiles(root, ["root.md"]);
  assert.deepEqual(problems, [
    'root.md:3:6: missing local target "missing.png"',
    'root.md:4:6: missing local target "unquoted.png"',
  ]);
});

test("footnote definitions are not treated as link definitions", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-markdown-footnotes-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await fs.writeFile(
    path.join(root, "root.md"),
    ["Important context[^1].", "", "[^1]: Important"].join("\n"),
  );

  const problems = await checkMarkdownFiles(root, ["root.md"]);
  assert.deepEqual(problems, []);
});
