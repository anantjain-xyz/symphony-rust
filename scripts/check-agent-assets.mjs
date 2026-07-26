import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_MCP_NAMESPACE_PATTERN = "mcp__[A-Za-z0-9_-]+__";
const DEFAULT_PROMPT_RETURN_FUNCTION = "default_prompt_template";
const FORBIDDEN_PORTABLE_OWNER_PATTERN = "\\bpnpm\\b";
const REQUIRED_ALLOWED_ADAPTATIONS = new Map([
  [
    "pull",
    [
      {
        match:
          "7. Re-run the target repository's documented validation gate before pushing.",
        replacement:
          "7. Re-run validation (`pnpm verify:full`) before pushing.",
      },
    ],
  ],
  [
    "push",
    [
      {
        match:
          "- The target repository's documented validation gate has been run for the latest commit.",
        replacement:
          "- Validation gate has been run for the latest commit (`pnpm verify:full`).",
      },
    ],
  ],
]);

function resolveInside(root, path, errors, label) {
  if (typeof path !== "string" || path.trim() === "") {
    errors.push(`${label} must be a non-empty repository-relative path`);
    return null;
  }
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    errors.push(`${label} escapes the repository root: ${path}`);
    return null;
  }
  return absolute;
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function readJson(root, path, errors, label) {
  const absolute = resolveInside(root, path, errors, label);
  if (!absolute || !existsSync(absolute)) {
    if (absolute) errors.push(`${label} is missing at ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    errors.push(`${label} at ${path} is not valid JSON: ${error.message}`);
    return null;
  }
}

function walkFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function parseYamlStringScalar(value, path, line, key, errors) {
  const scalar = value.trim();
  if (scalar.startsWith('"')) {
    try {
      const parsed = JSON.parse(scalar);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Report the shared scalar error below.
    }
  } else if (scalar.startsWith("'")) {
    if (/^'(?:[^']|'')*'$/.test(scalar)) {
      return scalar.slice(1, -1).replaceAll("''", "'");
    }
  } else if (
    /^[\p{L}_][^\u0000-\u001f[\]{}]*$/u.test(scalar) &&
    !/:(?:\s|$)|(?:^|\s)#/.test(scalar) &&
    !/^(?:true|false|null|yes|no|on|off)$/i.test(scalar)
  ) {
    return scalar;
  }

  errors.push(
    `${path} frontmatter line ${line} ${key} must be a valid string scalar in the supported YAML subset`,
  );
  return null;
}

function parseFrontmatter(content, path, errors) {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    errors.push(`${path} must start with YAML frontmatter`);
    return null;
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    errors.push(`${path} has unterminated YAML frontmatter`);
    return null;
  }
  const values = {};
  for (const [index, line] of normalized.slice(4, end).split("\n").entries()) {
    if (line.trim() === "") continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) {
      errors.push(
        `${path} frontmatter line ${index + 2} is not a key/value pair`,
      );
      continue;
    }
    const [, key, value] = match;
    if (values[key] !== undefined) {
      errors.push(`${path} frontmatter repeats key ${key}`);
    }
    const parsed = parseYamlStringScalar(
      value,
      path,
      index + 2,
      key,
      errors,
    );
    if (parsed !== null) values[key] = parsed;
  }
  for (const required of ["name", "description"]) {
    if (!values[required]) {
      errors.push(`${path} frontmatter is missing required ${required}`);
    }
  }
  const body = normalized.slice(end + "\n---\n".length);
  if (stripMarkdownHtmlComments(body).trim() === "") {
    errors.push(
      `${path} must contain a non-empty Markdown instructional body after YAML frontmatter`,
    );
  }
  return values;
}

function discoverSkills(
  root,
  rootPath,
  expectedName,
  errors,
  label,
  manifestOnly = false,
) {
  const absolute = resolveInside(root, rootPath, errors, label);
  const skills = new Map();
  if (!absolute || !existsSync(absolute)) {
    if (absolute) errors.push(`${label} is missing at ${rootPath}`);
    return skills;
  }
  if (!statSync(absolute).isDirectory()) {
    errors.push(`${label} at ${rootPath} must be a directory`);
    return skills;
  }

  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) {
      errors.push(
        `${label} contains unexpected non-directory entry ${rootPath}/${entry.name}`,
      );
      continue;
    }
    const manifest = resolve(absolute, entry.name, "SKILL.md");
    const manifestPath = relativePath(root, manifest);
    if (!existsSync(manifest)) {
      errors.push(`${label} skill ${entry.name} is missing ${manifestPath}`);
      continue;
    }
    if (manifestOnly) {
      for (const companion of readdirSync(resolve(absolute, entry.name), {
        withFileTypes: true,
      })) {
        if (companion.name === "SKILL.md") continue;
        errors.push(
          `${label} skill ${entry.name} contains unbundled companion ${relativePath(
            root,
            resolve(absolute, entry.name, companion.name),
          )}; bundled skills may contain only SKILL.md`,
        );
      }
    }
    const content = readFileSync(manifest, "utf8");
    const frontmatter = parseFrontmatter(content, manifestPath, errors);
    const wanted = expectedName(entry.name);
    if (frontmatter?.name && frontmatter.name !== wanted) {
      errors.push(
        `${manifestPath} frontmatter name must be ${wanted}, received ${frontmatter.name}`,
      );
    }
    skills.set(entry.name, { content, manifestPath });
  }
  return skills;
}

function compareSets(label, expected, actual, errors) {
  for (const missing of [...expected].filter((item) => !actual.has(item)).sort()) {
    errors.push(`${label} is missing ${missing}`);
  }
  for (const extra of [...actual].filter((item) => !expected.has(item)).sort()) {
    errors.push(`${label} has undeclared extra ${extra}`);
  }
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const length = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < length; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        line: index + 1,
        expected: expectedLines[index] ?? "<end of file>",
        actual: actualLines[index] ?? "<end of file>",
      };
    }
  }
  return null;
}

function applyAdaptations(content, skillId, adaptations, errors) {
  let expected = content;
  for (const [index, adaptation] of (adaptations?.[skillId] ?? []).entries()) {
    if (
      typeof adaptation.match !== "string" ||
      adaptation.match === "" ||
      typeof adaptation.replacement !== "string"
    ) {
      errors.push(
        `allowed adaptation ${skillId}[${index}] must define non-empty match and string replacement`,
      );
      continue;
    }
    const count = expected.split(adaptation.match).length - 1;
    if (count !== 1) {
      errors.push(
        `allowed adaptation ${skillId}[${index}] must match owner exactly once; found ${count}`,
      );
      continue;
    }
    expected = expected.replace(adaptation.match, adaptation.replacement);
  }
  return expected;
}

function rustStringToken(content, start) {
  const raw = content.slice(start).match(/^(?:br|rb|r)(#*)"/);
  if (raw) {
    const hashes = raw[1];
    const valueStart = start + raw[0].length;
    const terminator = `"${hashes}`;
    const end = content.indexOf(terminator, valueStart);
    if (end === -1) return { end: content.length, value: null };
    return {
      end: end + terminator.length,
      value: content.slice(valueStart, end),
    };
  }

  const prefixLength = content[start] === "b" && content[start + 1] === '"' ? 1 : 0;
  if (content[start + prefixLength] !== '"') return null;
  let value = "";
  let escaped = false;
  for (let index = start + prefixLength + 1; index < content.length; index += 1) {
    const character = content[index];
    if (escaped) {
      const replacements = {
        "0": "\0",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      value += replacements[character] ?? character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return { end: index + 1, value };
    value += character;
  }
  return { end: content.length, value: null };
}

function rustTokens(content) {
  const tokens = [];
  for (let index = 0; index < content.length; ) {
    const character = content[index];
    const next = content[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      const end = content.indexOf("\n", index + 2);
      index = end === -1 ? content.length : end + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < content.length && depth > 0) {
        if (content[index] === "/" && content[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (content[index] === "*" && content[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    const string = rustStringToken(content, index);
    if (string) {
      if (string.value !== null) {
        tokens.push({ type: "string", value: string.value, index });
      }
      index = string.end;
      continue;
    }

    if (
      character === "'" &&
      (next === "\\" || content[index + 2] === "'")
    ) {
      let end = index + 1;
      let escaped = false;
      while (end < content.length) {
        const candidate = content[end];
        if (!escaped && candidate === "'") {
          end += 1;
          break;
        }
        escaped = !escaped && candidate === "\\";
        if (candidate !== "\\") escaped = false;
        end += 1;
      }
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < content.length && /[A-Za-z0-9_]/.test(content[end])) {
        end += 1;
      }
      tokens.push({
        type: "ident",
        value: content.slice(index, end),
        index,
      });
      index = end;
      continue;
    }

    tokens.push({ type: "punct", value: character, index });
    index += 1;
  }
  return tokens;
}

const rustClosingDelimiter = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

function matchingRustDelimiter(tokens, opening) {
  if (!rustClosingDelimiter.has(tokens[opening]?.value)) return null;
  const stack = [];
  for (let index = opening; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (rustClosingDelimiter.has(value)) {
      stack.push(rustClosingDelimiter.get(value));
    } else if ([")", "]", "}"].includes(value)) {
      if (stack.at(-1) !== value) return null;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return null;
}

function splitTopLevel(tokens, separator) {
  const groups = [];
  let start = 0;
  const stack = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (rustClosingDelimiter.has(value)) {
      stack.push(rustClosingDelimiter.get(value));
    } else if ([")", "]", "}"].includes(value)) {
      if (stack.at(-1) !== value) return null;
      stack.pop();
    } else if (value === separator && stack.length === 0) {
      groups.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  if (stack.length > 0) return null;
  groups.push(tokens.slice(start));
  return groups;
}

function macroInvocation(tokens, index, name) {
  if (
    tokens[index]?.type !== "ident" ||
    tokens[index].value !== name ||
    tokens[index + 1]?.value !== "!" ||
    !rustClosingDelimiter.has(tokens[index + 2]?.value)
  ) {
    return null;
  }
  const closing = matchingRustDelimiter(tokens, index + 2);
  return closing === null
    ? { arguments: null, end: tokens.length }
    : {
        arguments: tokens.slice(index + 3, closing),
        end: closing + 1,
      };
}

function singleStringArgument(tokens) {
  const withoutTrailingComma =
    tokens.at(-1)?.value === "," ? tokens.slice(0, -1) : tokens;
  return withoutTrailingComma.length === 1 &&
    withoutTrailingComma[0].type === "string"
    ? withoutTrailingComma[0].value
    : null;
}

function hasCfgAttribute(tokens) {
  return tokens.some(
    (token, index) =>
      token.value === "#" &&
      tokens[index + 1]?.value === "[" &&
      ["cfg", "cfg_attr"].includes(tokens[index + 2]?.value),
  );
}

function namedFunctionBody(tokens, functionName, inventoryFile, errors) {
  const matches = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (
      tokens[index].value !== "fn" ||
      tokens[index + 1]?.type !== "ident" ||
      tokens[index + 1].value !== functionName
    ) {
      continue;
    }
    let opening = index + 2;
    while (
      opening < tokens.length &&
      !["{", ";"].includes(tokens[opening].value)
    ) {
      opening += 1;
    }
    if (tokens[opening]?.value !== "{") continue;
    const closing = matchingRustDelimiter(tokens, opening);
    if (closing === null) {
      errors.push(`${inventoryFile} has an unterminated ${functionName} function`);
      continue;
    }
    matches.push({ functionIndex: index, start: opening + 1, end: closing });
    index = closing;
  }
  if (matches.length !== 1) {
    errors.push(
      `${inventoryFile} must define exactly one ${functionName} inventory function; found ${matches.length}`,
    );
    return null;
  }
  return matches[0];
}

function namedFunctionBodies(tokens, functionName) {
  const matches = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (
      tokens[index].value !== "fn" ||
      tokens[index + 1]?.type !== "ident" ||
      tokens[index + 1].value !== functionName
    ) {
      continue;
    }
    let opening = index + 2;
    while (
      opening < tokens.length &&
      !["{", ";"].includes(tokens[opening].value)
    ) {
      opening += 1;
    }
    if (tokens[opening]?.value !== "{") continue;
    const closing = matchingRustDelimiter(tokens, opening);
    if (closing === null) continue;
    matches.push({ start: opening + 1, end: closing });
    index = closing;
  }
  return matches;
}

function tailVectorInvocation(tokens, body, functionName, inventoryFile, errors) {
  const matches = [];
  for (let index = body.start; index < body.end; index += 1) {
    const invocation = macroInvocation(tokens, index, "vec");
    if (!invocation?.arguments || invocation.end !== body.end) continue;
    matches.push({ ...invocation, tokenIndex: index });
  }
  if (matches.length !== 1) {
    errors.push(
      `${inventoryFile} ${functionName} must return exactly one direct vec![...] inventory expression`,
    );
    return null;
  }
  return matches[0];
}

function macroRulesDefinition(tokens, start, end, name, inventoryFile, errors) {
  const matches = [];
  for (let index = start; index + 3 < end; index += 1) {
    if (
      tokens[index].value !== "macro_rules" ||
      tokens[index + 1]?.value !== "!" ||
      tokens[index + 2]?.value !== name ||
      !rustClosingDelimiter.has(tokens[index + 3]?.value)
    ) {
      continue;
    }
    const closing = matchingRustDelimiter(tokens, index + 3);
    if (closing === null || closing >= end) {
      errors.push(`${inventoryFile} has an unterminated macro_rules! ${name} definition`);
      continue;
    }
    matches.push({
      start: index,
      end: closing + 1,
      body: tokens.slice(index + 4, closing),
    });
    index = closing;
  }
  if (matches.length !== 1) {
    errors.push(
      `${inventoryFile} inventory function must define exactly one macro_rules! ${name}; found ${matches.length}`,
    );
    return null;
  }
  return matches[0];
}

function dynamicSkillInclude(argumentTokens, variableName) {
  const concat = macroInvocation(argumentTokens, 0, "concat");
  if (!concat?.arguments || concat.end !== argumentTokens.length) return null;
  const groups = splitTopLevel(concat.arguments, ",");
  if (groups === null) return null;
  if (groups.at(-1)?.length === 0) groups.pop();
  if (
    groups.length !== 3 ||
    groups[0].length !== 1 ||
    groups[0][0].type !== "string" ||
    groups[1].length !== 2 ||
    groups[1][0].value !== "$" ||
    groups[1][1].value !== variableName ||
    groups[2].length !== 1 ||
    groups[2][0].type !== "string"
  ) {
    return null;
  }
  return [groups[0][0].value, groups[2][0].value];
}

function rustStringConstant(tokens, constantName) {
  const values = [];
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (
      tokens[index].value !== "const" ||
      tokens[index + 1]?.value !== constantName
    ) {
      continue;
    }
    let equals = index + 2;
    while (
      equals < tokens.length &&
      !["=", ";"].includes(tokens[equals].value)
    ) {
      equals += 1;
    }
    if (tokens[equals]?.value !== "=") continue;
    let semicolon = equals + 1;
    while (semicolon < tokens.length && tokens[semicolon].value !== ";") {
      semicolon += 1;
    }
    const expression = tokens.slice(equals + 1, semicolon);
    values.push(
      expression.length === 1 && expression[0].type === "string"
        ? expression[0].value
        : null,
    );
  }
  return values;
}

function bundledSkillName(
  fields,
  variableName,
  sourceTokens,
  expectedPrefix,
  inventoryFile,
  errors,
) {
  const nameFields = fields.filter(
    (field) => field[0]?.value === "name" && field[1]?.value === ":",
  );
  if (nameFields.length !== 1) {
    errors.push(
      `${inventoryFile} skill! macro must define exactly one name field; found ${nameFields.length}`,
    );
    return false;
  }
  const expression = nameFields[0].slice(2);
  const format = macroInvocation(expression, 0, "format");
  const groups = format?.arguments
    ? splitTopLevel(format.arguments, ",")
    : null;
  if (groups?.at(-1)?.length === 0) groups.pop();
  if (
    !format?.arguments ||
    format.end !== expression.length ||
    groups === null ||
    groups.length !== 3 ||
    groups[0].length !== 1 ||
    groups[0][0].type !== "string" ||
    groups[0][0].value !== "{}{}" ||
    groups[1].length !== 1 ||
    groups[1][0].type !== "ident" ||
    groups[2].length !== 2 ||
    groups[2][0].value !== "$" ||
    groups[2][1].value !== variableName
  ) {
    errors.push(
      `${inventoryFile} skill! name field must format a constant prefix followed by the literal skill id`,
    );
    return false;
  }

  const prefixConstant = groups[1][0].value;
  const prefixValues = rustStringConstant(sourceTokens, prefixConstant);
  if (
    prefixValues.length !== 1 ||
    prefixValues[0] !== expectedPrefix
  ) {
    errors.push(
      `${inventoryFile} skill! runtime name prefix ${prefixConstant} must be the single string literal ${JSON.stringify(
        expectedPrefix,
      )}`,
    );
    return false;
  }
  return true;
}

function bundledSkillInclude(
  definition,
  sourceTokens,
  expectedPrefix,
  inventoryFile,
  errors,
) {
  const body = definition.body;
  const arrows = [];
  const stack = [];
  for (let index = 0; index + 1 < body.length; index += 1) {
    const value = body[index].value;
    if (rustClosingDelimiter.has(value)) {
      stack.push(rustClosingDelimiter.get(value));
    } else if ([")", "]", "}"].includes(value)) {
      if (stack.at(-1) !== value) break;
      stack.pop();
    } else if (
      value === "=" &&
      body[index + 1].value === ">" &&
      stack.length === 0
    ) {
      arrows.push(index);
    }
  }
  if (arrows.length !== 1) {
    errors.push(
      `${inventoryFile} skill! macro must contain exactly one unconditional expansion arm`,
    );
    return null;
  }

  const arrow = arrows[0];
  const pattern = body.slice(0, arrow);
  if (
    pattern.length !== 6 ||
    pattern[0].value !== "(" ||
    pattern[1].value !== "$" ||
    pattern[2].type !== "ident" ||
    pattern[3].value !== ":" ||
    pattern[4].value !== "literal" ||
    pattern[5].value !== ")"
  ) {
    errors.push(
      `${inventoryFile} skill! macro must match exactly one literal skill id`,
    );
    return null;
  }
  const variableName = pattern[2].value;
  const expansionOpening = arrow + 2;
  if (!rustClosingDelimiter.has(body[expansionOpening]?.value)) {
    errors.push(`${inventoryFile} skill! macro expansion must be a delimited expression`);
    return null;
  }
  const expansionClosing = matchingRustDelimiter(body, expansionOpening);
  const trailing = expansionClosing === null
    ? []
    : body.slice(expansionClosing + 1).filter((token) => token.value !== ";");
  if (expansionClosing === null || trailing.length !== 0) {
    errors.push(`${inventoryFile} skill! macro has unsupported tokens after its expansion`);
    return null;
  }

  const expansion = body.slice(expansionOpening + 1, expansionClosing);
  if (
    expansion[0]?.value !== "SkillFile" ||
    expansion[1]?.value !== "{"
  ) {
    errors.push(
      `${inventoryFile} skill! macro must expand directly to a SkillFile struct`,
    );
    return null;
  }
  const structClosing = matchingRustDelimiter(expansion, 1);
  if (structClosing !== expansion.length - 1) {
    errors.push(
      `${inventoryFile} skill! macro must return only the constructed SkillFile`,
    );
    return null;
  }
  const fields = splitTopLevel(expansion.slice(2, structClosing), ",");
  if (fields === null) {
    errors.push(`${inventoryFile} skill! macro has malformed SkillFile fields`);
    return null;
  }
  if (
    !bundledSkillName(
      fields,
      variableName,
      sourceTokens,
      expectedPrefix,
      inventoryFile,
      errors,
    )
  ) {
    return null;
  }
  const contentFields = fields.filter(
    (field) => field[0]?.value === "content" && field[1]?.value === ":",
  );
  if (contentFields.length !== 1) {
    errors.push(
      `${inventoryFile} skill! macro must define exactly one content field; found ${contentFields.length}`,
    );
    return null;
  }

  const expression = contentFields[0].slice(2);
  const include = macroInvocation(expression, 0, "include_str");
  const suffix = include?.arguments
    ? expression.slice(include.end).map((token) => token.value)
    : [];
  if (
    !include?.arguments ||
    JSON.stringify(suffix) !==
      JSON.stringify([".", "to_string", "(", ")"])
  ) {
    errors.push(
      `${inventoryFile} skill! content field must be include_str!(...).to_string()`,
    );
    return null;
  }
  const dynamic = dynamicSkillInclude(include.arguments, variableName);
  if (dynamic === null) {
    errors.push(
      `${inventoryFile} skill! content include_str! must derive its path from the literal skill id`,
    );
    return null;
  }
  return {
    dynamic,
    includeIndex: expression[0].index,
  };
}

function inventoryFromRust(
  root,
  inventoryFile,
  functionName,
  runtimePrefix,
  errors,
) {
  const absolute = resolveInside(
    root,
    inventoryFile,
    errors,
    "bundled skill inventory",
  );
  if (!absolute || !existsSync(absolute)) {
    if (absolute) {
      errors.push(`bundled skill inventory is missing at ${inventoryFile}`);
    }
    return {
      ids: new Set(),
      references: [],
      verifiedDynamicIncludes: new Set(),
    };
  }
  const content = readFileSync(absolute, "utf8");
  const tokens = rustTokens(content);
  const body = namedFunctionBody(tokens, functionName, inventoryFile, errors);
  if (body === null) {
    return {
      ids: new Set(),
      references: [],
      verifiedDynamicIncludes: new Set(),
    };
  }
  const vector = tailVectorInvocation(
    tokens,
    body,
    functionName,
    inventoryFile,
    errors,
  );
  if (vector?.arguments && hasCfgAttribute(vector.arguments)) {
    errors.push(
      `${inventoryFile} ${functionName} returned inventory must not use conditional compilation; bundled inventory must be release-invariant`,
    );
  }
  const ids = [];
  if (vector?.arguments) {
    const entries = splitTopLevel(vector.arguments, ",");
    if (entries === null) {
      errors.push(`${inventoryFile} ${functionName} has malformed vec! entries`);
    } else {
      for (const entry of entries.filter((candidate) => candidate.length > 0)) {
        const invocation = macroInvocation(entry, 0, "skill");
        if (!invocation?.arguments || invocation.end !== entry.length) {
          errors.push(
            `${inventoryFile} ${functionName} inventory entries must be direct skill!("id") expressions`,
          );
          continue;
        }
        const skillId = singleStringArgument(invocation.arguments);
        if (skillId === null) {
          errors.push(
            `${inventoryFile} ${functionName} skill! entries must contain one string literal`,
          );
        } else {
          ids.push(skillId);
        }
      }
    }
  }
  const unique = new Set(ids);
  if (ids.length === 0) {
    errors.push(`${inventoryFile} does not contain any skill!(...) inventory entries`);
  }
  if (unique.size !== ids.length) {
    errors.push(`${inventoryFile} contains duplicate bundled skill inventory entries`);
  }
  const definition = macroRulesDefinition(
    tokens,
    body.start,
    vector?.tokenIndex ?? body.end,
    "skill",
    inventoryFile,
    errors,
  );
  const verifiedInclude = definition
    ? bundledSkillInclude(
        definition,
        tokens,
        runtimePrefix,
        inventoryFile,
        errors,
      )
    : null;
  const references = [];
  const verifiedDynamicIncludes = new Set();
  if (verifiedInclude) {
    verifiedDynamicIncludes.add(`${absolute}\0${verifiedInclude.includeIndex}`);
    for (const skillId of unique) {
      const target = resolve(
        dirname(absolute),
        `${verifiedInclude.dynamic[0]}${skillId}${verifiedInclude.dynamic[1]}`,
      );
      references.push({ source: absolute, target });
      if (!existsSync(target)) {
        errors.push(
          `${inventoryFile} skill! content target for ${skillId} is missing: ${relativePath(
            root,
            target,
          )}`,
        );
      }
    }
  }
  return { ids: unique, references, verifiedDynamicIncludes };
}

function checkRustIncludes(
  root,
  sourceRoots,
  verifiedDynamicIncludes,
  errors,
) {
  const references = [];
  for (const sourceRoot of sourceRoots ?? []) {
    const absoluteRoot = resolveInside(
      root,
      sourceRoot,
      errors,
      "Rust source root",
    );
    if (!absoluteRoot || !existsSync(absoluteRoot)) {
      if (absoluteRoot) errors.push(`Rust source root is missing at ${sourceRoot}`);
      continue;
    }
    for (const file of walkFiles(absoluteRoot).filter(
      (candidate) => extname(candidate) === ".rs",
    )) {
      const content = readFileSync(file, "utf8");
      const tokens = rustTokens(content);
      for (let index = 0; index < tokens.length; index += 1) {
        const include = macroInvocation(tokens, index, "include_str");
        if (!include) continue;
        if (!include.arguments) {
          errors.push(
            `${relativePath(root, file)} has an unterminated include_str! expression`,
          );
          break;
        }

        const literal = singleStringArgument(include.arguments);
        if (literal !== null) {
          const target = resolve(dirname(file), literal);
          references.push({ source: file, target });
          if (!existsSync(target)) {
            errors.push(
              `${relativePath(root, file)} include_str! target is missing: ${relativePath(
                root,
                target,
              )}`,
            );
          }
          index = include.end - 1;
          continue;
        }

        const includeKey = `${file}\0${tokens[index].index}`;
        if (!verifiedDynamicIncludes.has(includeKey)) {
          errors.push(
            `${relativePath(root, file)} has an unsupported include_str! expression; extend the harness checker before adding it`,
          );
        }
        index = include.end - 1;
      }
    }
  }
  return references;
}

function defaultPromptReturnReference(
  root,
  sourceRoots,
  expectedPrompt,
  errors,
) {
  const definitions = [];
  for (const sourceRoot of sourceRoots ?? []) {
    const absoluteRoot = resolveInside(
      root,
      sourceRoot,
      errors,
      "default prompt Rust source root",
    );
    if (!absoluteRoot || !existsSync(absoluteRoot)) continue;
    for (const file of walkFiles(absoluteRoot).filter(
      (candidate) => extname(candidate) === ".rs",
    )) {
      const tokens = rustTokens(readFileSync(file, "utf8"));
      for (const body of namedFunctionBodies(
        tokens,
        DEFAULT_PROMPT_RETURN_FUNCTION,
      )) {
        definitions.push({ body, file, tokens });
      }
    }
  }

  if (definitions.length !== 1) {
    errors.push(
      `Rust source roots must define exactly one ${DEFAULT_PROMPT_RETURN_FUNCTION} function; found ${definitions.length}`,
    );
    return null;
  }

  const { body, file, tokens } = definitions[0];
  let expression = tokens.slice(body.start, body.end);
  if (expression[0]?.value === "return") expression = expression.slice(1);
  if (expression.at(-1)?.value === ";") expression = expression.slice(0, -1);
  const include = macroInvocation(expression, 0, "include_str");
  const suffix = include?.arguments
    ? expression.slice(include.end).map((token) => token.value)
    : [];
  const literal = include?.arguments
    ? singleStringArgument(include.arguments)
    : null;
  if (
    literal === null ||
    JSON.stringify(suffix) !==
      JSON.stringify([".", "to_string", "(", ")"])
  ) {
    errors.push(
      `${relativePath(root, file)} ${DEFAULT_PROMPT_RETURN_FUNCTION} must directly return include_str!("...").to_string()`,
    );
    return null;
  }

  const target = resolve(dirname(file), literal);
  if (target !== expectedPrompt) {
    errors.push(
      `${relativePath(root, file)} ${DEFAULT_PROMPT_RETURN_FUNCTION} returns ${relativePath(
        root,
        target,
      )}; expected ${relativePath(root, expectedPrompt)}`,
    );
  }
  return { source: file, target };
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function stripMarkdownHtmlComments(content) {
  let visible = "";
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf("<!--", cursor);
    if (start === -1) return visible + content.slice(cursor);
    visible += content.slice(cursor, start);
    const end = content.indexOf("-->", start + 4);
    if (end === -1) return visible;
    cursor = end + 3;
  }
  return visible;
}

function checkPnpmReferences(root, files, packageJson, builtins, errors) {
  const builtinSet = new Set(builtins ?? []);
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(
      /\bpnpm[ \t]+(?:(run)[ \t]+)?([A-Za-z0-9][A-Za-z0-9:_-]*)/g,
    )) {
      const usesRun = match[1] === "run";
      const script = match[2];
      if (!usesRun && builtinSet.has(script)) continue;
      if (!packageJson.scripts?.[script]) {
        const command = usesRun ? `pnpm run ${script}` : `pnpm ${script}`;
        errors.push(
          `${relativePath(root, file)}:${lineNumber(
            content,
            match.index,
          )} references missing package script ${command}`,
        );
      }
    }
  }
}

function filesForConfiguredPath(root, path, errors) {
  const absolute = resolveInside(root, path, errors, "forbidden-text path");
  if (!absolute || !existsSync(absolute)) {
    if (absolute) errors.push(`forbidden-text path is missing at ${path}`);
    return [];
  }
  return walkFiles(absolute);
}

export function validateAgentAssets(
  root = DEFAULT_ROOT,
  contractRelativePath = "validation/agent-assets.json",
) {
  const errors = [];
  const contract = (() => {
    const absolute = resolveInside(
      root,
      contractRelativePath,
      errors,
      "agent asset contract",
    );
    if (!absolute || !existsSync(absolute)) {
      if (absolute) {
        errors.push(`agent asset contract is missing at ${contractRelativePath}`);
      }
      return null;
    }
    try {
      return JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      errors.push(
        `agent asset contract at ${contractRelativePath} is not valid JSON: ${error.message}`,
      );
      return null;
    }
  })();
  const packageJson = readJson(root, "package.json", errors, "package.json");
  if (!contract || !packageJson) return errors;
  if (contract.version !== 1) {
    errors.push(
      `agent asset contract version must be 1, received ${JSON.stringify(
        contract.version,
      )}`,
    );
  }

  const skillConfig = contract.skills ?? {};
  const prefix = skillConfig.projectionPrefix ?? "";
  if (skillConfig.inventoryFunction !== "bundled_skills") {
    errors.push(
      `skill inventoryFunction must be bundled_skills, received ${JSON.stringify(
        skillConfig.inventoryFunction,
      )}`,
    );
  }
  const owners = discoverSkills(
    root,
    skillConfig.ownerRoot,
    (id) => `${prefix}${id}`,
    errors,
    "skill owner root",
    true,
  );
  if (
    skillConfig.portableOwnerForbiddenPattern !==
    FORBIDDEN_PORTABLE_OWNER_PATTERN
  ) {
    errors.push(
      `portableOwnerForbiddenPattern must be ${JSON.stringify(
        FORBIDDEN_PORTABLE_OWNER_PATTERN,
      )}, received ${JSON.stringify(
        skillConfig.portableOwnerForbiddenPattern,
      )}`,
    );
  }
  const portableOwnerPattern = new RegExp(FORBIDDEN_PORTABLE_OWNER_PATTERN);
  for (const owner of owners.values()) {
    const match = portableOwnerPattern.exec(owner.content);
    if (match) {
      errors.push(
        `${owner.manifestPath}:${lineNumber(
          owner.content,
          match.index,
        )} portable bundled skill owners must not reference pnpm: ${match[0]}`,
      );
    }
  }
  const bundled = inventoryFromRust(
    root,
    skillConfig.inventoryFile,
    "bundled_skills",
    prefix,
    errors,
  );
  const inventory = bundled.ids;
  const projectionsByDirectory = discoverSkills(
    root,
    skillConfig.projectionRoot,
    (id) => id,
    errors,
    "skill projection root",
  );
  const projections = new Map(
    [...projectionsByDirectory]
      .filter(([directory]) => directory.startsWith(prefix))
      .map(([directory, value]) => [directory.slice(prefix.length), value]),
  );

  compareSets(
    "Rust bundled skill inventory",
    new Set(owners.keys()),
    inventory,
    errors,
  );
  compareSets(
    "repository skill projection",
    new Set(owners.keys()),
    new Set(projections.keys()),
    errors,
  );

  const allowedAdaptations = skillConfig.allowedAdaptations;
  if (
    !allowedAdaptations ||
    typeof allowedAdaptations !== "object" ||
    Array.isArray(allowedAdaptations)
  ) {
    errors.push("allowed adaptations must be an object");
  } else {
    for (const skillId of Object.keys(allowedAdaptations)) {
      if (!REQUIRED_ALLOWED_ADAPTATIONS.has(skillId)) {
        errors.push(
          `allowed adaptation skill ids has undeclared extra ${skillId}`,
        );
      }
    }
    for (const [skillId, expected] of REQUIRED_ALLOWED_ADAPTATIONS) {
      if (
        Object.hasOwn(allowedAdaptations, skillId) &&
        JSON.stringify(allowedAdaptations[skillId]) !==
        JSON.stringify(expected)
      ) {
        errors.push(
          `allowed adaptations for ${skillId} must be the exact validation-gate substitution`,
        );
      }
    }
  }

  for (const [skillId, adaptationList] of Object.entries(
    allowedAdaptations ?? {},
  )) {
    if (!owners.has(skillId)) {
      errors.push(
        `allowed adaptations declare unknown owner skill ${skillId}`,
      );
    }
    if (!Array.isArray(adaptationList)) {
      errors.push(`allowed adaptations for ${skillId} must be an array`);
    }
  }

  for (const [skillId, owner] of owners) {
    const projection = projections.get(skillId);
    if (!projection) continue;
    const expected = applyAdaptations(
      owner.content,
      skillId,
      skillConfig.allowedAdaptations,
      errors,
    );
    if (expected !== projection.content) {
      const difference = firstDifference(expected, projection.content);
      errors.push(
        `${projection.manifestPath} differs from owner ${owner.manifestPath} after declared adaptations at line ${
          difference?.line ?? "unknown"
        } (expected ${JSON.stringify(
          difference?.expected,
        )}, received ${JSON.stringify(
          difference?.actual,
        )}); declare every intentional projection change in ${contractRelativePath}`,
      );
    }
  }

  const discovery = skillConfig.discoveryProjection;
  if (discovery) {
    const path = resolveInside(
      root,
      discovery.path,
      errors,
      "skill discovery projection",
    );
    if (path && !existsSync(path)) {
      errors.push(`skill discovery projection is missing at ${discovery.path}`);
    } else if (path) {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (target !== discovery.target) {
          errors.push(
            `skill discovery projection ${discovery.path} points to ${target}; expected ${discovery.target}`,
          );
        }
      } else if (metadata.isFile()) {
        const target = readFileSync(path, "utf8");
        if (target !== discovery.target) {
          errors.push(
            `skill discovery projection ${discovery.path} contains ${JSON.stringify(
              target,
            )}; expected Git flattened symlink target ${JSON.stringify(
              discovery.target,
            )}`,
          );
        }
      } else {
        errors.push(
          `skill discovery projection ${discovery.path} must be a symlink or Git flattened symlink file targeting ${discovery.target}`,
        );
      }
    }
  }

  const standaloneFiles = [];
  for (const standaloneRoot of skillConfig.standaloneRoots ?? []) {
    const standalone = discoverSkills(
      root,
      standaloneRoot,
      (id) => id,
      errors,
      "standalone skill root",
    );
    standaloneFiles.push(
      ...[...standalone.values()].map((value) =>
        resolve(root, value.manifestPath),
      ),
    );
  }

  const includeReferences = [
    ...bundled.references,
    ...checkRustIncludes(
      root,
      contract.rustSourceRoots,
      bundled.verifiedDynamicIncludes,
      errors,
    ),
  ];
  for (const owner of owners.values()) {
    const ownerFile = resolve(root, owner.manifestPath);
    const ownerIncludes = includeReferences.filter(
      (reference) => reference.target === ownerFile,
    );
    if (ownerIncludes.length !== 1) {
      const includeOwners = ownerIncludes
        .map((reference) => relativePath(root, reference.source))
        .sort();
      errors.push(
        `bundled skill owner ${owner.manifestPath} must have exactly one Rust include_str! owner; found ${ownerIncludes.length}${
          includeOwners.length > 0 ? ` (${includeOwners.join(", ")})` : ""
        }`,
      );
    }
  }

  const promptConfig = contract.defaultPrompt;
  let promptFile = null;
  if (promptConfig) {
    if (promptConfig.returnFunction !== DEFAULT_PROMPT_RETURN_FUNCTION) {
      errors.push(
        `defaultPrompt returnFunction must be ${DEFAULT_PROMPT_RETURN_FUNCTION}, received ${JSON.stringify(
          promptConfig.returnFunction,
        )}`,
      );
    }
    if (
      promptConfig.forbiddenNamespacePattern !==
      FORBIDDEN_MCP_NAMESPACE_PATTERN
    ) {
      errors.push(
        `defaultPrompt forbiddenNamespacePattern must be ${JSON.stringify(
          FORBIDDEN_MCP_NAMESPACE_PATTERN,
        )}, received ${JSON.stringify(
          promptConfig.forbiddenNamespacePattern,
        )}`,
      );
    }
    promptFile = resolveInside(
      root,
      promptConfig.path,
      errors,
      "default prompt",
    );
    if (promptFile && !existsSync(promptFile)) {
      errors.push(`default prompt is missing at ${promptConfig.path}`);
    }
    if (promptFile) {
      defaultPromptReturnReference(
        root,
        contract.rustSourceRoots,
        promptFile,
        errors,
      );
      const promptIncludes = includeReferences.filter(
        (reference) => reference.target === promptFile,
      );
      if (promptIncludes.length !== 1) {
        const owners = promptIncludes
          .map((reference) => relativePath(root, reference.source))
          .sort();
        errors.push(
          `default prompt ${promptConfig.path} must have exactly one Rust include_str! owner; found ${promptIncludes.length}${
            owners.length > 0 ? ` (${owners.join(", ")})` : ""
          }`,
        );
      }
    }
    if (promptFile && existsSync(promptFile)) {
      const prompt = readFileSync(promptFile, "utf8");
      const visiblePrompt = stripMarkdownHtmlComments(prompt);
      const promptSkills = new Set(
        [...visiblePrompt.matchAll(/\|\s*`(symphony-[^`]+)`\s*\|/g)].map(
          (match) => match[1],
        ),
      );
      const expectedPromptSkills = new Set(
        [...owners.keys()].map((skillId) => `${prefix}${skillId}`),
      );
      compareSets(
        "default prompt skill table",
        expectedPromptSkills,
        promptSkills,
        errors,
      );
      const namespacePattern = new RegExp(FORBIDDEN_MCP_NAMESPACE_PATTERN);
      const match = namespacePattern.exec(prompt);
      if (match) {
        errors.push(
          `${promptConfig.path}:${lineNumber(
            prompt,
            match.index,
          )} hard-codes MCP namespace ${match[0]}; describe the capability without assuming a server name`,
        );
      }
    }
  } else {
    errors.push("agent asset contract is missing defaultPrompt configuration");
  }

  const markdownFiles = new Set([
    ...[...owners.values()].map((value) => resolve(root, value.manifestPath)),
    ...[...projections.values()].map((value) =>
      resolve(root, value.manifestPath),
    ),
    ...standaloneFiles,
  ]);
  if (promptFile && existsSync(promptFile)) markdownFiles.add(promptFile);
  checkPnpmReferences(
    root,
    markdownFiles,
    packageJson,
    contract.pnpmBuiltins,
    errors,
  );

  for (const forbidden of contract.forbiddenText ?? []) {
    let pattern;
    try {
      pattern = new RegExp(forbidden.pattern, "g");
    } catch (error) {
      errors.push(
        `forbidden text pattern ${JSON.stringify(
          forbidden.pattern,
        )} is invalid: ${error.message}`,
      );
      continue;
    }
    for (const path of forbidden.paths ?? []) {
      for (const file of filesForConfiguredPath(root, path, errors)) {
        const content = readFileSync(file, "utf8");
        const match = pattern.exec(content);
        pattern.lastIndex = 0;
        if (match) {
          errors.push(
            `${relativePath(root, file)}:${lineNumber(
              content,
              match.index,
            )} ${forbidden.message}: ${match[0]}`,
          );
        }
      }
    }
  }

  return errors;
}

function runCli() {
  const errors = validateAgentAssets();
  if (errors.length > 0) {
    console.error("Agent asset check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("Agent asset contract passed.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
