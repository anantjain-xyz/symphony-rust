import fs from "node:fs/promises";
import path from "node:path";
import GithubSlugger from "github-slugger";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const HTML_START_TAG = /<([A-Za-z][A-Za-z0-9:-]*)(?:\s[^<>]*?)?>/g;
const HTML_ATTRIBUTE =
  /\s([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const UNRESOLVED_REFERENCE = /!?\[([^\]\r\n]*)\]\[([^\]\r\n]*)\]/g;
const parser = unified().use(remarkParse).use(remarkGfm);

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
function normalizeReference(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}
function headingText(node) {
  return (node.children ?? []).map(renderHeadingNode).join("").replace(/\s+/gu, " ").trim();
}

function renderHeadingNode(node) {
  if (node.type === "html") return "";
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "break") return "\n";
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  return (node.children ?? []).map(renderHeadingNode).join("");
}
function markdownAnchors(tree) {
  const slugger = new GithubSlugger();
  const anchors = htmlAnchors(tree);
  walk(tree, (node) => {
    if (node.type !== "heading") return;
    const slug = slugger.slug(headingText(node));
    if (slug) anchors.add(slug);
  });
  return anchors;
}

function htmlAttributeValue(tag, name) {
  for (const match of tag.matchAll(HTML_ATTRIBUTE)) {
    if (match[1].toLocaleLowerCase("en-US") !== name) continue;
    return match[2] ?? match[3] ?? match[4] ?? "";
  }
  return null;
}

function htmlAnchors(tree) {
  const anchors = new Set();
  walk(tree, (node) => {
    if (node.type !== "html") return;
    for (const match of node.value.matchAll(HTML_START_TAG)) {
      const tag = match[1].toLocaleLowerCase("en-US");
      const id = htmlAttributeValue(match[0], "id");
      if (id) anchors.add(id);
      if (tag === "a") {
        const name = htmlAttributeValue(match[0], "name");
        if (name) anchors.add(name);
      }
    }
  });
  return anchors;
}

