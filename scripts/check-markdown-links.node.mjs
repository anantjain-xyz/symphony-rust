import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkMarkdownFiles } from "./check-markdown-links-lib.mjs";

async function makeRepository(context, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-markdown-links-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, contents);
  }
  return root;
}

async function checkRepository(context, files, markdownFiles = Object.keys(files)) {
  const root = await makeRepository(context, files);
  return checkMarkdownFiles(root, markdownFiles);
}

test("validates local files, root-relative paths, images, references, and external URLs", async (context) => {
  const problems = await checkRepository(context, {
    "README.md": [
      "# Home",
      "",
      "[Guide](/guide.md#details)",
      "[Docs](/docs/#setup)",
      "[Reference][guide]",
      "![Pixel](pixel.png)",
      "[External](https://example.com/not-fetched)",
      "",
      "[guide]: guide.md#details",
    ].join("\n"),
    "guide.md": "# Details\n",
    "docs/README.md": "# Setup\n",
    "pixel.png": new Uint8Array(),
  });

  assert.deepEqual(problems, []);
});

test("reports missing files and anchors with file and line context", async (context) => {
  const problems = await checkRepository(context, {
    "README.md": ["[Missing](missing.md)", "[Bad heading](guide.md#not-here)"].join("\n"),
    "guide.md": "# Present\n",
  });

  assert.deepEqual(problems, [
    'README.md:1:1: missing local target "missing.md"',
    'README.md:2:1: missing heading "#not-here" in guide.md',
  ]);
});

test("validates a reference definition once when used repeatedly", async (context) => {
  const problems = await checkRepository(context, {
    "README.md": ["[First][missing]", "[Second][missing]", "", "[missing]: missing.md"].join("\n"),
  });

  assert.deepEqual(problems, ['README.md:4:1: missing local target "missing.md"']);
});

test("uses GitHub duplicate-heading semantics", async (context) => {
  const problems = await checkRepository(context, {
    "README.md": [
      "# Repeated heading",
      "# Repeated heading",
      "",
      "[First](#repeated-heading)",
      "[Second](#repeated-heading-1)",
      "[Missing](#repeated-heading-2)",
    ].join("\n"),
  });

  assert.deepEqual(problems, ['README.md:6:1: missing heading "#repeated-heading-2" in README.md']);
});

test("decodes paths and fragments, including percent-encoded filename delimiters", async (context) => {
  const problems = await checkRepository(
    context,
    {
      "docs/index.md": [
        "[Guide](guide%23book.md#hello%2Dworld)",
        "[Root-relative](/docs/guide%23book.md#hello%2Dworld)",
      ].join("\n"),
      "docs/guide#book.md": "# Hello world\n",
    },
    ["docs/index.md", "docs/guide#book.md"],
  );

  assert.deepEqual(problems, []);
});

test("validates GFM links while ignoring code and raw HTML nodes", async (context) => {
  const problems = await checkRepository(context, {
    "README.md": [
      "- [x] [Task](guide.md#target)",
      "",
      "| Docs |",
      "| --- |",
      "| [Table](guide.md#target) |",
      "",
      "~~[Strike](guide.md#target)~~",
      "",
      "`[Inline code](missing.md)`",
      "",
      "```md",
      "[Fenced](missing.md)",
      "```",
      "",
      '<a href="missing.md">Raw HTML</a>',
      "",
      "Footnote[^1] and https://example.com/no-network",
      "",
      "[^1]: Footnotes are parsed by remark-gfm.",
    ].join("\n"),
    "guide.md": "# Target\n",
  });

  assert.deepEqual(problems, []);
});
