import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const HTML_ENTITY = /&(?:#[xX][0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi;
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)\s*$/;
const HTML_BLOCK_TAG =
  /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;
const RAW_HTML_BLOCKS = [
  { closing: /-->/, opening: /^\s{0,3}<!--/ },
  { closing: /\?>/, opening: /^\s{0,3}<\?/ },
  { closing: />/, opening: /^\s{0,3}<![A-Z]/ },
  { closing: /\]\]>/, opening: /^\s{0,3}<!\[CDATA\[/ },
];
const INLINE_HTML_TAG =
  /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)$/s;
const AUTOLINK_URI = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;
const AUTOLINK_EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

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
  return { content, depth, offset: line.length - content.length };
}

function lineKeepsParagraphOpen(content, continuesParagraph = false) {
  return (
    !/^\s{0,3}#{1,6}(?:\s|$)/.test(content) &&
    !SETEXT_UNDERLINE.test(content) &&
    (continuesParagraph || !parseReferenceDefinition(content))
  );
}

function maskCodeSpans(source) {
  let masked = source;
  for (let cursor = 0; cursor < masked.length; ) {
    if (masked[cursor] !== "`" || isEscaped(masked, cursor)) {
      cursor += 1;
      continue;
    }
    let openingEnd = cursor;
    while (masked[openingEnd] === "`") openingEnd += 1;
    const delimiterLength = openingEnd - cursor;
    const blankLine = masked.slice(openingEnd).match(/\r?\n[ \t]*\r?\n/);
    const closingLimit = blankLine ? openingEnd + blankLine.index : masked.length;
    let closing = openingEnd;
    while (closing < closingLimit) {
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
    if (closing >= closingLimit) cursor = openingEnd;
  }
  return masked;
}

function maskRawHtmlBlocks(source) {
  const lines = source.split("\n");
  const containers = markdownContainerLines(lines);
  let block = null;
  let paragraphOpen = false;
  let paragraphContainer = "";
  for (let index = 0; index < lines.length; index += 1) {
    const quote = containers[index];
    if (block && block.container !== quote.container) block = null;
    if (block) {
      if (block.untilBlank && !/\S/.test(quote.content)) {
        block = null;
        paragraphOpen = false;
        continue;
      }
      const closes = block.closingTag?.test(quote.content) ?? false;
      lines[index] = " ".repeat(lines[index].length);
      if (closes) block = null;
      paragraphOpen = false;
      continue;
    }
    if (!/\S/.test(quote.content)) {
      paragraphOpen = false;
      continue;
    }
    const continuesParagraph = paragraphOpen && paragraphContainer === quote.container;

    const rawBlock = RAW_HTML_BLOCKS.find(({ opening }) => opening.test(quote.content));
    if (rawBlock) {
      const opening = quote.content.match(rawBlock.opening);
      const closes = rawBlock.closing.test(quote.content.slice(opening?.[0].length ?? 0));
      lines[index] = " ".repeat(lines[index].length);
      if (!closes) block = { closingTag: rawBlock.closing, container: quote.container };
      paragraphOpen = false;
      continue;
    }

    const typeOne = quote.content.match(/^\s{0,3}<(script|pre|style|textarea)(?:\s|>|$)/i);
    if (typeOne) {
      const closingTag = new RegExp(`</${typeOne[1]}\\s*>`, "i");
      const closes = closingTag.test(quote.content.slice(typeOne[0].length));
      lines[index] = " ".repeat(lines[index].length);
      if (!closes) block = { closingTag, container: quote.container };
      paragraphOpen = false;
      continue;
    }

    const typeSix = quote.content.match(/^\s{0,3}<\/?([a-z][a-z0-9-]*)(?:\s|\/?>|$)/i);
    if (typeSix && HTML_BLOCK_TAG.test(typeSix[1])) {
      lines[index] = " ".repeat(lines[index].length);
      block = { container: quote.container, untilBlank: true };
      paragraphOpen = false;
      continue;
    }

    const typeSeven = quote.content.match(/^\s{0,3}(<[^\n]*>)\s*$/);
    if (!continuesParagraph && typeSeven && INLINE_HTML_TAG.test(typeSeven[1])) {
      lines[index] = " ".repeat(lines[index].length);
      block = { container: quote.container, untilBlank: true };
      paragraphOpen = false;
      continue;
    }
    paragraphOpen = lineKeepsParagraphOpen(quote.content, continuesParagraph);
    paragraphContainer = quote.container;
  }
  return lines.join("\n");
}

function maskIgnoredMarkdown(source) {
  const lines = source.split("\n");
  const containers = markdownContainerLines(lines);
  let fence = null;
  let indentedCode = false;
  let paragraphOpen = false;
  let paragraphContainer = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const blockQuote = containers[index];
    const content = blockQuote.content;
    const marker = content.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence && fence.container !== blockQuote.container) fence = null;
    if (fence) {
      lines[index] = " ".repeat(line.length);
      paragraphOpen = false;
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        /^[ \t]*$/.test(marker[2])
      ) {
        fence = null;
      }
      continue;
    }
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = {
        character: marker[1][0],
        container: blockQuote.container,
        length: marker[1].length,
      };
      lines[index] = " ".repeat(line.length);
      indentedCode = false;
      paragraphOpen = false;
      continue;
    }
    if (!/\S/.test(content)) {
      paragraphOpen = false;
      continue;
    }
    const continuesParagraph =
      paragraphOpen && paragraphContainer === blockQuote.container && !blockQuote.startsListItem;
    if (/^(?: {4}| {0,3}\t)/.test(content) && (indentedCode || !continuesParagraph)) {
      lines[index] = " ".repeat(line.length);
      indentedCode = true;
      paragraphOpen = false;
      continue;
    }
    indentedCode = false;

    lines[index] = line;
    paragraphOpen = lineKeepsParagraphOpen(content, continuesParagraph);
    paragraphContainer = blockQuote.container;
  }
  const html = maskCodeSpans(
    lines.join("\n").replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " ")),
  );
  const inspection = inspectHtml(html);
  let markdown = maskRawHtmlBlocks(html);
  for (const range of [...inspection.tagRanges].sort((left, right) => right.start - left.start)) {
    markdown = maskRangePreservingLines(markdown, range.start, range.end);
  }
  return {
    attributes: inspection.attributes,
    markdown,
  };
}

