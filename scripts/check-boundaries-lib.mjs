import fs from "node:fs/promises";
import path from "node:path";

function diagnostic(file, line, message) {
  return `${file}:${line}: ${message}`;
}

function workspacePackages(metadata) {
  if (!metadata || !Array.isArray(metadata.packages) || !Array.isArray(metadata.workspace_members)) {
    throw new Error("cargo metadata is missing packages or workspace_members");
  }
  const memberIds = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter((pkg) => memberIds.has(pkg.id));
  if (packages.length !== memberIds.size) {
    throw new Error("cargo metadata did not describe every workspace member");
  }
  return packages;
}

function validatePolicy(policy) {
  if (policy?.version !== 1 || !policy.packages || typeof policy.packages !== "object") {
    throw new Error("boundary policy must have version 1 and a packages object");
  }
  if (!policy.restrictedDependencies || typeof policy.restrictedDependencies !== "object") {
    throw new Error("boundary policy must declare restrictedDependencies");
  }
  if (!Array.isArray(policy.sourceRules)) {
    throw new Error("boundary policy must declare sourceRules");
  }

  const packageNames = new Set(Object.keys(policy.packages));
  for (const [name, config] of Object.entries(policy.packages)) {
    if (!Array.isArray(config.allowedInternalDependencies)) {
      throw new Error(`${name} must declare allowedInternalDependencies`);
    }
    for (const dependency of config.allowedInternalDependencies) {
      if (!packageNames.has(dependency)) {
        throw new Error(`${name} allows unknown internal dependency ${dependency}`);
      }
    }
  }

  for (const [dependency, owners] of Object.entries(policy.restrictedDependencies)) {
    if (!Array.isArray(owners) || owners.length === 0) {
      throw new Error(`restricted dependency ${dependency} must have at least one owner`);
    }
    for (const owner of owners) {
      if (!packageNames.has(owner)) {
        throw new Error(`restricted dependency ${dependency} names unknown owner ${owner}`);
      }
    }
  }

  for (const rule of policy.sourceRules) {
    if (
      !rule ||
      typeof rule.id !== "string" ||
      typeof rule.pattern !== "string" ||
      typeof rule.message !== "string" ||
      !Array.isArray(rule.allowedPackages)
    ) {
      throw new Error("each source rule must declare id, pattern, message, and allowedPackages");
    }
    for (const owner of rule.allowedPackages) {
      if (!packageNames.has(owner)) {
        throw new Error(`source rule ${rule.id} names unknown owner ${owner}`);
      }
    }
    try {
      new RegExp(rule.pattern);
    } catch (error) {
      throw new Error(`source rule ${rule.id} has invalid pattern: ${error.message}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(name, trail) {
    if (visiting.has(name)) {
      throw new Error(`allowed internal dependency graph contains a cycle: ${[...trail, name].join(" -> ")}`);
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of policy.packages[name].allowedInternalDependencies) {
      visit(dependency, [...trail, name]);
    }
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of packageNames) visit(name, []);
}

export function verifyCargoMetadata(metadata, policy) {
  validatePolicy(policy);
  const packages = workspacePackages(metadata);
  const actualByName = new Map();
  const errors = [];

  for (const pkg of packages) {
    if (actualByName.has(pkg.name)) {
      throw new Error(`workspace contains duplicate package name ${pkg.name}`);
    }
    actualByName.set(pkg.name, pkg);
  }

  const policyNames = new Set(Object.keys(policy.packages));
  for (const name of actualByName.keys()) {
    if (!policyNames.has(name)) {
      errors.push(`Cargo.toml:1: workspace package ${name} is missing from architecture/boundaries.json`);
    }
  }
  for (const name of policyNames) {
    if (!actualByName.has(name)) {
      errors.push(`architecture/boundaries.json:1: policy names missing workspace package ${name}`);
    }
  }

  const internalNames = new Set(actualByName.keys());
  for (const [name, pkg] of actualByName) {
    const allowed = new Set(policy.packages[name]?.allowedInternalDependencies ?? []);
    for (const dependency of pkg.dependencies ?? []) {
      if (internalNames.has(dependency.name) && !allowed.has(dependency.name)) {
        const manifest = path.relative(metadata.workspace_root, pkg.manifest_path);
        errors.push(
          diagnostic(
            manifest,
            1,
            `${name} may not depend on internal crate ${dependency.name}`,
          ),
        );
      }
    }
  }

  for (const [dependencyName, owners] of Object.entries(policy.restrictedDependencies)) {
    const allowedOwners = new Set(owners);
    for (const [packageName, pkg] of actualByName) {
      if (
        !allowedOwners.has(packageName) &&
        (pkg.dependencies ?? []).some((dependency) => dependency.name === dependencyName)
      ) {
        const manifest = path.relative(metadata.workspace_root, pkg.manifest_path);
        errors.push(
          diagnostic(
            manifest,
            1,
            `${packageName} may not declare restricted dependency ${dependencyName}; allowed owner: ${owners.join(", ")}`,
          ),
        );
      }
    }
  }

  return errors.sort();
}

async function collectRustFiles(root) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error(`cannot scan ${current}: ${error.message}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`boundary scan refuses symbolic link ${fullPath}`);
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

async function addRustFile(files, file, { optional = false } = {}) {
  const absolute = path.resolve(file);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (optional && error.code === "ENOENT") return;
    throw new Error(`cannot inspect Rust source ${absolute}: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`boundary scan refuses symbolic link ${absolute}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Cargo target source is not a file: ${absolute}`);
  }
  files.add(absolute);
}

async function existingModuleFile(candidates) {
  const matches = [];
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error(`cannot inspect Rust module ${absolute}: ${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`boundary scan refuses symbolic link ${absolute}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Rust module source is not a file: ${absolute}`);
    }
    matches.push(absolute);
  }
  if (matches.length > 1) {
    throw new Error(`Rust module resolves to multiple files: ${matches.join(", ")}`);
  }
  return matches[0] ?? null;
}

function literalPath(token) {
  if (typeof token?.literal !== "string" || token.literal.length === 0) {
    throw new Error("#[path] must contain a non-empty plain string literal");
  }
  if (
    token.literal.includes("\\") ||
    token.literal.includes("\n") ||
    token.literal.includes("\r") ||
    path.isAbsolute(token.literal)
  ) {
    throw new Error(`boundary scan cannot safely resolve #[path = ${JSON.stringify(token.literal)}]`);
  }
  return token.literal;
}

function modulePathAttribute(tokens, modIndex) {
  let boundary = modIndex - 1;
  while (
    boundary >= 0 &&
    ![";", "{", "}"].includes(tokens[boundary].value)
  ) {
    boundary -= 1;
  }
  let result = null;
  for (let index = boundary + 1; index + 4 < modIndex; index += 1) {
    if (
      tokens[index].value === "#" &&
      tokens[index + 1]?.value === "[" &&
      tokens[index + 2]?.value === "path" &&
      tokens[index + 3]?.value === "=" &&
      tokens[index + 4]?.value === "LITERAL" &&
      tokens[index + 5]?.value === "]"
    ) {
      if (result !== null) {
        throw new Error("Rust module declares more than one #[path] attribute");
      }
      result = literalPath(tokens[index + 4]);
    }
  }
  return result;
}

function matchingBrace(tokens, opening) {
  let depth = 0;
  for (let index = opening; index < tokens.length; index += 1) {
    if (tokens[index].value === "{") depth += 1;
    if (tokens[index].value === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`unclosed Rust block starting on line ${tokens[opening].line}`);
}

async function collectTargetModules(files, entryFile) {
  const visited = new Set();

  async function visit(file, moduleDirectory) {
    const absolute = path.resolve(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    await addRustFile(files, absolute);

    let source;
    try {
      source = await fs.readFile(absolute, "utf8");
    } catch (error) {
      throw new Error(`cannot read Rust module ${absolute}: ${error.message}`);
    }
    const tokens = lexRust(source);

    async function scan(start, end, directory) {
      for (let index = start; index < end; index += 1) {
        if (
          tokens[index].value !== "mod" ||
          !tokens[index + 1]?.identifier
        ) {
          continue;
        }
        const name = tokens[index + 1].value;
        const terminator = tokens[index + 2]?.value;
        if (terminator === "{") {
          const closing = matchingBrace(tokens, index + 2);
          await scan(index + 3, closing, path.join(directory, name));
          index = closing;
          continue;
        }
        if (terminator !== ";") continue;

        const explicitPath = modulePathAttribute(tokens, index);
        const moduleFile = explicitPath === null
          ? await existingModuleFile([
              path.join(directory, `${name}.rs`),
              path.join(directory, name, "mod.rs"),
            ])
          : await existingModuleFile([path.join(directory, explicitPath)]);
        if (moduleFile === null) {
          throw new Error(
            `cannot resolve Rust module ${name} declared at ${absolute}:${tokens[index].line}`,
          );
        }
        const childDirectory = path.basename(moduleFile) === "mod.rs"
          ? path.dirname(moduleFile)
          : path.join(
              path.dirname(moduleFile),
              path.basename(moduleFile, path.extname(moduleFile)),
            );
        await visit(moduleFile, childDirectory);
      }
    }

    await scan(0, tokens.length, moduleDirectory);
  }

  const absoluteEntry = path.resolve(entryFile);
  await visit(absoluteEntry, path.dirname(absoluteEntry));
}

async function packageRustFiles(pkg) {
  const manifestDir = path.dirname(pkg.manifest_path);
  const roots = ["src", "tests", "examples", "benches"].map((name) =>
    path.join(manifestDir, name),
  );
  const files = new Set();
  for (const root of roots) {
    for (const file of await collectRustFiles(root)) files.add(path.resolve(file));
  }
  await addRustFile(files, path.join(manifestDir, "build.rs"), { optional: true });

  const targets = [...(pkg.targets ?? [])].sort((a, b) =>
    String(a.src_path).localeCompare(String(b.src_path)),
  );
  for (const target of targets) {
    if (!target || typeof target.src_path !== "string" || target.src_path.length === 0) {
      throw new Error(`cargo metadata target for ${pkg.name} is missing src_path`);
    }
    await collectTargetModules(files, path.resolve(manifestDir, target.src_path));
  }

  return [...files].sort();
}

function isIdentifierStart(character) {
  return character === "_" || /[A-Za-z]/.test(character);
}

function isIdentifierContinue(character) {
  return character === "_" || /[A-Za-z0-9]/.test(character);
}

function rawStringOpening(source, index) {
  const prefixes = ["br", "cr", "rb", "rc", "r"];
  const prefix = prefixes.find((candidate) => source.startsWith(candidate, index));
  if (!prefix) return null;

  let cursor = index + prefix.length;
  let hashes = 0;
  while (source[cursor] === "#") {
    hashes += 1;
    cursor += 1;
  }
  if (source[cursor] !== '"') return null;

  return {
    contentStart: cursor + 1,
    closing: `"${"#".repeat(hashes)}`,
  };
}

function characterLiteralEnd(source, quoteIndex) {
  let cursor = quoteIndex + 1;
  if (cursor >= source.length || source[cursor] === "\n" || source[cursor] === "\r") {
    return null;
  }

  if (source[cursor] === "\\") {
    cursor += 1;
    if (source[cursor] === "u" && source[cursor + 1] === "{") {
      cursor = source.indexOf("}", cursor + 2);
      if (cursor === -1) return null;
      cursor += 1;
    } else if (source[cursor] === "x") {
      cursor += 3;
    } else {
      const codePoint = source.codePointAt(cursor);
      if (codePoint === undefined) return null;
      cursor += codePoint > 0xffff ? 2 : 1;
    }
  } else {
    const codePoint = source.codePointAt(cursor);
    if (codePoint === undefined || source[cursor] === "'") return null;
    cursor += codePoint > 0xffff ? 2 : 1;
  }

  return source[cursor] === "'" ? cursor + 1 : null;
}

function lexRust(source) {
  const tokens = [];
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const character = source[index];

    if (/\s/.test(character)) {
      if (character === "\n") line += 1;
      index += 1;
      continue;
    }

    if (source.startsWith("//", index)) {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (source.startsWith("/*", index)) {
      const openingLine = line;
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          if (source[index] === "\n") line += 1;
          index += 1;
        }
      }
      if (depth > 0) {
        throw new Error(`unterminated block comment starting on line ${openingLine}`);
      }
      continue;
    }

    const rawString = rawStringOpening(source, index);
    if (rawString) {
      const openingLine = line;
      const literalStart = rawString.contentStart;
      index = rawString.contentStart;
      while (index < source.length && !source.startsWith(rawString.closing, index)) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      if (index >= source.length) {
        throw new Error(`unterminated raw string starting on line ${openingLine}`);
      }
      const literal = source.slice(literalStart, index);
      index += rawString.closing.length;
      tokens.push({ value: "LITERAL", line: openingLine, literal });
      continue;
    }

    let quoteIndex = null;
    if (character === '"') {
      quoteIndex = index;
    } else if (
      (character === "b" || character === "c") &&
      source[index + 1] === '"'
    ) {
      quoteIndex = index + 1;
    }
    if (quoteIndex !== null) {
      const openingLine = line;
      const literalStart = quoteIndex + 1;
      index = quoteIndex + 1;
      let closed = false;
      let literalEnd = null;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 1;
          if (source[index] === "\n") line += 1;
          if (index < source.length) index += 1;
        } else if (source[index] === '"') {
          literalEnd = index;
          index += 1;
          closed = true;
          break;
        } else {
          if (source[index] === "\n") line += 1;
          index += 1;
        }
      }
      if (!closed) {
        throw new Error(`unterminated string starting on line ${openingLine}`);
      }
      tokens.push({
        value: "LITERAL",
        line: openingLine,
        literal: source.slice(literalStart, literalEnd),
      });
      continue;
    }

    let characterEnd = null;
    const characterLine = line;
    if (character === "'") {
      characterEnd = characterLiteralEnd(source, index);
    } else if (character === "b" && source[index + 1] === "'") {
      characterEnd = characterLiteralEnd(source, index + 1);
    }
    if (characterEnd !== null) {
      index = characterEnd;
      tokens.push({ value: "LITERAL", line: characterLine });
      continue;
    }

    const rawIdentifier =
      source.startsWith("r#", index) && isIdentifierStart(source[index + 2]);
    if (rawIdentifier || isIdentifierStart(character)) {
      const start = rawIdentifier ? index + 2 : index;
      index = start;
      index += 1;
      while (index < source.length && isIdentifierContinue(source[index])) {
        index += 1;
      }
      tokens.push({
        value: source.slice(start, index),
        line,
        identifier: true,
        raw: rawIdentifier,
      });
      continue;
    }

    if (source.startsWith("::", index)) {
      tokens.push({ value: "::", line });
      index += 2;
      continue;
    }

    tokens.push({ value: character, line });
    index += 1;
  }

  return tokens;
}