function isEscaped(value, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function nodeAtOffset(node, offset) {
  const position = node.position;
  if (!position?.start) return node;
  const value = String(node.value ?? "");
  const prefix = value.slice(0, offset);
  const lineBreaks = prefix.match(/\r\n|\r|\n/g)?.length ?? 0;
  const lastBreak = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"));
  return {
    ...node,
    position: {
      ...position,
      start: {
        ...position.start,
        column: lineBreaks === 0 ? position.start.column + offset : prefix.length - lastBreak,
        line: position.start.line + lineBreaks,
        offset: (position.start.offset ?? 0) + offset,
      },
    },
  };
}

function extractTargets(tree) {
  const definitions = new Map();
  const targets = [];

  walk(tree, (node) => {
    if (node.type !== "definition") return;
    const identifier = normalizeReference(node.identifier);
    if (definitions.has(identifier)) return;
    definitions.set(identifier, node.url);
    targets.push({ node, target: node.url });
  });

  walk(tree, (node) => {
    if (node.type === "link" || node.type === "image") {
      targets.push({ node, target: node.url });
      return;
    }
    if (node.type !== "linkReference" && node.type !== "imageReference") return;

    const reference = normalizeReference(node.identifier ?? node.label);
    if (!definitions.has(reference)) {
      targets.push({ node, reference, unresolvedReference: true });
    }
  });

  walk(tree, (node) => {
    if (node.type !== "text") return;
    for (const match of node.value.matchAll(UNRESOLVED_REFERENCE)) {
      if (isEscaped(node.value, match.index)) continue;
      const reference = normalizeReference(match[2] || match[1]);
      if (definitions.has(reference)) continue;
      targets.push({
        node: nodeAtOffset(node, match.index),
        reference,
        unresolvedReference: true,
      });
    }
  });

  return targets;
}
function decodeTarget(target) {
  const hash = target.indexOf("#");
  const pathAndQuery = hash === -1 ? target : target.slice(0, hash);
  const encodedFragment = hash === -1 ? "" : target.slice(hash + 1);
  const question = pathAndQuery.indexOf("?");
  const encodedPath = question === -1 ? pathAndQuery : pathAndQuery.slice(0, question);
  const encodedQuery = question === -1 ? "" : pathAndQuery.slice(question + 1);

  try {
    return {
      external: EXTERNAL_TARGET.test(target),
      fragment: decodeURIComponent(encodedFragment),
      path: decodeURIComponent(encodedPath),
      query: decodeURIComponent(encodedQuery),
    };
  } catch {
    return null;
  }
}

async function exactPath(root, relative) {
  const components = relative.split("/").filter((component) => component && component !== ".");
  let current = root;
  for (const component of components) {
    const entries = await fs.readdir(current);
    if (!entries.includes(component)) return null;
    current = path.join(current, component);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("target is a symbolic link");
  }
  return current;
}

async function directoryReadme(directory) {
  const entries = await fs.readdir(directory);
  return (
    ["README.md", "README.markdown"].find((candidate) => entries.includes(candidate)) ??
    entries.find((entry) => /^readme\.(?:md|markdown)$/i.test(entry))
  );
}

export function isMarkdownFile(file) {
  return /\.(?:md|markdown)$/i.test(file);
}

export async function checkMarkdownFiles(root, files) {
  const normalizedRoot = path.resolve(root);
  const markdownFiles = new Set(files.map((file) => file.split(path.sep).join("/")));
  const sources = new Map();
  const trees = new Map();
  const anchors = new Map();
  const problems = [];

  for (const file of markdownFiles) {
    const absolute = path.join(normalizedRoot, file);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      problems.push(`${file}:1: Markdown files may not be symbolic links`);
      continue;
    }
    sources.set(file, await fs.readFile(absolute, "utf8"));
  }

  const treeFor = async (file, absolute) => {
    if (trees.has(file)) return trees.get(file);
    const source = sources.get(file) ?? (await fs.readFile(absolute, "utf8"));
    const tree = parser.parse(source);
    trees.set(file, tree);
    return tree;
  };

  const anchorsFor = async (file, absolute) => {
    if (anchors.has(file)) return anchors.get(file);
    const result = markdownAnchors(await treeFor(file, absolute));
    anchors.set(file, result);
    return result;
  };

  for (const [file] of sources) {
    const tree = await treeFor(file, path.join(normalizedRoot, file));
    for (const target of extractTargets(tree)) {
      const position = target.node.position?.start;
      const location = `${file}:${position?.line ?? 1}:${position?.column ?? 1}`;
      if (target.unresolvedReference) {
        problems.push(`${location}: undefined link reference [${target.reference}]`);
        continue;
      }
      if (!target.target) continue;

      const decoded = decodeTarget(target.target.trim());
      if (decoded === null) {
        problems.push(`${location}: invalid percent-encoding in link "${target.target}"`);
        continue;
      }
      if ((!decoded.path && !decoded.query && !decoded.fragment) || decoded.external) continue;

      const relative = decoded.path
        ? decoded.path.startsWith("/")
          ? decoded.path.slice(1)
          : path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded.path))
        : file;
      if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
        problems.push(`${location}: local link escapes the repository: "${target.target}"`);
        continue;
      }

      let absolute;
      try {
        absolute = await exactPath(normalizedRoot, relative);
      } catch (error) {
        problems.push(`${location}: invalid local link "${target.target}": ${error.message}`);
        continue;
      }
      if (!absolute) {
        problems.push(`${location}: missing local target "${target.target}"`);
        continue;
      }

      let fragmentAbsolute = absolute;
      let fragmentRelative = relative;
      if (decoded.fragment && (await fs.lstat(absolute)).isDirectory()) {
        const readme = await directoryReadme(absolute);
        if (!readme) {
          problems.push(
            `${location}: missing Markdown README for fragment "#${decoded.fragment}" in ${
              relative || "."
            }`,
          );
          continue;
        }
        fragmentRelative = path.posix.join(relative, readme);
        try {
          fragmentAbsolute = await exactPath(normalizedRoot, fragmentRelative);
        } catch (error) {
          problems.push(`${location}: invalid local link "${target.target}": ${error.message}`);
          continue;
        }
        if (!fragmentAbsolute || !(await fs.lstat(fragmentAbsolute)).isFile()) {
          problems.push(
            `${location}: missing Markdown README for fragment "#${decoded.fragment}" in ${
              relative || "."
            }`,
          );
          continue;
        }
      }

      if (
        decoded.fragment &&
        (markdownFiles.has(fragmentRelative) || isMarkdownFile(fragmentRelative))
      ) {
        const targetAnchors = await anchorsFor(fragmentRelative, fragmentAbsolute);
        if (!targetAnchors.has(decoded.fragment)) {
          problems.push(
            `${location}: missing heading "#${decoded.fragment}" in ${fragmentRelative}`,
          );
        }
      }
    }
  }
  return problems.sort();
}
