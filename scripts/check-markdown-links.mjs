#!/usr/bin/env node

import { checkMarkdownFiles, isMarkdownFile } from "./check-markdown-links-lib.mjs";
import { refuseSymlink, repositoryFiles } from "./hygiene-files.mjs";
import { projectRoot } from "./hygiene-tools-lib.mjs";

try {
  const files = repositoryFiles(projectRoot).filter(isMarkdownFile);
  if (files.length === 0) throw new Error("repository:1: no Markdown files found");
  await Promise.all(files.map((file) => refuseSymlink(projectRoot, file)));
  const problems = await checkMarkdownFiles(projectRoot, files);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`Markdown links passed for ${files.length} file(s).`);
} catch (error) {
  console.error(`Markdown link hygiene failed: ${error.message}`);
  process.exit(1);
}