function importStatements(tokens) {
  const statements = [];
  const groupBraces = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    let kind = null;
    let start = null;
    if (tokens[index].value === "use" && !tokens[index].raw) {
      kind = "use";
      start = index + 1;
    } else if (
      tokens[index].value === "extern" &&
      !tokens[index].raw &&
      tokens[index + 1]?.value === "crate" &&
      !tokens[index + 1]?.raw
    ) {
      kind = "extern";
      start = index + 2;
    }
    if (kind === null) continue;

    let end = start;
    while (end < tokens.length && tokens[end].value !== ";") {
      if (kind === "use" && ["{", "}"].includes(tokens[end].value)) {
        groupBraces.add(end);
      }
      end += 1;
    }
    if (end >= tokens.length) {
      throw new Error(`${kind} declaration on line ${tokens[index].line} has no semicolon`);
    }
    statements.push({ kind, tokenIndex: index, start, end });
    index = end;
  }

  return { statements, groupBraces };
}

function lexicalScopes(tokens, groupBraces) {
  const root = { parent: null, bindings: new Map(), line: 1 };
  const scopeAt = [];
  const stack = [root];

  for (let index = 0; index < tokens.length; index += 1) {
    scopeAt[index] = stack.at(-1);
    if (groupBraces.has(index)) continue;
    if (tokens[index].value === "{") {
      const child = {
        parent: stack.at(-1),
        bindings: new Map(),
        line: tokens[index].line,
      };
      stack.push(child);
    } else if (tokens[index].value === "}") {
      if (stack.length === 1) {
        throw new Error(`unmatched closing brace on line ${tokens[index].line}`);
      }
      stack.pop();
    }
  }
  if (stack.length !== 1) {
    throw new Error(`unclosed Rust scope starting on line ${stack.at(-1).line}`);
  }
  return { root, scopeAt };
}