const entityDecoder = new JSDOM("").window.document.createElement("textarea");

function inspectHtml(source) {
  const dom = new JSDOM(source, { includeNodeLocations: true });
  try {
    const attributes = [];
    const tagRanges = [];
    for (const element of dom.window.document.querySelectorAll("*")) {
      const location = dom.nodeLocation(element);
      const startTag = location?.startTag;
      const validStartTag =
        startTag && INLINE_HTML_TAG.test(source.slice(startTag.startOffset, startTag.endOffset));
      if (validStartTag) {
        tagRanges.push({ end: startTag.endOffset, start: startTag.startOffset });
      }
      const endTag = location?.endTag;
      if (endTag && INLINE_HTML_TAG.test(source.slice(endTag.startOffset, endTag.endOffset))) {
        tagRanges.push({ end: endTag.endOffset, start: endTag.startOffset });
      }
      if (!validStartTag || !location.attrs) continue;
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
    return { attributes, tagRanges };
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
  let rendered = value;
  for (const reference of [...referenceUses(value)].reverse()) {
    rendered = `${rendered.slice(0, reference.start)}${reference.label}${rendered.slice(
      reference.end,
    )}`;
  }
  return rendered;
}

function inlineHeadingText(value) {
  const delimiterSource = maskCodeSpans(value);
  const matchedUnderscores = matchedEmphasisDelimiters(delimiterSource, "_");
  let result = "";
  for (let cursor = 0; cursor < value.length; ) {
    if (value[cursor] !== "`") {
      if (value[cursor] === "_") {
        let runEnd = cursor;
        while (value[runEnd] === "_") runEnd += 1;
        for (let index = cursor; index < runEnd; index += 1) {
          if (!matchedUnderscores.has(index)) result += "_";
        }
        cursor = runEnd;
        continue;
      }
      if (!/[*~]/.test(value[cursor])) result += value[cursor];
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

function matchedEmphasisDelimiters(value, character) {
  const runs = [];
  const isWhitespace = (candidate) => candidate === "" || /\s/u.test(candidate);
  const isPunctuation = (candidate) => /[\p{P}\p{S}]/u.test(candidate);
  for (let cursor = 0; cursor < value.length; ) {
    if (value[cursor] !== character || isEscaped(value, cursor)) {
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (value[end] === character) end += 1;
    const before = value[cursor - 1] ?? "";
    const after = value[end] ?? "";
    const leftFlanking =
      !isWhitespace(after) &&
      (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
    const rightFlanking =
      !isWhitespace(before) &&
      (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
    const canOpen = leftFlanking && (character !== "_" || !rightFlanking || isPunctuation(before));
    const canClose = rightFlanking && (character !== "_" || !leftFlanking || isPunctuation(after));
    runs.push({
      canClose,
      canOpen,
      end,
      remaining: end - cursor,
      start: cursor,
      usedFromEnd: 0,
      usedFromStart: 0,
    });
    cursor = end;
  }

  const matched = new Set();
  for (let closerIndex = 0; closerIndex < runs.length; closerIndex += 1) {
    const closer = runs[closerIndex];
    while (closer.canClose && closer.remaining > 0) {
      let opener = null;
      for (let openerIndex = closerIndex - 1; openerIndex >= 0; openerIndex -= 1) {
        const candidate = runs[openerIndex];
        if (!candidate.canOpen || candidate.remaining === 0) continue;
        const blockedByRuleOfThree =
          (candidate.canClose || closer.canOpen) &&
          (candidate.remaining + closer.remaining) % 3 === 0 &&
          candidate.remaining % 3 !== 0 &&
          closer.remaining % 3 !== 0;
        if (!blockedByRuleOfThree) {
          opener = candidate;
          break;
        }
      }
      if (!opener) break;

      const used = opener.remaining >= 2 && closer.remaining >= 2 ? 2 : 1;
      for (let offset = 0; offset < used; offset += 1) {
        matched.add(opener.end - opener.usedFromEnd - offset - 1);
        matched.add(closer.start + closer.usedFromStart + offset);
      }
      opener.remaining -= used;
      opener.usedFromEnd += used;
      closer.remaining -= used;
      closer.usedFromStart += used;
    }
  }
  return matched;
}

function inlineLinkLabels(value) {
  const links = inlineLinks(value).sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  let cursor = 0;
  let rendered = "";
  for (const link of links) {
    if (link.start < cursor) continue;
    rendered += value.slice(cursor, link.start);
    rendered += inlineLinkLabels(link.label);
    cursor = link.end;
  }
  return `${rendered}${value.slice(cursor)}`;
}

function headingText(value) {
  const renderedLinks = inlineLinkLabels(referenceLabels(value));
  return inlineHeadingText(
    renderedLinks.replace(/<([^<>]*)>/g, (_match, content) =>
      AUTOLINK_URI.test(content) || AUTOLINK_EMAIL.test(content) ? content : "",
    ),
  );
}

function startsMarkdownBlock(line) {
  return (
    /^\s{0,3}(?:#{1,6}(?:\s|$)|>|(?:[*+-]|\d{1,9}[.)])\s+)/.test(line) ||
    /^\s{4}/.test(line) ||
    Boolean(parseReferenceDefinition(line)) ||
    SETEXT_UNDERLINE.test(line)
  );
}

function listStrippedLine(line) {
  let content = line;
  let offset = 0;
  let startsListItem = false;
  while (true) {
    const marker = content.match(/^\s{0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+/);
    if (!marker) return { content, offset, startsListItem };
    content = content.slice(marker[0].length);
    offset += marker[0].length;
    startsListItem = true;
  }
}

function markdownContainerLines(lines) {
  let list = null;
  let nextListItem = 0;
  return lines.map((line) => {
    const quoted = blockQuoteLine(line);
    if (list?.depth !== quoted.depth) list = null;

    let content = quoted.content;
    let offset = quoted.offset;
    if (!/\S/.test(content)) {
      return {
        container: `${quoted.depth}:${list?.items.join("/") ?? ""}`,
        content,
        depth: quoted.depth,
        offset,
        startsListItem: false,
      };
    }

    let continuationIndent = 0;
    if (list) {
      const leadingSpaces = content.match(/^ */)?.[0].length ?? 0;
      const indentIndex = list.indents.findLastIndex((indent) => indent <= leadingSpaces);
      if (indentIndex === -1) {
        list = null;
      } else {
        continuationIndent = list.indents[indentIndex];
        list.indents.length = indentIndex + 1;
        list.items.length = indentIndex + 1;
        content = content.slice(continuationIndent);
        offset += continuationIndent;
      }
    }

    const listed = listStrippedLine(content);
    content = listed.content;
    offset += listed.offset;
    if (listed.startsListItem) {
      const contentIndent = offset - quoted.offset;
      nextListItem += 1;
      if (!list || continuationIndent === 0) {
        list = {
          depth: quoted.depth,
          indents: [contentIndent],
          items: [nextListItem],
        };
      } else if (list.indents.at(-1) !== contentIndent) {
        list.indents.push(contentIndent);
        list.items.push(nextListItem);
      } else {
        list.items[list.items.length - 1] = nextListItem;
      }
    }

    return {
      container: `${quoted.depth}:${list?.items.join("/") ?? ""}`,
      content,
      depth: quoted.depth,
      offset,
      startsListItem: listed.startsListItem,
    };
  });
}

export function isMarkdownFile(file) {
  return /\.(?:md|markdown)$/i.test(file);
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
  const headingLines = markdownContainerLines(maskedLines);
  const originalHeadingLines = markdownContainerLines(originalLines);
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
      !startsMarkdownBlock(line) &&
      headingLines[index + 1].container === headingLines[index].container &&
      SETEXT_UNDERLINE.test(headingLines[index + 1].content)
    ) {
      let firstLine = index;
      while (
        firstLine > 0 &&
        headingLines[firstLine - 1].container === headingLines[index].container &&
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
  for (const attribute of maskedSources.attributes) {
    if (attribute.name === "id" || (attribute.tag === "a" && attribute.name === "name")) {
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

function definitionTitleEnd(line, start) {
  const opener = line[start];
  const closer = opener === "(" ? ")" : opener;
  if (!['"', "'", "("].includes(opener)) return -1;
  let cursor = start + 1;
  while (cursor < line.length) {
    if (line[cursor] === "\\" && cursor + 1 < line.length) {
      cursor += 2;
    } else if (line[cursor] === closer) {
      cursor += 1;
      while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
      return cursor === line.length ? cursor : -1;
    } else {
      cursor += 1;
    }
  }
  return -1;
}

function definitionRemainder(line, start) {
  let cursor = start;
  while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
  if (cursor === line.length) return { hasTitle: false };
  if (cursor === start || definitionTitleEnd(line, cursor) === -1) return null;
  return { hasTitle: true };
}

function definitionDestination(line, start) {
  let cursor = start;
  let targetStart = cursor;
  let targetEnd = cursor;
  if (line[cursor] === "<") {
    cursor += 1;
    targetStart = cursor;
    while (cursor < line.length && line[cursor] !== ">") {
      if (line[cursor] === "<") return null;
      if (line[cursor] === "\\") cursor += 1;
      cursor += 1;
    }
    if (line[cursor] !== ">") return null;
    targetEnd = cursor;
    cursor += 1;
  } else {
    let depth = 0;
    while (cursor < line.length && !/[ \t]/.test(line[cursor])) {
      const character = line[cursor];
      if (character === "\\" && cursor + 1 < line.length) {
        cursor += 2;
        continue;
      }
      if (character === "<" || character === ">" || character.charCodeAt(0) < 0x20) return null;
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        if (depth === 0) return null;
        depth -= 1;
      }
      cursor += 1;
    }
    if (cursor === start || depth !== 0) return null;
    targetEnd = cursor;
  }
  const remainder = definitionRemainder(line, cursor);
  if (!remainder) return null;
  return {
    ...remainder,
    target: line.slice(targetStart, targetEnd),
    targetStart,
  };
}

function parseReferenceDefinition(line) {
  const indent = line.match(/^[ \t]{0,3}/)?.[0].length ?? 0;
  if (line[indent] !== "[" || line[indent + 1] === "^") return null;
  const labelEnd = findClosingBracket(line, indent + 1);
  if (labelEnd === -1 || labelEnd === indent + 1 || line[labelEnd + 1] !== ":") return null;
  let cursor = labelEnd + 2;
  while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
  const label = line.slice(indent + 1, labelEnd);
  if (cursor === line.length) return { label, startOnly: true };
  const destination = definitionDestination(line, cursor);
  return destination ? { ...destination, label, startOnly: false } : null;
}

function parseReferenceContinuation(line) {
  const indent = line.match(/^[ \t]{0,3}/)?.[0].length ?? 0;
  return definitionDestination(line, indent);
}

function isContinuedDefinitionTitle(line) {
  const indent = line.match(/^[ \t]{0,3}/)?.[0].length ?? 0;
  return definitionTitleEnd(line, indent) !== -1;
}

function skipInlineWhitespace(value, cursor) {
  let lineEndings = 0;
  while (cursor < value.length) {
    if (value[cursor] === " " || value[cursor] === "\t") {
      cursor += 1;
      continue;
    }
    if (value[cursor] === "\r" || value[cursor] === "\n") {
      lineEndings += 1;
      if (lineEndings > 1) return -1;
      if (value[cursor] === "\r" && value[cursor + 1] === "\n") cursor += 1;
      cursor += 1;
      continue;
    }
    break;
  }
  return cursor;
}

function referenceUses(value) {
  const references = [];
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const image = value[cursor] === "!" && value[cursor + 1] === "[";
    const labelStart = image ? cursor + 1 : cursor;
    if (value[labelStart] !== "[" || isEscaped(value, labelStart)) continue;
    const labelEnd = findClosingBracket(value, labelStart + 1);
    if (labelEnd === -1) continue;
    const referenceStart = skipInlineWhitespace(value, labelEnd + 1);
    if (referenceStart === -1 || value[referenceStart] !== "[") continue;
    const referenceEnd = findClosingBracket(value, referenceStart + 1);
    if (referenceEnd === -1) continue;
    references.push({
      end: referenceEnd + 1,
      image,
      label: value.slice(labelStart + 1, labelEnd),
      reference: value.slice(referenceStart + 1, referenceEnd),
      start: cursor,
    });
    cursor = referenceEnd;
  }
  return references;
}

function containsBlankLine(value) {
  return /\n[ \t]*\n/.test(value.replace(/\r\n?/g, "\n"));
}

function closingParenthesis(line, cursor) {
  cursor = skipInlineWhitespace(line, cursor);
  if (cursor === -1) return -1;
  if (line[cursor] === ")") return cursor;

  const opener = line[cursor];
  const closer = opener === "(" ? ")" : opener;
  if (!['"', "'", "("].includes(opener)) return -1;
  cursor += 1;
  const titleStart = cursor;
  while (cursor < line.length) {
    if (line[cursor] === "\\") {
      cursor += 2;
    } else if (line[cursor] === closer) {
      if (containsBlankLine(line.slice(titleStart, cursor))) return -1;
      cursor += 1;
      cursor = skipInlineWhitespace(line, cursor);
      if (cursor === -1) return -1;
      return line[cursor] === ")" ? cursor : -1;
    } else {
      cursor += 1;
    }
  }
  return -1;
}

function inlineDestination(line, open) {
  let cursor = skipInlineWhitespace(line, open + 1);
  if (cursor === -1) return null;
  let targetStart = cursor;
  let targetEnd = cursor;

  if (line[cursor] === "<") {
    targetStart += 1;
    cursor += 1;
    while (cursor < line.length && line[cursor] !== ">") {
      if (line[cursor] === "\n") return null;
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
      } else if (/\s/.test(character)) {
        if (depth > 0) return null;
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
          end: nested.end + labelOffset,
          start: nested.start + labelOffset,
        });
      }
    }
    links.push({
      end: destination.closing + 1,
      image,
      label: line.slice(labelStart + 1, labelEnd),
      start: cursor,
      target: destination.target,
    });
    cursor = destination.closing;
  }
  return links;
}

function normalizeReference(value) {
  return unescapeMarkdown(value).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function sourceLocation(source, index) {
  const before = source.slice(0, index);
  return {
    column: index - before.lastIndexOf("\n"),
    line: before.split("\n").length,
  };
}

function extractTargets(source) {
  const maskedSources = maskIgnoredMarkdown(source);
  const masked = maskedSources.markdown;
  const maskedLines = masked.split("\n");
  const containerLines = markdownContainerLines(maskedLines);
  const targets = [];
  const definitions = new Map();
  const definitionLines = new Set();
  let paragraphContainer = "";
  let paragraphOpen = false;
  const continuedTitleAt = (index, container) => {
    const title = containerLines[index];
    return Boolean(
      title &&
        title.container === container &&
        !title.startsListItem &&
        isContinuedDefinitionTitle(title.content),
    );
  };

  for (let index = 0; index < maskedLines.length; index += 1) {
    const line = containerLines[index];
    if (!/\S/.test(line.content)) {
      paragraphOpen = false;
      continue;
    }
    const continuesParagraph =
      paragraphOpen && paragraphContainer === line.container && !line.startsListItem;
    const definition = continuesParagraph ? null : parseReferenceDefinition(line.content);
    if (definition && !definition.startOnly) {
      const label = normalizeReference(definition.label);
      if (!definitions.has(label)) {
        definitions.set(label, { line: index + 1, target: definition.target });
        targets.push({
          column: line.offset + definition.targetStart + 1,
          line: index + 1,
          target: definition.target,
        });
      }
      definitionLines.add(index);
      if (!definition.hasTitle && continuedTitleAt(index + 1, line.container)) {
        definitionLines.add(index + 1);
        index += 1;
      }
      paragraphOpen = false;
      paragraphContainer = line.container;
      continue;
    }
    const nextLine = containerLines[index + 1];
    const continuation =
      nextLine?.container === line.container && !nextLine.startsListItem
        ? parseReferenceContinuation(nextLine.content)
        : null;
    if (definition?.startOnly && continuation) {
      const label = normalizeReference(definition.label);
      if (!definitions.has(label)) {
        definitions.set(label, { line: index + 1, target: continuation.target });
        targets.push({
          column: nextLine.offset + continuation.targetStart + 1,
          line: index + 2,
          target: continuation.target,
        });
      }
      definitionLines.add(index);
      definitionLines.add(index + 1);
      const lastDefinitionLine =
        !continuation.hasTitle && continuedTitleAt(index + 2, line.container)
          ? index + 2
          : index + 1;
      definitionLines.add(lastDefinitionLine);
      paragraphOpen = false;
      paragraphContainer = line.container;
      index = lastDefinitionLine;
      continue;
    }
    paragraphOpen = definition?.startOnly
      ? true
      : lineKeepsParagraphOpen(line.content, continuesParagraph);
    paragraphContainer = line.container;
  }
  const inlineSource = maskedLines
    .map((line, index) => (definitionLines.has(index) ? " ".repeat(line.length) : line))
    .join("\n");
  const inline = inlineLinks(inlineSource);
  targets.push(
    ...inline.map((link) => ({
      ...link,
      ...sourceLocation(inlineSource, link.start),
    })),
  );
  let referenceSource = inlineSource;
  for (const link of [...inline].reverse()) {
    referenceSource = maskRangePreservingLines(referenceSource, link.start, link.end);
  }
  for (const reference of referenceUses(referenceSource)) {
    const label = normalizeReference(reference.reference || reference.label);
    targets.push({
      ...sourceLocation(referenceSource, reference.start),
      reference: label,
    });
  }
  for (const attribute of maskedSources.attributes) {
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
  const components = relative.split("/").filter((component) => component && component !== ".");
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
      let fragmentAbsolute = absolute;
      let fragmentRelative = relative;
      if (decoded.fragment && (await fs.lstat(absolute)).isDirectory()) {
        const entries = await fs.readdir(absolute);
        const readme =
          ["README.md", "README.markdown"].find((candidate) => entries.includes(candidate)) ??
          entries.find((entry) => /^readme\.(?:md|markdown)$/i.test(entry));
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
        fragmentAbsolute &&
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
