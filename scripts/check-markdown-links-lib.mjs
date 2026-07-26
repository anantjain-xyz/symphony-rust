import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const HTML_ENTITY = /&(?:#[xX][0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi;
const HTML_ATTRIBUTE = /(?<!\S)(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const REFERENCE_DEFINITION =
  /^\s{0,3}\[(?!\^)([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const REFERENCE_DEFINITION_START = /^\s{0,3}\[(?!\^)([^\]]+)\]:[ \t]*$/;
const REFERENCE_DEFINITION_CONTINUATION =
  /^\s{0,3}(?:<([^>]+)>|(\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const REFERENCE_USE = /(!?)\[([^\]]*)\]\s*\[([^\]]*)\]/g;
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)\s*$/;

function maskRange(value, start, end) {
  return `${value.slice(0, start)}${" ".repeat(end - start)}${value.slice(end)}`;
}

function maskIgnoredMarkdown(source) {
  const lines = source.split("\n");
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      lines[index] = " ".repeat(line.length);
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      lines[index] = " ".repeat(line.length);
      continue;
    }

    let masked = line;
    for (let cursor = 0; cursor < masked.length; ) {
      if (masked[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let delimiterEnd = cursor;
      while (masked[delimiterEnd] === "`") delimiterEnd += 1;
      const delimiter = masked.slice(cursor, delimiterEnd);
      const closing = masked.indexOf(delimiter, delimiterEnd);
      if (closing === -1) {
        cursor = delimiterEnd;
        continue;
      }
      masked = maskRange(masked, cursor, closing + delimiter.length);
      cursor = closing + delimiter.length;
    }
    lines[index] = masked;
  }
  return lines.join("\n").replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

const entityDecoder = new JSDOM("").window.document.createElement("textarea");

function decodeHtmlEntities(value) {
  return value.replace(HTML_ENTITY, (entity) => {
    // Match only a single entity token so arbitrary Markdown is never parsed as
    // HTML merely to decode CommonMark's full named and numeric entity set.
    entityDecoder.innerHTML = entity;
    return entityDecoder.value;
  });
}

function unescapeMarkdown(value) {
  return decodeHtmlEntities(value).replace(/\\([\\!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g, "$1");
}

function headingText(value) {
  return value
    .replace(REFERENCE_USE, (_match, _image, label) => label)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "");
}

function startsMarkdownBlock(line) {
  return (
    /^\s{0,3}(?:#{1,6}(?:\s|$)|>|(?:[*+-]|\d{1,9}[.)])\s+)/.test(line) ||
    /^\s{4}/.test(line) ||
    REFERENCE_DEFINITION.test(line) ||
    REFERENCE_DEFINITION_START.test(line) ||
    SETEXT_UNDERLINE.test(line)
  );
}

export function githubHeadingSlug(value) {
  return unescapeMarkdown(headingText(value))
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function markdownAnchors(source) {
  const masked = maskIgnoredMarkdown(source);
  const originalLines = source.split("\n");
  const maskedLines = masked.split("\n");
  const anchors = new Set();

  const addHeading = (value) => {
    const base = githubHeadingSlug(value);
    if (!base) return;
    let candidate = base;
    for (let suffix = 1; anchors.has(candidate); suffix += 1) {
      candidate = `${base}-${suffix}`;
    }
    anchors.add(candidate);
  };

  for (let index = 0; index < maskedLines.length; index += 1) {
    const line = maskedLines[index];
    const atx = line.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/);
    if (atx) {
      const originalAtx = originalLines[index].match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/);
      addHeading(originalAtx?.[1] ?? atx[1]);
    } else if (
      index + 1 < maskedLines.length &&
      /\S/.test(line) &&
      SETEXT_UNDERLINE.test(maskedLines[index + 1])
    ) {
      let firstLine = index;
      while (
        firstLine > 0 &&
        /\S/.test(maskedLines[firstLine - 1]) &&
        !startsMarkdownBlock(maskedLines[firstLine - 1])
      ) {
        firstLine -= 1;
      }
      addHeading(originalLines.slice(firstLine, index + 1).join("\n"));
    }

    for (const match of line.matchAll(
      /<a\b[^>]*\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi,
    )) {
      anchors.add(unescapeMarkdown(match[1] ?? match[2]));
    }
  }
  return anchors;
}

function findClosingBracket(line, start) {
  let depth = 0;
  for (let cursor = start; cursor < line.length; cursor += 1) {
    if (line[cursor] === "\\") {
      cursor += 1;
    } else if (line[cursor] === "[") {
      depth += 1;
    } else if (line[cursor] === "]") {
      if (depth === 0) return cursor;
      depth -= 1;
    }
  }
  return -1;
}

function inlineLinks(line) {
  const links = [];
  for (let cursor = 0; cursor < line.length; cursor += 1) {
    const labelStart = line[cursor] === "!" && line[cursor + 1] === "[" ? cursor + 1 : cursor;
    if (line[labelStart] !== "[" || line[labelStart - 1] === "\\") continue;
    const labelEnd = findClosingBracket(line, labelStart + 1);
    if (labelEnd === -1) continue;
    let open = labelEnd + 1;
    while (/\s/.test(line[open] ?? "")) open += 1;
    if (line[open] !== "(") continue;

    let targetStart = open + 1;
    while (/\s/.test(line[targetStart] ?? "")) targetStart += 1;
    let targetEnd = targetStart;
    if (line[targetStart] === "<") {
      targetStart += 1;
      targetEnd = line.indexOf(">", targetStart);
      if (targetEnd === -1) continue;
    } else {
      let depth = 0;
      for (; targetEnd < line.length; targetEnd += 1) {
        const character = line[targetEnd];
        if (character === "\\") {
          targetEnd += 1;
        } else if (character === "(") {
          depth += 1;
        } else if (character === ")") {
          if (depth === 0) break;
          depth -= 1;
        } else if (/\s/.test(character) && depth === 0) {
          break;
        }
      }
    }

    links.push({
      column: cursor + 1,
      end: targetEnd,
      start: cursor,
      target: line.slice(targetStart, targetEnd),
    });
    cursor = Math.max(cursor, targetEnd);
  }
  return links;
}

function normalizeReference(value) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function extractTargets(source) {
  const maskedLines = maskIgnoredMarkdown(source).split("\n");
  const targets = [];
  const definitions = new Map();

  for (let index = 0; index < maskedLines.length; index += 1) {
    const line = maskedLines[index];
    const definition = line.match(REFERENCE_DEFINITION);
    if (definition) {
      const label = normalizeReference(definition[1]);
      definitions.set(label, { line: index + 1, target: definition[2] ?? definition[3] });
      targets.push({ column: 1, line: index + 1, target: definition[2] ?? definition[3] });
      continue;
    }
    const definitionStart = line.match(REFERENCE_DEFINITION_START);
    const continuation = maskedLines[index + 1]?.match(REFERENCE_DEFINITION_CONTINUATION);
    if (definitionStart && continuation) {
      const target = continuation[1] ?? continuation[2];
      const label = normalizeReference(definitionStart[1]);
      definitions.set(label, { line: index + 1, target });
      targets.push({
        column: (maskedLines[index + 1].indexOf(target) ?? 0) + 1,
        line: index + 2,
        target,
      });
      index += 1;
      continue;
    }

    const inline = inlineLinks(line);
    targets.push(...inline.map((link) => ({ ...link, line: index + 1 })));
    let references = line;
    for (const link of [...inline].reverse()) {
      references = maskRange(references, link.start, link.end);
    }
    for (const match of references.matchAll(REFERENCE_USE)) {
      const label = normalizeReference(match[3] || match[2]);
      targets.push({
        column: (match.index ?? 0) + 1,
        line: index + 1,
        reference: label,
      });
    }
    for (const match of line.matchAll(HTML_ATTRIBUTE)) {
      targets.push({
        column: (match.index ?? 0) + 1,
        line: index + 1,
        target: match[1] ?? match[2],
      });
    }
  }

  return targets.map((target) => {
    if (!target.reference) return target;
    return {
      ...target,
      target: "",
      unresolvedReference: !definitions.has(target.reference),
    };
  });
}

async function exactPath(root, relative) {
  const components = relative.split("/").filter(Boolean);
  let current = root;
  for (const component of components) {
    const entries = await fs.readdir(current);
    if (!entries.includes(component)) return null;
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("target is a symbolic link");
  }
  return current;
}

function decodeTarget(target) {
  const unescaped = unescapeMarkdown(target);
  const hash = unescaped.indexOf("#");
  const pathAndQuery = hash === -1 ? unescaped : unescaped.slice(0, hash);
  const encodedFragment = hash === -1 ? "" : unescaped.slice(hash + 1);
  const question = pathAndQuery.indexOf("?");
  const encodedPath = question === -1 ? pathAndQuery : pathAndQuery.slice(0, question);
  const encodedQuery = question === -1 ? "" : pathAndQuery.slice(question + 1);
  try {
    return {
      external: EXTERNAL_TARGET.test(unescaped),
      fragment: decodeURIComponent(encodedFragment),
      path: decodeURIComponent(encodedPath),
      query: decodeURIComponent(encodedQuery),
    };
  } catch {
    return null;
  }
}

export async function checkMarkdownFiles(root, files) {
  const normalizedRoot = path.resolve(root);
  const markdownFiles = new Set(files.map((file) => file.split(path.sep).join("/")));
  const sources = new Map();
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

  const anchorsFor = async (file, absolute) => {
    if (anchors.has(file)) return anchors.get(file);
    const source = sources.get(file) ?? (await fs.readFile(absolute, "utf8"));
    const result = markdownAnchors(source);
    anchors.set(file, result);
    return result;
  };

  for (const [file, source] of sources) {
    for (const target of extractTargets(source)) {
      const location = `${file}:${target.line}:${target.column}`;
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
      if (decoded.fragment && (markdownFiles.has(relative) || /\.md$/i.test(relative))) {
        const targetAnchors = await anchorsFor(relative, absolute);
        if (!targetAnchors.has(decoded.fragment)) {
          problems.push(`${location}: missing heading "#${decoded.fragment}" in ${relative}`);
        }
      }
    }
  }
  return problems.sort();
}
