import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const HTML_ENTITY = /&(?:#[xX][0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi;
const REFERENCE_DEFINITION =
  /^\s{0,3}\[(?!\^)([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const REFERENCE_DEFINITION_START = /^\s{0,3}\[(?!\^)([^\]]+)\]:[ \t]*$/;
const REFERENCE_DEFINITION_CONTINUATION =
  /^\s{0,3}(?:<([^>]+)>|(\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const REFERENCE_USE = /(!?)\[([^\]]*)\]\s*\[([^\]]*)\]/g;
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)\s*$/;
const HTML_BLOCK_TAG =
  /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;

function maskRange(value, start, end) {
  return `${value.slice(0, start)}${" ".repeat(end - start)}${value.slice(end)}`;
}

function maskRangePreservingLines(value, start, end) {
  return `${value.slice(0, start)}${value
    .slice(start, end)
    .replace(/[^\n]/g, " ")}${value.slice(end)}`;
}

function blockQuoteLine(line) {
  let content = line;
  let depth = 0;
  while (true) {
    const prefix = content.match(/^ {0,3}>[ \t]?/);
    if (!prefix) break;
    content = content.slice(prefix[0].length);
    depth += 1;
  }
  return { content, depth };
}

function lineKeepsParagraphOpen(content) {
  return (
    !/^\s{0,3}#{1,6}(?:\s|$)/.test(content) &&
    !SETEXT_UNDERLINE.test(content) &&
    !REFERENCE_DEFINITION.test(content) &&
    !REFERENCE_DEFINITION_START.test(content)
  );
}

function maskCodeSpans(source) {
  let masked = source;
  for (let cursor = 0; cursor < masked.length; ) {
    if (masked[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let openingEnd = cursor;
    while (masked[openingEnd] === "`") openingEnd += 1;
    const delimiterLength = openingEnd - cursor;
    let closing = openingEnd;
    while (closing < masked.length) {
      if (masked[closing] !== "`") {
        closing += 1;
        continue;
      }
      let closingEnd = closing;
      while (masked[closingEnd] === "`") closingEnd += 1;
      if (closingEnd - closing === delimiterLength) {
        masked = maskRangePreservingLines(masked, cursor, closingEnd);
        cursor = closingEnd;
        break;
      }
      closing = closingEnd;
    }
    if (closing >= masked.length) cursor = openingEnd;
  }
  return masked;
}

function maskRawHtmlBlocks(source) {
  const lines = source.split("\n");
  let block = null;
  for (let index = 0; index < lines.length; index += 1) {
    const quote = blockQuoteLine(lines[index]);
    if (block && block.depth !== quote.depth) block = null;
    if (block) {
      if (block.untilBlank && !/\S/.test(quote.content)) {
        block = null;
        continue;
      }
      const closes = block.closingTag?.test(quote.content) ?? false;
      lines[index] = " ".repeat(lines[index].length);
      if (closes) block = null;
      continue;
    }

    const typeOne = quote.content.match(/^\s{0,3}<(script|pre|style|textarea)(?:\s|>|$)/i);
    if (typeOne) {
      const closingTag = new RegExp(`</${typeOne[1]}\\s*>`, "i");
      const closes = closingTag.test(quote.content.slice(typeOne[0].length));
      lines[index] = " ".repeat(lines[index].length);
      if (!closes) block = { closingTag, depth: quote.depth };
      continue;
    }

    const typeSix = quote.content.match(/^\s{0,3}<\/?([a-z][a-z0-9-]*)(?:\s|\/?>|$)/i);
    if (typeSix && HTML_BLOCK_TAG.test(typeSix[1])) {
      lines[index] = " ".repeat(lines[index].length);
      block = { depth: quote.depth, untilBlank: true };
    }
  }
  return lines.join("\n");
}

function maskIgnoredMarkdown(source) {
  const lines = source.split("\n");
  let fence = null;
  let indentedCode = false;
  let paragraphOpen = false;
  let paragraphQuoteDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const blockQuote = blockQuoteLine(line);
    const content = blockQuote.content;
    const marker = content.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      lines[index] = " ".repeat(line.length);
      paragraphOpen = false;
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      lines[index] = " ".repeat(line.length);
      indentedCode = false;
      paragraphOpen = false;
      continue;
    }
    if (!/\S/.test(content)) {
      paragraphOpen = false;
      continue;
    }
    const continuesParagraph = paragraphOpen && paragraphQuoteDepth === blockQuote.depth;
    if (/^(?: {4}| {0,3}\t)/.test(content) && (indentedCode || !continuesParagraph)) {
      lines[index] = " ".repeat(line.length);
      indentedCode = true;
      paragraphOpen = false;
      continue;
    }
    indentedCode = false;

    lines[index] = line;
    paragraphOpen = lineKeepsParagraphOpen(content);
    paragraphQuoteDepth = blockQuote.depth;
  }
  const html = maskCodeSpans(
    lines.join("\n").replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " ")),
  );
  return {
    html,
    markdown: maskRawHtmlBlocks(html),
  };
}