function parseUseBindings(tokens, start, end) {
  const bindings = [];
  const pathPrefixes = new Map();

  function parseTree(index, prefix = [], inheritedAbsolute = false) {
    let absolute = inheritedAbsolute;
    if (tokens[index]?.value === "::") {
      absolute = true;
      index += 1;
    }

    if (tokens[index]?.value === "{") {
      index += 1;
      while (index < end && tokens[index].value !== "}") {
        index = parseTree(index, prefix, absolute);
        if (tokens[index]?.value === ",") index += 1;
      }
      if (tokens[index]?.value !== "}") {
        throw new Error("unclosed use group");
      }
      return index + 1;
    }

    if (tokens[index]?.value === "*") return index + 1;
    if (!tokens[index]?.identifier) {
      throw new Error(`unsupported use tree token ${tokens[index]?.value ?? "<end>"}`);
    }

    const segmentIndex = index;
    const segment = tokens[index].value;
    if (prefix.length > 0 || absolute) {
      pathPrefixes.set(segmentIndex, { prefix: [...prefix], absolute });
    }
    const importedPath =
      segment === "self" && prefix.length > 0 ? [...prefix] : [...prefix, segment];
    index += 1;

    if (tokens[index]?.value === "::") {
      return parseTree(index + 1, importedPath, absolute);
    }

    let name =
      segment === "self" && prefix.length > 0 ? prefix.at(-1) : segment;
    if (tokens[index]?.value === "as") {
      if (!tokens[index + 1]?.identifier) {
        throw new Error("use alias must be an identifier");
      }
      name = tokens[index + 1].value;
      index += 2;
    }
    if (name !== "_") {
      bindings.push({ name, path: importedPath, absolute });
    }
    return index;
  }

  let index = parseTree(start);
  if (tokens[index]?.value === ",") index += 1;
  if (index !== end) {
    throw new Error(`unsupported trailing tokens in use declaration`);
  }
  return { bindings, pathPrefixes };
}

