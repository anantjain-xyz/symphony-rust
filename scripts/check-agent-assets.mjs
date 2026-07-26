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
    values[key] = value.replace(/^"(.*)"$/, "$1").trim();
  }
  for (const required of ["name", "description"]) {
    if (!values[required]) {
      errors.push(`${path} frontmatter is missing required ${required}`);
    }
  }
  return values;
}

function discoverSkills(root, rootPath, expectedName, errors, label) {
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

function macroInvocation(tokens, index, name) {
  if (
    tokens[index]?.type !== "ident" ||
    tokens[index].value !== name ||
    tokens[index + 1]?.value !== "!" ||
    tokens[index + 2]?.value !== "("
  ) {
    return null;
  }
  let depth = 0;
  for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].value === "(") depth += 1;
    if (tokens[cursor].value === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          arguments: tokens.slice(index + 3, cursor),
          end: cursor + 1,
        };
      }
    }
  }
  return { arguments: null, end: tokens.length };
}

function singleStringArgument(tokens) {
  const withoutTrailingComma =
    tokens.at(-1)?.value === "," ? tokens.slice(0, -1) : tokens;
  return withoutTrailingComma.length === 1 &&
    withoutTrailingComma[0].type === "string"
    ? withoutTrailingComma[0].value
    : null;
}

function inventoryFromRust(root, inventoryFile, errors) {
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
    return new Set();
  }
  const content = readFileSync(absolute, "utf8");
  const tokens = rustTokens(content);
  const ids = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const invocation = macroInvocation(tokens, index, "skill");
    if (!invocation?.arguments) continue;
    const skillId = singleStringArgument(invocation.arguments);
    if (skillId !== null) ids.push(skillId);
    index = invocation.end - 1;
  }
  const unique = new Set(ids);
  if (ids.length === 0) {
    errors.push(`${inventoryFile} does not contain any skill!(...) inventory entries`);
  }
  if (unique.size !== ids.length) {
    errors.push(`${inventoryFile} contains duplicate bundled skill inventory entries`);
  }
  return unique;
}

function checkRustIncludes(root, sourceRoots, inventory, errors) {
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

        const concat = macroInvocation(include.arguments, 0, "concat");
        const args = concat?.arguments;
        const dynamic =
          args &&
          args.length === 7 &&
          args[0].type === "string" &&
          args[1].value === "," &&
          args[2].value === "$" &&
          args[3].value === "name" &&
          args[4].value === "," &&
          args[5].type === "string" &&
          args[6].value === ","
            ? [args[0].value, args[5].value]
            : args &&
                args.length === 6 &&
                args[0].type === "string" &&
                args[1].value === "," &&
                args[2].value === "$" &&
                args[3].value === "name" &&
                args[4].value === "," &&
                args[5].type === "string"
              ? [args[0].value, args[5].value]
              : null;
        if (dynamic && concat.end === include.arguments.length) {
          for (const skillId of inventory) {
            const target = resolve(dirname(file), `${dynamic[0]}${skillId}${dynamic[1]}`);
            references.push({ source: file, target });
            if (!existsSync(target)) {
              errors.push(
                `${relativePath(
                  root,
                  file,
                )} dynamic include_str! target for ${skillId} is missing: ${relativePath(
                  root,
                  target,
                )}`,
              );
            }
          }
        } else {
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

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function checkPnpmReferences(root, files, packageJson, builtins, errors) {
  const builtinSet = new Set(builtins ?? []);
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/\bpnpm\s+([A-Za-z0-9][A-Za-z0-9:_-]*)/g)) {
      const script = match[1];
      if (builtinSet.has(script)) continue;
      if (!packageJson.scripts?.[script]) {
        errors.push(
          `${relativePath(root, file)}:${lineNumber(
            content,
            match.index,
          )} references missing package script pnpm ${script}`,
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
  const owners = discoverSkills(
    root,
    skillConfig.ownerRoot,
    (id) => `${prefix}${id}`,
    errors,
    "skill owner root",
  );
  const inventory = inventoryFromRust(
    root,
    skillConfig.inventoryFile,
    errors,
  );
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

  for (const [skillId, adaptationList] of Object.entries(
    skillConfig.allowedAdaptations ?? {},
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
      if (!metadata.isSymbolicLink()) {
        errors.push(
          `skill discovery projection ${discovery.path} must be a symlink to ${discovery.target}`,
        );
      } else {
        const target = readlinkSync(path);
        if (target !== discovery.target) {
          errors.push(
            `skill discovery projection ${discovery.path} points to ${target}; expected ${discovery.target}`,
          );
        }
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

  const includeReferences = checkRustIncludes(
    root,
    contract.rustSourceRoots,
    inventory,
    errors,
  );

  const promptConfig = contract.defaultPrompt;
  let promptFile = null;
  if (promptConfig) {
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
      const promptSkills = new Set(
        [...prompt.matchAll(/\|\s*`(symphony-[^`]+)`\s*\|/g)].map(
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
      if (promptConfig.forbiddenNamespacePattern) {
        const namespacePattern = new RegExp(
          promptConfig.forbiddenNamespacePattern,
        );
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
