import fs from "node:fs/promises";
import path from "node:path";

const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const HTML_ATTRIBUTE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const REFERENCE_DEFINITION =
  /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const REFERENCE_USE = /(!?)\[([^\]]*)\]\s*\[([^\]]*)\]/g;

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

function unescapeMarkdown(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replace(/\\([\\!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g, "$1");
}

function headingText(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "");
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
      /^\s{0,3}(?:=+|-+)\s*$/.test(maskedLines[index + 1])
    ) {
      addHeading(originalLines[index]);
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
  try {
    return decodeURIComponent(unescapeMarkdown(target));
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
      if (!decoded || EXTERNAL_TARGET.test(decoded)) continue;

      const hash = decoded.indexOf("#");
      const rawPath = hash === -1 ? decoded : decoded.slice(0, hash);
      const fragment = hash === -1 ? "" : decoded.slice(hash + 1);
      const pathWithoutQuery = rawPath.split("?", 1)[0];
      const relative = pathWithoutQuery
        ? pathWithoutQuery.startsWith("/")
          ? pathWithoutQuery.slice(1)
          : path.posix.normalize(path.posix.join(path.posix.dirname(file), pathWithoutQuery))
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
      if (fragment && (markdownFiles.has(relative) || /\.md$/i.test(relative))) {
        const targetAnchors = await anchorsFor(relative, absolute);
        if (!targetAnchors.has(fragment)) {
          problems.push(`${location}: missing heading "#${fragment}" in ${relative}`);
        }
      }
    }
  }
  return problems.sort();
}