function declareBinding(scope, name, binding) {
  if (scope.bindings.has(name)) {
    throw new Error(`ambiguous Rust declarations bind ${name} more than once in one scope`);
  }
  scope.bindings.set(name, { ...binding, scope });
}

function collectLocalItems(tokens, scopeAt) {
  const itemKeywords = new Set([
    "enum",
    "mod",
    "struct",
    "trait",
    "type",
    "union",
  ]);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (
      tokens[index].raw ||
      !itemKeywords.has(tokens[index].value) ||
      !tokens[index + 1].identifier
    ) {
      continue;
    }
    declareBinding(scopeAt[index], tokens[index + 1].value, {
      path: ["LOCAL_ITEM", tokens[index + 1].value],
      absolute: true,
    });
  }
}

function collectBindings(tokens, statements, scopeAt) {
  const importPathPrefixes = new Map();
  for (const statement of statements) {
    const scope = scopeAt[statement.tokenIndex];
    if (statement.kind === "extern") {
      if (!tokens[statement.start]?.identifier) {
        throw new Error("extern crate name must be an identifier");
      }
      const imported = tokens[statement.start].value;
      let name = imported;
      let cursor = statement.start + 1;
      if (tokens[cursor]?.value === "as") {
        if (!tokens[cursor + 1]?.identifier) {
          throw new Error("extern crate alias must be an identifier");
        }
        name = tokens[cursor + 1].value;
        cursor += 2;
      }
      if (cursor !== statement.end) {
        throw new Error("unsupported extern crate declaration");
      }
      if (name !== "_") {
        declareBinding(scope, name, {
          path: [imported],
          absolute: true,
        });
      }
      continue;
    }

    const parsed = parseUseBindings(
      tokens,
      statement.start,
      statement.end,
    );
    for (const binding of parsed.bindings) {
      declareBinding(scope, binding.name, binding);
    }
    for (const [tokenIndex, context] of parsed.pathPrefixes) {
      importPathPrefixes.set(tokenIndex, context);
    }
  }
  return importPathPrefixes;
}