const entityDecoder = new JSDOM("").window.document.createElement("textarea");

function htmlAttributes(source) {
  const dom = new JSDOM(source, { includeNodeLocations: true });
  try {
    const attributes = [];
    for (const element of dom.window.document.querySelectorAll("*")) {
      const location = dom.nodeLocation(element);
      if (!location?.attrs) continue;
      for (const name of ["href", "id", "name", "src"]) {
        const attribute = location.attrs[name];
        if (!attribute || !element.hasAttribute(name)) continue;
        attributes.push({
          column: attribute.startCol,
          line: attribute.startLine,
          name,
          tag: element.localName,
          value: element.getAttribute(name) ?? "",
        });
      }
    }
    return attributes;
  } finally {
    dom.window.close();
  }
}

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

function isEscaped(value, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function referenceLabels(value) {
  return value.replace(REFERENCE_USE, (match, image, label, _reference, offset, source) =>
    isEscaped(source, offset + image.length) ? match : label,
  );
}

function inlineHeadingText(value) {
  let result = "";
  for (let cursor = 0; cursor < value.length; ) {
    if (value[cursor] !== "`") {
      if (!/[*_~]/.test(value[cursor])) result += value[cursor];
      cursor += 1;
      continue;
    }

    let delimiterEnd = cursor;
    while (value[delimiterEnd] === "`") delimiterEnd += 1;
    const delimiterLength = delimiterEnd - cursor;
    let closing = delimiterEnd;
    while (closing < value.length) {
      if (value[closing] !== "`") {
        closing += 1;
        continue;
      }
      let closingEnd = closing;
      while (value[closingEnd] === "`") closingEnd += 1;
      if (closingEnd - closing === delimiterLength) break;
      closing = closingEnd;
    }
    if (closing >= value.length) {
      cursor = delimiterEnd;
      continue;
    }

    let code = value.slice(delimiterEnd, closing).replace(/\s+/g, " ");
    if (/^ .* $/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
    result += code;
    cursor = closing + delimiterLength;
  }
  return result;
}

function headingText(value) {
  return inlineHeadingText(
    referenceLabels(value)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, ""),
  );
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
  const maskedSources = maskIgnoredMarkdown(source);
  const masked = maskedSources.markdown;
  const originalLines = source.split("\n");
  const maskedLines = masked.split("\n");
  const headingLines = maskedLines.map(blockQuoteLine);
  const originalHeadingLines = originalLines.map(blockQuoteLine);
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
    const line = headingLines[index].content;
    const atx = line.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/);
    if (atx) {
      const originalAtx = originalHeadingLines[index].content.match(
        /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/,
      );
      addHeading(originalAtx?.[1] ?? atx[1]);
    } else if (
      index + 1 < headingLines.length &&
      /\S/.test(line) &&
      headingLines[index + 1].depth === headingLines[index].depth &&
      SETEXT_UNDERLINE.test(headingLines[index + 1].content)
    ) {
      let firstLine = index;
      while (
        firstLine > 0 &&
        headingLines[firstLine - 1].depth === headingLines[index].depth &&
        /\S/.test(headingLines[firstLine - 1].content) &&
        !startsMarkdownBlock(headingLines[firstLine - 1].content)
      ) {
        firstLine -= 1;
      }
      addHeading(
        originalHeadingLines
          .slice(firstLine, index + 1)
          .map((entry) => entry.content)
          .join("\n"),
      );
    }
  }
  for (const attribute of htmlAttributes(maskedSources.html)) {
    if (attribute.tag === "a" && ["id", "name"].includes(attribute.name)) {
      anchors.add(unescapeMarkdown(attribute.value));
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

function closingParenthesis(line, cursor) {
  while (/[ \t]/.test(line[cursor] ?? "")) cursor += 1;
  if (line[cursor] === ")") return cursor;

  const opener = line[cursor];
  const closer = opener === "(" ? ")" : opener;
  if (!['"', "'", "("].includes(opener)) return -1;
  cursor += 1;
  while (cursor < line.length) {
    if (line[cursor] === "\\") {
      cursor += 2;
    } else if (line[cursor] === closer) {
      cursor += 1;
      while (/[ \t]/.test(line[cursor] ?? "")) cursor += 1;
      return line[cursor] === ")" ? cursor : -1;
    } else {
      cursor += 1;
    }
  }
  return -1;
}

function inlineDestination(line, open) {
  let cursor = open + 1;
  while (/[ \t]/.test(line[cursor] ?? "")) cursor += 1;
  let targetStart = cursor;
  let targetEnd = cursor;

  if (line[cursor] === "<") {
    targetStart += 1;
    cursor += 1;
    while (cursor < line.length && line[cursor] !== ">") {
      if (line[cursor] === "\\") cursor += 1;
      cursor += 1;
    }
    if (line[cursor] !== ">") return null;
    targetEnd = cursor;
    cursor += 1;
  } else {
    let depth = 0;
    while (cursor < line.length) {
      const character = line[cursor];
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        if (depth === 0) {
          return {
            closing: cursor,
            target: line.slice(targetStart, cursor),
          };
        }
        depth -= 1;
      } else if (/[ \t]/.test(character) && depth === 0) {
        break;
      }
      cursor += 1;
    }
    targetEnd = cursor;
  }

  const closing = closingParenthesis(line, cursor);
  if (closing === -1) return null;
  return {
    closing,
    target: line.slice(targetStart, targetEnd),
  };
}

function inlineLinks(line) {
  const links = [];
  for (let cursor = 0; cursor < line.length; cursor += 1) {
    const image = line[cursor] === "!" && line[cursor + 1] === "[";
    const labelStart = image ? cursor + 1 : cursor;
    if (line[labelStart] !== "[" || isEscaped(line, labelStart)) continue;
    const labelEnd = findClosingBracket(line, labelStart + 1);
    if (labelEnd === -1) continue;
    const open = labelEnd + 1;
    if (line[open] !== "(") continue;
    const destination = inlineDestination(line, open);
    if (!destination) continue;

    if (!image) {
      const labelOffset = labelStart + 1;
      for (const nested of inlineLinks(line.slice(labelOffset, labelEnd))) {
        if (!nested.image) continue;
        links.push({
          ...nested,
          column: nested.column + labelOffset,
          end: nested.end + labelOffset,
          start: nested.start + labelOffset,
        });
      }
    }
    links.push({
      column: cursor + 1,
      end: destination.closing + 1,
      image,
      start: cursor,
      target: destination.target,
    });
    cursor = destination.closing;
  }
  return links;
}

function normalizeReference(value) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function extractTargets(source) {
  const maskedSources = maskIgnoredMarkdown(source);
  const masked = maskedSources.markdown;
  const maskedLines = masked.split("\n");
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
      const opener = (match.index ?? 0) + match[1].length;
      if (isEscaped(references, opener)) continue;
      const label = normalizeReference(match[3] || match[2]);
      targets.push({
        column: (match.index ?? 0) + 1,
        line: index + 1,
        reference: label,
      });
    }
  }
  for (const attribute of htmlAttributes(maskedSources.html)) {
    if (!["href", "src"].includes(attribute.name)) continue;
    targets.push({
      column: attribute.column,
      line: attribute.line,
      target: attribute.value,
    });
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
