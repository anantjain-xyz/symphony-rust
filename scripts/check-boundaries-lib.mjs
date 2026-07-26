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
    await addRustFile(files, path.resolve(manifestDir, target.src_path));
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
      index = rawString.contentStart;
      while (index < source.length && !source.startsWith(rawString.closing, index)) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      if (index >= source.length) {
        throw new Error(`unterminated raw string starting on line ${openingLine}`);
      }
      index += rawString.closing.length;
      tokens.push({ value: "LITERAL", line: openingLine });
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
      index = quoteIndex + 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 1;
          if (source[index] === "\n") line += 1;
          if (index < source.length) index += 1;
        } else if (source[index] === '"') {
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
      tokens.push({ value: "LITERAL", line: openingLine });
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

    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierContinue(source[index])) {
        index += 1;
      }
      tokens.push({ value: source.slice(start, index), line });
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

function relevantUseAliases(tokens) {
  const aliases = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    let statementStart = null;
    if (tokens[index].value === "use") {
      statementStart = index + 1;
    } else if (
      tokens[index].value === "extern" &&
      tokens[index + 1]?.value === "crate"
    ) {
      statementStart = index + 2;
    }
    if (statementStart === null) continue;

    let statementEnd = statementStart;
    while (statementEnd < tokens.length && tokens[statementEnd].value !== ";") {
      statementEnd += 1;
    }
    const root = tokens
      .slice(statementStart, statementEnd)
      .find((token) => isIdentifierStart(token.value[0]))?.value;

    for (let cursor = statementStart; cursor < statementEnd; cursor += 1) {
      if (tokens[cursor].value !== "as") continue;
      const alias = tokens[cursor + 1]?.value;
      if (!alias || alias === "_" || !isIdentifierStart(alias[0])) continue;

      let previous = cursor - 1;
      while (
        previous >= statementStart &&
        !isIdentifierStart(tokens[previous].value[0])
      ) {
        previous -= 1;
      }
      const imported = tokens[previous]?.value;
      if (root === "sqlx" || imported === "sqlx") {
        aliases.set(alias, "sqlx");
      } else if (
        imported === "StorageError" ||
        (imported === "self" && root === "StorageError")
      ) {
        aliases.set(alias, "StorageError");
      }
    }

    index = statementEnd;
  }

  return aliases;
}

function normalizedTokenStream(tokens) {
  const aliases = relevantUseAliases(tokens);
  let source = "";
  const locations = [];

  for (const token of tokens) {
    if (source.length > 0) source += " ";
    const start = source.length;
    const value = aliases.get(token.value) ?? token.value;
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