function findBinding(scope, name) {
  for (let current = scope; current !== null; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return null;
}

function resolveBinding(binding, seen = new Set()) {
  if (seen.has(binding)) {
    throw new Error(`cyclic Rust import alias involving ${binding.path.join("::")}`);
  }
  if (binding.absolute || binding.path.length === 0) return [...binding.path];

  const importedRoot = findBinding(binding.scope, binding.path[0]);
  if (importedRoot === null || importedRoot === binding) return [...binding.path];
  seen.add(binding);
  const resolved = resolveBinding(importedRoot, seen);
  seen.delete(binding);
  return [...resolved, ...binding.path.slice(1)];
}

function normalizedTokenStream(tokens) {
  const { statements, groupBraces } = importStatements(tokens);
  const { scopeAt } = lexicalScopes(tokens, groupBraces);
  collectLocalItems(tokens, scopeAt);
  const importPathPrefixes = collectBindings(tokens, statements, scopeAt);
  const values = tokens.map((token) => token.value);

  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].identifier) continue;
    const previousIsSegment =
      tokens[index - 1]?.value === "::" && tokens[index - 2]?.identifier;
    if (previousIsSegment) continue;

    const segmentIndices = [index];
    let cursor = index;
    while (
      tokens[cursor + 1]?.value === "::" &&
      tokens[cursor + 2]?.identifier
    ) {
      segmentIndices.push(cursor + 2);
      cursor += 2;
    }
    const segments = segmentIndices.map((tokenIndex) => tokens[tokenIndex].value);
    const leadingAbsolute =
      tokens[index - 1]?.value === "::" && !tokens[index - 2]?.identifier;
    const importContext = importPathPrefixes.get(index);
    const sourcePath = importContext === undefined
      ? segments
      : [...importContext.prefix, ...segments];
    const absolute = leadingAbsolute || importContext?.absolute === true;
    const binding = absolute
      ? null
      : findBinding(scopeAt[index], sourcePath[0]);
    const importedPath = binding === null ? null : resolveBinding(binding);
    const expanded = importedPath === null
      ? sourcePath
      : [...importedPath, ...sourcePath.slice(1)];

    if (expanded[0] === "sqlx") {
      values[index] = "sqlx";
    } else if (
      expanded[0] === "StorageError" ||
      (expanded[0] === "symphony_storage" &&
        expanded[1] === "StorageError")
    ) {
      if (
        importedPath !== null &&
        (importedPath[0] === "StorageError" ||
          (importedPath[0] === "symphony_storage" &&
            importedPath[1] === "StorageError"))
      ) {
        values[index] = "StorageError";
      }
    } else {
      for (const tokenIndex of segmentIndices) {
        if (["sqlx", "StorageError"].includes(values[tokenIndex])) {
          values[tokenIndex] = "UNRELATED_RESTRICTED_NAME";
        }
      }
    }
    index = cursor;
  }

  let source = "";
  const locations = [];

  for (const [index, token] of tokens.entries()) {
    if (source.length > 0) source += " ";
    const start = source.length;
    const value = values[index];
    source += value;
    locations.push({ start, end: source.length, line: token.line });
  }

  return { source, locations };
}

function lineForMatch(locations, index) {
  let low = 0;
  let high = locations.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (locations[middle].end <= index) {
      low = middle + 1;
    } else if (locations[middle].start > index) {
      high = middle - 1;
    } else {
      return locations[middle].line;
    }
  }
  return locations[Math.min(low, locations.length - 1)]?.line ?? 1;
}

export async function scanRestrictedSources(metadata, policy) {
  validatePolicy(policy);
  const packages = workspacePackages(metadata);
  const errors = new Set();

  for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
    const rules = policy.sourceRules
      .filter((rule) => !rule.allowedPackages.includes(pkg.name))
      .map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, "g") }));
    if (rules.length === 0) continue;

    for (const file of await packageRustFiles(pkg)) {
      let source;
      try {
        source = await fs.readFile(file, "utf8");
      } catch (error) {
        throw new Error(`cannot read ${file}: ${error.message}`);
      }
      const relative = path.relative(metadata.workspace_root, file);
      let tokenStream;
      try {
        tokenStream = normalizedTokenStream(lexRust(source));
      } catch (error) {
        throw new Error(`cannot lex ${relative}: ${error.message}`);
      }
      for (const rule of rules) {
        rule.regex.lastIndex = 0;
        let match;
        while ((match = rule.regex.exec(tokenStream.source)) !== null) {
          errors.add(
            diagnostic(
              relative,
              lineForMatch(tokenStream.locations, match.index),
              `[${rule.id}] ${rule.message} (package ${pkg.name})`,
            ),
          );
          if (match[0].length === 0) rule.regex.lastIndex += 1;
        }
      }
    }
  }

  return [...errors].sort();
}

export async function verifyBoundaries(metadata, policy) {
  return [
    ...verifyCargoMetadata(metadata, policy),
    ...(await scanRestrictedSources(metadata, policy)),
  ].sort();
}
