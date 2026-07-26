import fs from "node:fs/promises";
import path from "node:path";

function diagnostic(file, line, message) {
  return `${file}:${line}: ${message}`;
}

function workspacePackages(metadata) {
  if (
    !metadata ||
    !Array.isArray(metadata.packages) ||
    !Array.isArray(metadata.workspace_members)
  ) {
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
      throw new Error(
        `allowed internal dependency graph contains a cycle: ${[...trail, name].join(" -> ")}`,
      );
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
      errors.push(
        `Cargo.toml:1: workspace package ${name} is missing from architecture/boundaries.json`,
      );
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
          diagnostic(manifest, 1, `${name} may not depend on internal crate ${dependency.name}`),
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

function literalPath(token, context = "#[path]") {
  if (typeof token?.literal !== "string" || token.literal.length === 0) {
    throw new Error(`${context} must contain a non-empty plain string literal`);
  }
  if (
    token.literal.includes("\\") ||
    token.literal.includes("\n") ||
    token.literal.includes("\r") ||
    path.isAbsolute(token.literal)
  ) {
    throw new Error(
      `boundary scan cannot safely resolve ${context} ${JSON.stringify(token.literal)}`,
    );
  }
  return token.literal;
}

function firstTopLevelComma(tokens, start, end) {
  const delimiters = [];
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (closingDelimiter.has(value)) {
      delimiters.push(closingDelimiter.get(value));
    } else if ([")", "]", "}"].includes(value)) {
      if (delimiters.at(-1) === value) delimiters.pop();
    } else if (value === "," && delimiters.length === 0) {
      return index;
    }
  }
  return null;
}

function modulePathAttribute(tokens, modIndex, cfgContext) {
  let boundary = modIndex - 1;
  while (boundary >= 0 && ![";", "{", "}"].includes(tokens[boundary].value)) {
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
      continue;
    }
    if (
      tokens[index].value === "#" &&
      tokens[index + 1]?.value === "[" &&
      tokens[index + 2]?.value === "cfg_attr" &&
      tokens[index + 3]?.value === "("
    ) {
      const closing = matchingDelimiter(tokens, index + 3);
      if (tokens[closing + 1]?.value !== "]" || closing + 1 >= modIndex) {
        throw new Error("malformed cfg_attr attribute");
      }
      const comma = firstTopLevelComma(tokens, index + 4, closing);
      if (comma === null) {
        throw new Error("cfg_attr must contain a predicate and attribute");
      }
      if (evaluateCfgPredicate(tokens, index + 4, comma, cfgContext) === true) {
        for (let cursor = comma + 1; cursor + 2 < closing; cursor += 1) {
          if (
            tokens[cursor].value === "path" &&
            tokens[cursor + 1]?.value === "=" &&
            tokens[cursor + 2]?.value === "LITERAL"
          ) {
            if (result !== null) {
              throw new Error("Rust module declares more than one active #[path]");
            }
            result = literalPath(tokens[cursor + 2], "cfg_attr path");
          }
        }
      }
      index = closing + 1;
    }
  }
  return result;
}

function hasCfgAttribute(tokens, declarationIndex) {
  let boundary = declarationIndex - 1;
  while (boundary >= 0 && ![";", "{", "}"].includes(tokens[boundary].value)) {
    boundary -= 1;
  }
  for (let index = boundary + 1; index + 2 < declarationIndex; index += 1) {
    if (
      tokens[index].value === "#" &&
      tokens[index + 1]?.value === "[" &&
      tokens[index + 2]?.value === "cfg"
    ) {
      return true;
    }
  }
  return false;
}

function rustcCfgContext(activeCfg = []) {
  const flags = new Set();
  const values = new Map();
  for (const entry of activeCfg) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const equals = entry.indexOf("=");
    if (equals === -1) {
      flags.add(entry);
      continue;
    }
    const name = entry.slice(0, equals);
    let value;
    try {
      value = JSON.parse(entry.slice(equals + 1));
    } catch {
      continue;
    }
    if (typeof value !== "string") continue;
    const configured = values.get(name) ?? new Set();
    configured.add(value);
    values.set(name, configured);
  }
  return { flags, values };
}

function defaultPackageFeatures(pkg) {
  const declared = pkg.features ?? {};
  const active = new Set();
  const pending = Object.hasOwn(declared, "default") ? ["default"] : [];
  while (pending.length > 0) {
    const feature = pending.pop();
    if (active.has(feature)) continue;
    active.add(feature);
    for (const member of declared[feature] ?? []) {
      if (
        typeof member === "string" &&
        !member.startsWith("dep:") &&
        !member.includes("/") &&
        Object.hasOwn(declared, member)
      ) {
        pending.push(member);
      }
    }
  }
  return active;
}

function packageCfgContext(metadata, pkg, activeCfg = []) {
  const resolved = metadata.resolve?.nodes?.find((node) => node.id === pkg.id);
  const features = Array.isArray(resolved?.features)
    ? new Set(resolved.features)
    : defaultPackageFeatures(pkg);
  return rustcCfgContext([
    ...activeCfg,
    ...[...features].map((feature) => `feature=${JSON.stringify(feature)}`),
  ]);
}

function evaluateCfgPredicate(tokens, start, end, context) {
  function parse(index) {
    if (!tokens[index]?.identifier) {
      throw new Error(`unsupported cfg predicate token ${tokens[index]?.value ?? "<end>"}`);
    }
    const name = tokens[index].value;
    index += 1;

    if (tokens[index]?.value === "=") {
      if (tokens[index + 1]?.value !== "LITERAL") {
        throw new Error(`cfg ${name} value must be a string literal`);
      }
      const configured = context.values.get(name);
      return {
        index: index + 2,
        value: configured === undefined ? null : configured.has(tokens[index + 1].literal),
      };
    }

    if (tokens[index]?.value !== "(") {
      const knownBooleanFlags = new Set([
        "debug_assertions",
        "target_thread_local",
        "unix",
        "windows",
      ]);
      return {
        index,
        value: context.flags.has(name) ? true : knownBooleanFlags.has(name) ? false : null,
      };
    }

    const closing = matchingDelimiter(tokens, index);
    const arguments_ = [];
    index += 1;
    while (index < closing) {
      const argument = parse(index);
      arguments_.push(argument.value);
      index = argument.index;
      if (tokens[index]?.value === ",") index += 1;
      else if (index < closing) {
        throw new Error(`cfg ${name} arguments must be comma-separated`);
      }
    }
    if (index !== closing) {
      throw new Error(`cfg ${name} has an invalid argument list`);
    }

    let value = null;
    if (name === "all") {
      value = arguments_.includes(false)
        ? false
        : arguments_.every((argument) => argument === true)
          ? true
          : null;
    } else if (name === "any") {
      value = arguments_.includes(true)
        ? true
        : arguments_.every((argument) => argument === false)
          ? false
          : null;
    } else if (name === "not") {
      if (arguments_.length !== 1) {
        throw new Error("cfg not() must contain exactly one predicate");
      }
      value = arguments_[0] === null ? null : !arguments_[0];
    }
    return { index: closing + 1, value };
  }

  const result = parse(start);
  if (result.index !== end) {
    throw new Error("cfg attribute contains trailing tokens");
  }
  return result.value;
}

function cfgMetaDisables(tokens, start, end, context) {
  if (
    tokens[start]?.value === "cfg" &&
    tokens[start + 1]?.value === "(" &&
    matchingDelimiter(tokens, start + 1) === end - 1
  ) {
    return evaluateCfgPredicate(tokens, start + 2, end - 1, context) === false;
  }
  if (
    tokens[start]?.value !== "cfg_attr" ||
    tokens[start + 1]?.value !== "(" ||
    matchingDelimiter(tokens, start + 1) !== end - 1
  ) {
    return false;
  }

  const closing = end - 1;
  const comma = firstTopLevelComma(tokens, start + 2, closing);
  if (comma === null) {
    throw new Error("cfg_attr must contain a predicate and attribute");
  }
  if (evaluateCfgPredicate(tokens, start + 2, comma, context) !== true) {
    return false;
  }

  let attributeStart = comma + 1;
  while (attributeStart < closing) {
    const attributeComma = firstTopLevelComma(tokens, attributeStart, closing) ?? closing;
    if (cfgMetaDisables(tokens, attributeStart, attributeComma, context)) {
      return true;
    }
    attributeStart = attributeComma + 1;
  }
  return false;
}

function cfgDeclarationEnabled(tokens, declarationIndex, context) {
  let boundary = declarationIndex - 1;
  while (boundary >= 0 && ![";", "{", "}"].includes(tokens[boundary].value)) {
    boundary -= 1;
  }
  for (let index = boundary + 1; index + 2 < declarationIndex; index += 1) {
    if (tokens[index].value !== "#" || tokens[index + 1]?.value !== "[") {
      continue;
    }
    const closing = matchingDelimiter(tokens, index + 1);
    if (closing >= declarationIndex) {
      throw new Error("malformed Rust attribute");
    }
    if (cfgMetaDisables(tokens, index + 2, closing, context)) return false;
    index = closing;
  }
  return true;
}

const closingDelimiter = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

function matchingDelimiter(tokens, opening) {
  const expected = closingDelimiter.get(tokens[opening]?.value);
  if (expected === undefined) {
    throw new Error(`token on line ${tokens[opening]?.line ?? 1} is not an opening delimiter`);
  }
  const stack = [];
  for (let index = opening; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (closingDelimiter.has(value)) {
      stack.push(closingDelimiter.get(value));
    } else if ([")", "]", "}"].includes(value)) {
      if (stack.at(-1) !== value) {
        throw new Error(`mismatched Rust delimiter on line ${tokens[index].line}`);
      }
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  throw new Error(`unclosed Rust delimiter starting on line ${tokens[opening].line}`);
}

function matchingBrace(tokens, opening) {
  if (tokens[opening]?.value !== "{") {
    throw new Error(`token on line ${tokens[opening]?.line ?? 1} is not an opening brace`);
  }
  return matchingDelimiter(tokens, opening);
}

function macroDefinitionTokens(tokens) {
  const ignored = new Set();
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    if (
      tokens[index].value !== "macro_rules" ||
      tokens[index].raw ||
      tokens[index + 1]?.value !== "!" ||
      !tokens[index + 2]?.identifier ||
      !closingDelimiter.has(tokens[index + 3]?.value)
    ) {
      continue;
    }
    const closing = matchingDelimiter(tokens, index + 3);
    const end = tokens[closing + 1]?.value === ";" ? closing + 1 : closing;
    for (let cursor = index; cursor <= end; cursor += 1) ignored.add(cursor);
    index = end;
  }
  return ignored;
}

function macroInvocationTokens(tokens, definitionTokens) {
  const invocations = new Set();
  for (let index = 1; index + 1 < tokens.length; index += 1) {
    if (
      tokens[index].value !== "!" ||
      definitionTokens.has(index) ||
      !tokens[index - 1]?.identifier ||
      !closingDelimiter.has(tokens[index + 1]?.value)
    ) {
      continue;
    }
    const closing = matchingDelimiter(tokens, index + 1);
    for (let cursor = index - 1; cursor <= closing; cursor += 1) {
      invocations.add(cursor);
    }
    index = closing;
  }
  return invocations;
}

function literalInclude(tokens, index, sourceFile) {
  if (
    tokens[index].value !== "include" ||
    tokens[index].raw ||
    tokens[index + 1]?.value !== "!" ||
    !closingDelimiter.has(tokens[index + 2]?.value)
  ) {
    return null;
  }

  const closing = matchingDelimiter(tokens, index + 2);
  const argumentTokens = tokens.slice(index + 3, closing);
  if (
    argumentTokens[0]?.value !== "LITERAL" ||
    !(
      argumentTokens.length === 1 ||
      (argumentTokens.length === 2 && argumentTokens[1].value === ",")
    )
  ) {
    throw new Error(
      `cannot resolve non-literal include! declared at ${sourceFile}:${tokens[index].line}`,
    );
  }

  return {
    closing,
    includedPath: literalPath(argumentTokens[0], "include!"),
    line: tokens[index].line,
  };
}

async function resolveIncludedFile(sourceFile, includedPath, line) {
  const includedFile = await existingModuleFile([
    path.join(path.dirname(sourceFile), includedPath),
  ]);
  if (includedFile === null) {
    throw new Error(`cannot resolve include! ${includedPath} declared at ${sourceFile}:${line}`);
  }
  return includedFile;
}

function moduleChildDirectory(moduleFile, explicitPath) {
  return explicitPath !== null || path.basename(moduleFile) === "mod.rs"
    ? path.dirname(moduleFile)
    : path.join(path.dirname(moduleFile), path.basename(moduleFile, path.extname(moduleFile)));
}

function moduleFileCandidates(directory, name, explicitPath) {
  return explicitPath === null
    ? [path.join(directory, `${name}.rs`), path.join(directory, name, "mod.rs")]
    : [path.join(directory, explicitPath)];
}

async function collectTargetModules(
  files,
  includedFiles,
  inactiveFiles,
  activeModuleFiles,
  cfgContext,
  entryFile,
) {
  const visited = new Set();

  async function visit(file, moduleDirectory, included = false) {
    const absolute = path.resolve(file);
    if (included) includedFiles.add(absolute);
    else activeModuleFiles.add(absolute);
    const visitKey = `${absolute}\0${path.resolve(moduleDirectory)}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    await addRustFile(files, absolute);

    let source;
    try {
      source = await fs.readFile(absolute, "utf8");
    } catch (error) {
      throw new Error(`cannot read Rust module ${absolute}: ${error.message}`);
    }
    const tokens = expandSimpleMacroInvocations(lexRust(source));
    const macroTokens = macroDefinitionTokens(tokens);

    async function scan(start, end, directory) {
      for (let index = start; index < end; index += 1) {
        if (macroTokens.has(index)) continue;
        if (
          tokens[index].value === "include" &&
          !tokens[index].raw &&
          tokens[index + 1]?.value === "!" &&
          closingDelimiter.has(tokens[index + 2]?.value) &&
          !cfgDeclarationEnabled(tokens, index, cfgContext)
        ) {
          const closing = matchingDelimiter(tokens, index + 2);
          const argument = tokens[index + 3];
          if (
            argument?.value === "LITERAL" &&
            (index + 4 === closing || (tokens[index + 4]?.value === "," && index + 5 === closing))
          ) {
            inactiveFiles.add(
              path.resolve(path.dirname(absolute), literalPath(argument, "include!")),
            );
          }
          index = closing;
          continue;
        }
        const included = literalInclude(tokens, index, absolute);
        if (included !== null) {
          const includedFile = await resolveIncludedFile(
            absolute,
            included.includedPath,
            included.line,
          );
          await visit(includedFile, path.dirname(includedFile), true);
          index = included.closing;
          continue;
        }
        if (tokens[index].value !== "mod" || !tokens[index + 1]?.identifier) {
          continue;
        }
        const name = tokens[index + 1].value;
        const terminator = tokens[index + 2]?.value;
        const enabled = cfgDeclarationEnabled(tokens, index, cfgContext);
        if (terminator === "{") {
          const closing = matchingBrace(tokens, index + 2);
          if (enabled) {
            await scan(index + 3, closing, path.join(directory, name));
          }
          index = closing;
          continue;
        }
        if (terminator !== ";") continue;

        const explicitPath = modulePathAttribute(tokens, index, cfgContext);
        const candidates = moduleFileCandidates(directory, name, explicitPath);
        if (!enabled) {
          for (const candidate of candidates) {
            inactiveFiles.add(path.resolve(candidate));
          }
          continue;
        }
        const moduleFile = await existingModuleFile(candidates);
        if (moduleFile === null) {
          throw new Error(
            `cannot resolve Rust module ${name} declared at ${absolute}:${tokens[index].line}`,
          );
        }
        const childDirectory = moduleChildDirectory(moduleFile, explicitPath);
        await visit(moduleFile, childDirectory);
      }
    }

    await scan(0, tokens.length, moduleDirectory);
  }

  const absoluteEntry = path.resolve(entryFile);
  await visit(absoluteEntry, path.dirname(absoluteEntry));
}

async function expandedRustTokens(
  file,
  moduleDirectory,
  expandModules,
  cfgContext,
  cache,
  trail = [],
) {
  const absolute = path.resolve(file);
  if (trail.includes(absolute)) {
    throw new Error(`Rust source expansion cycle: ${[...trail, absolute].join(" -> ")}`);
  }
  const cacheKey = [
    absolute,
    path.resolve(moduleDirectory),
    expandModules ? "modules" : "includes",
  ].join("\0");
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let source;
  try {
    source = await fs.readFile(absolute, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${absolute}: ${error.message}`);
  }
  const tokens = expandSimpleMacroInvocations(
    lexRust(source).map((token) => ({ ...token, file: absolute })),
  );
  const macroTokens = macroDefinitionTokens(tokens);
  const nextTrail = [...trail, absolute];

  async function expandRange(start, end, directory) {
    const expanded = [];
    for (let index = start; index < end; index += 1) {
      if (macroTokens.has(index)) {
        expanded.push(tokens[index]);
        continue;
      }
      if (
        tokens[index].value === "include" &&
        !tokens[index].raw &&
        tokens[index + 1]?.value === "!" &&
        closingDelimiter.has(tokens[index + 2]?.value) &&
        !cfgDeclarationEnabled(tokens, index, cfgContext)
      ) {
        index = matchingDelimiter(tokens, index + 2);
        continue;
      }
      const included = literalInclude(tokens, index, absolute);
      if (included !== null) {
        const includedFile = await resolveIncludedFile(
          absolute,
          included.includedPath,
          included.line,
        );
        expanded.push(
          ...(await expandedRustTokens(
            includedFile,
            path.dirname(includedFile),
            expandModules,
            cfgContext,
            cache,
            nextTrail,
          )),
        );
        index = included.closing;
        continue;
      }

      if (tokens[index].value !== "mod" || !tokens[index + 1]?.identifier) {
        expanded.push(tokens[index]);
        continue;
      }

      const name = tokens[index + 1].value;
      const terminator = tokens[index + 2]?.value;
      const enabled = cfgDeclarationEnabled(tokens, index, cfgContext);
      if (!enabled) {
        if (terminator === "{") {
          index = matchingBrace(tokens, index + 2);
        } else if (terminator === ";") {
          index += 2;
        } else {
          expanded.push(tokens[index]);
        }
        continue;
      }
      if (!expandModules) {
        expanded.push(tokens[index]);
        continue;
      }
      if (terminator === "{") {
        const closing = matchingBrace(tokens, index + 2);
        expanded.push(
          tokens[index],
          tokens[index + 1],
          tokens[index + 2],
          ...(await expandRange(index + 3, closing, path.join(directory, name))),
          tokens[closing],
        );
        index = closing;
        continue;
      }
      if (terminator !== ";") {
        expanded.push(tokens[index]);
        continue;
      }

      const explicitPath = modulePathAttribute(tokens, index, cfgContext);
      const moduleFile = await existingModuleFile(
        moduleFileCandidates(directory, name, explicitPath),
      );
      if (moduleFile === null) {
        throw new Error(
          `cannot resolve Rust module ${name} declared at ${absolute}:${tokens[index].line}`,
        );
      }
      const childDirectory = moduleChildDirectory(moduleFile, explicitPath);
      const opening = { ...tokens[index + 2], value: "{" };
      const closing = { ...tokens[index + 2], value: "}" };
      expanded.push(
        tokens[index],
        tokens[index + 1],
        opening,
        ...(await expandedRustTokens(
          moduleFile,
          childDirectory,
          true,
          cfgContext,
          cache,
          nextTrail,
        )),
        closing,
      );
      index += 2;
    }
    return expanded;
  }

  const expanded = await expandRange(0, tokens.length, moduleDirectory);
  cache.set(cacheKey, expanded);
  return expanded;
}

async function packageRustFiles(pkg, cfgContext) {
  const manifestDir = path.dirname(pkg.manifest_path);
  const roots = ["src", "tests", "examples", "benches"].map((name) => path.join(manifestDir, name));
  const files = new Set();
  const includedFiles = new Set();
  const inactiveFiles = new Set();
  const activeModuleFiles = new Set();
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
    await collectTargetModules(
      files,
      includedFiles,
      inactiveFiles,
      activeModuleFiles,
      cfgContext,
      path.resolve(manifestDir, target.src_path),
    );
  }

  return [...files]
    .filter(
      (file) =>
        !activeModuleFiles.has(file) && !includedFiles.has(file) && !inactiveFiles.has(file),
    )
    .sort();
}

function restrictedCrateAliases(pkg) {
  const aliases = new Map();
  for (const dependency of pkg.dependencies ?? []) {
    if (!dependency || typeof dependency.name !== "string") continue;
    const canonical = dependency.name.replaceAll("-", "_");
    if (!["sqlx", "symphony_storage"].includes(canonical)) continue;
    const exposed = String(dependency.rename ?? dependency.name).replaceAll("-", "_");
    aliases.set(exposed, canonical);
  }
  return aliases;
}

function sourceCharacter(source, index) {
  const codePoint = source.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function isIdentifierStart(character) {
  return character === "_" || /^\p{XID_Start}$/u.test(character);
}

function isIdentifierContinue(character) {
  return character === "_" || /^\p{XID_Continue}$/u.test(character);
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
    const character = sourceCharacter(source, index);

    if (/\s/.test(character)) {
      if (character === "\n") line += 1;
      index += character.length;
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
    } else if ((character === "b" || character === "c") && source[index + 1] === '"') {
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
      source.startsWith("r#", index) && isIdentifierStart(sourceCharacter(source, index + 2));
    if (rawIdentifier || isIdentifierStart(character)) {
      const start = rawIdentifier ? index + 2 : index;
      index = start;
      index += sourceCharacter(source, index).length;
      while (index < source.length && isIdentifierContinue(sourceCharacter(source, index))) {
        index += sourceCharacter(source, index).length;
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
    index += character.length;
  }

  return tokens;
}

function attributeTokens(tokens) {
  const attributes = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "#") continue;
    let opening = index + 1;
    if (tokens[opening]?.value === "!") opening += 1;
    if (tokens[opening]?.value !== "[") continue;
    const closing = matchingDelimiter(tokens, opening);
    for (let cursor = index; cursor <= closing; cursor += 1) {
      attributes.add(cursor);
    }
    index = closing;
  }
  return attributes;
}

function importStatements(tokens, ignoredTokens, invocationTokens, attributes) {
  const statements = [];
  const groupBraces = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    if (attributes.has(index)) continue;
    const insideMacroDefinition = ignoredTokens.has(index);
    const insideMacroInvocation = invocationTokens.has(index);
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
    if (insideMacroInvocation) {
      index = end;
      continue;
    }
    if (insideMacroDefinition && tokens.slice(start, end).some((token) => token.value === "$")) {
      index = end;
      continue;
    }
    statements.push({
      kind,
      tokenIndex: index,
      start,
      end,
      conditional: hasCfgAttribute(tokens, index),
    });
    index = end;
  }

  return { statements, groupBraces };
}

function lexicalScopes(tokens, groupBraces) {
  const root = { parent: null, bindings: new Map(), globs: [], line: 1 };
  root.crateScope = root;
  root.moduleParent = null;
  root.moduleScope = root;
  const moduleScopes = new Map();
  const scopeAt = [];
  const stack = [root];

  for (let index = 0; index < tokens.length; index += 1) {
    scopeAt[index] = stack.at(-1);
    if (groupBraces.has(index)) continue;
    if (tokens[index].value === "{") {
      const parent = stack.at(-1);
      const opensModule =
        tokens[index - 2]?.value === "mod" &&
        !tokens[index - 2]?.raw &&
        tokens[index - 1]?.identifier;
      const child = {
        parent,
        bindings: new Map(),
        crateScope: root,
        globs: [],
        line: tokens[index].line,
      };
      if (opensModule) {
        child.moduleParent = parent.moduleScope;
        child.moduleScope = child;
        moduleScopes.set(index - 2, child);
      } else {
        child.moduleParent = parent.moduleParent;
        child.moduleScope = parent.moduleScope;
      }
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
  return { moduleScopes, root, scopeAt };
}

function parseUseBindings(tokens, start, end) {
  const bindings = [];
  const globs = [];
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

    if (tokens[index]?.value === "*") {
      globs.push({ path: [...prefix], absolute });
      return index + 1;
    }
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

    let name = segment === "self" && prefix.length > 0 ? prefix.at(-1) : segment;
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
  return { bindings, globs, pathPrefixes };
}

const allRustNamespaces = new Set(["macro", "type", "value"]);

function bindingNamespaces(binding) {
  if (binding.namespaceBindings) {
    return new Set(binding.namespaceBindings.keys());
  }
  return binding.namespaces ?? allRustNamespaces;
}

function mergeOverlappingBinding(existing, declared, name, scope) {
  if (existing.implicit && !declared.implicit) {
    return declared;
  }
  if (declared.implicit) return existing;
  if (!existing.conditional || !declared.conditional) {
    throw new Error(`ambiguous Rust declarations bind ${name} more than once in one scope`);
  }
  if (existing.alternatives) {
    return {
      ...existing,
      alternatives: [...existing.alternatives, declared],
      conditional: true,
      descendantVisible: existing.descendantVisible === true && declared.descendantVisible === true,
      name,
      scope,
    };
  }
  return {
    alternatives: [existing, declared],
    conditional: true,
    descendantVisible: existing.descendantVisible === true && declared.descendantVisible === true,
    name,
    scope,
  };
}

function combinedNamespaceBinding(namespaceBindings, name, scope) {
  const namespaceAlternatives = [...new Set(namespaceBindings.values())];
  if (namespaceAlternatives.length === 1) return namespaceAlternatives[0];
  return {
    descendantVisible: namespaceAlternatives.every((binding) => binding.descendantVisible === true),
    name,
    namespaceAlternatives,
    namespaceBindings,
    scope,
  };
}

function declareBinding(scope, name, binding) {
  const declared = {
    ...binding,
    name,
    namespaces: new Set(binding.namespaces ?? allRustNamespaces),
    scope,
  };
  const existing = scope.bindings.get(name);
  if (existing === undefined) {
    scope.bindings.set(name, declared);
    return;
  }

  const namespaceBindings = existing.namespaceBindings
    ? new Map(existing.namespaceBindings)
    : new Map([...bindingNamespaces(existing)].map((namespace) => [namespace, existing]));
  const mergedByExisting = new Map();
  for (const namespace of declared.namespaces) {
    const current = namespaceBindings.get(namespace);
    if (current === undefined) {
      namespaceBindings.set(namespace, declared);
      continue;
    }
    let merged = mergedByExisting.get(current);
    if (merged === undefined) {
      merged = mergeOverlappingBinding(current, declared, name, scope);
      mergedByExisting.set(current, merged);
    }
    namespaceBindings.set(namespace, merged);
  }
  scope.bindings.set(name, combinedNamespaceBinding(namespaceBindings, name, scope));
}

function simplePath(tokens, start, end) {
  while (tokens[start]?.value === "(" && matchingDelimiter(tokens, start) === end - 1) {
    start += 1;
    end -= 1;
  }

  let index = start;
  let absolute = false;
  if (tokens[index]?.value === "::") {
    absolute = true;
    index += 1;
  }
  if (!tokens[index]?.identifier) return null;
  const pathSegments = [tokens[index].value];
  index += 1;
  while (index < end) {
    if (tokens[index]?.value !== "::" || !tokens[index + 1]?.identifier) {
      return null;
    }
    pathSegments.push(tokens[index + 1].value);
    index += 2;
  }
  return { path: pathSegments, absolute };
}

function collectLocalItems(tokens, scopeAt, moduleScopes) {
  const itemKeywords = new Set(["enum", "mod", "struct", "trait", "union"]);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index].value === "fn" && !tokens[index].raw && tokens[index + 1].identifier) {
      const name = tokens[index + 1].value;
      declareBinding(scopeAt[index], name, {
        absolute: true,
        conditional: hasCfgAttribute(tokens, index),
        namespaces: new Set(["value"]),
        path: ["LOCAL_VALUE", name],
      });
      continue;
    }
    if (tokens[index].value === "type" && !tokens[index].raw && tokens[index + 1].identifier) {
      const name = tokens[index + 1].value;
      let binding = {
        path: ["LOCAL_ITEM", name],
        absolute: true,
      };
      if (tokens[index + 2]?.value === "=") {
        let end = index + 3;
        while (end < tokens.length && tokens[end].value !== ";") end += 1;
        if (end < tokens.length) {
          binding = simplePath(tokens, index + 3, end) ?? binding;
        }
      }
      declareBinding(scopeAt[index], name, {
        ...binding,
        conditional: hasCfgAttribute(tokens, index),
        namespaces: new Set(["type"]),
      });
      continue;
    }
    if (
      tokens[index].raw ||
      !itemKeywords.has(tokens[index].value) ||
      !tokens[index + 1].identifier
    ) {
      continue;
    }
    const binding = {
      path: ["LOCAL_ITEM", tokens[index + 1].value],
      absolute: true,
      conditional: hasCfgAttribute(tokens, index),
      namespaces: tokens[index].value === "struct" ? new Set(["type", "value"]) : new Set(["type"]),
    };
    if (tokens[index].value === "mod" && moduleScopes.has(index)) {
      binding.moduleScope = moduleScopes.get(index);
    }
    declareBinding(scopeAt[index], tokens[index + 1].value, binding);
  }
}

function matchingAngle(tokens, opening) {
  if (tokens[opening]?.value !== "<") return null;
  let depth = 0;
  for (let index = opening; index < tokens.length; index += 1) {
    if (tokens[index].value === "<") {
      depth += 1;
    } else if (tokens[index].value === ">" && tokens[index - 1]?.value !== "-") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function itemBodyOpening(tokens, start) {
  for (let index = start; index < tokens.length; index += 1) {
    if (["(", "["].includes(tokens[index].value)) {
      index = matchingDelimiter(tokens, index);
      continue;
    }
    if (tokens[index].value === "<") {
      const closing = matchingAngle(tokens, index);
      if (closing !== null) {
        index = closing;
        continue;
      }
    }
    if (tokens[index].value === "{") return index;
    if (tokens[index].value === ";") return null;
  }
  return null;
}

function genericParameterNames(tokens, start, end) {
  const parameters = [];
  let parameterStart = start;
  const delimiters = [];
  let angleDepth = 0;

  function addParameter(parameterEnd) {
    const parameter = tokens.slice(parameterStart, parameterEnd);
    if (parameter.length === 0 || parameter[0].value === "'") return;
    if (parameter[0].value === "const" && !parameter[0].raw && parameter[1]?.identifier) {
      parameters.push(parameter[1].value);
    } else if (parameter[0].identifier) {
      parameters.push(parameter[0].value);
    }
  }

  for (let index = start; index <= end; index += 1) {
    if (index === end) {
      addParameter(index);
      break;
    }
    const value = tokens[index].value;
    if (closingDelimiter.has(value)) {
      delimiters.push(closingDelimiter.get(value));
    } else if ([")", "]", "}"].includes(value)) {
      if (delimiters.at(-1) === value) delimiters.pop();
    } else if (value === "<") {
      angleDepth += 1;
    } else if (value === ">" && tokens[index - 1]?.value !== "-") {
      angleDepth -= 1;
    } else if (value === "," && delimiters.length === 0 && angleDepth === 0) {
      addParameter(index);
      parameterStart = index + 1;
    }
  }
  return parameters;
}

function collectGenericParameters(tokens, scopeAt) {
  const namedGenericItems = new Set(["enum", "fn", "struct", "trait", "type", "union"]);
  for (let index = 0; index < tokens.length; index += 1) {
    let genericOpening = null;
    if (
      !tokens[index].raw &&
      namedGenericItems.has(tokens[index].value) &&
      tokens[index + 1]?.identifier &&
      tokens[index + 2]?.value === "<"
    ) {
      genericOpening = index + 2;
    } else if (
      tokens[index].value === "impl" &&
      !tokens[index].raw &&
      tokens[index + 1]?.value === "<"
    ) {
      genericOpening = index + 1;
    }
    if (genericOpening === null) continue;

    const genericClosing = matchingAngle(tokens, genericOpening);
    if (genericClosing === null) {
      throw new Error(`unclosed Rust generic parameter list on line ${tokens[index].line}`);
    }
    const bodyOpening = itemBodyOpening(tokens, genericClosing + 1);
    if (bodyOpening === null) continue;
    const bodyScope = scopeAt[bodyOpening + 1];
    for (const name of genericParameterNames(tokens, genericOpening + 1, genericClosing)) {
      declareBinding(bodyScope, name, {
        absolute: true,
        namespaces: new Set(["type"]),
        path: ["LOCAL_ITEM", name],
      });
    }
  }
}

function collectImplSelfBindings(tokens, scopeAt) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "impl" || tokens[index].raw) continue;
    let headerStart = index + 1;
    if (tokens[headerStart]?.value === "<") {
      const genericClosing = matchingAngle(tokens, headerStart);
      if (genericClosing === null) {
        throw new Error(`unclosed impl generic parameter list on line ${tokens[index].line}`);
      }
      headerStart = genericClosing + 1;
    }
    const bodyOpening = itemBodyOpening(tokens, headerStart);
    if (bodyOpening === null) continue;

    let forIndex = null;
    let whereIndex = null;
    for (let cursor = headerStart; cursor < bodyOpening; cursor += 1) {
      if (["(", "["].includes(tokens[cursor].value)) {
        cursor = matchingDelimiter(tokens, cursor);
        continue;
      }
      if (tokens[cursor].value === "<") {
        const closing = matchingAngle(tokens, cursor);
        if (closing !== null) {
          cursor = closing;
          continue;
        }
      }
      if (tokens[cursor].value === "where" && !tokens[cursor].raw) {
        whereIndex = cursor;
        break;
      }
      if (tokens[cursor].value === "for" && !tokens[cursor].raw) {
        forIndex = cursor;
      }
    }
    const targetStart = forIndex === null ? headerStart : forIndex + 1;
    const targetEnd = whereIndex ?? bodyOpening;
    const target = simplePath(tokens, targetStart, targetEnd);
    if (target === null) continue;
    declareBinding(scopeAt[bodyOpening + 1], "Self", {
      ...target,
      namespaces: new Set(["type"]),
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
          path: imported === "self" ? [] : [imported],
          absolute: imported !== "self",
          moduleScope: imported === "self" ? scope.crateScope : undefined,
          conditional: statement.conditional,
          descendantVisible: true,
          namespaces: new Set(["type"]),
        });
      }
      continue;
    }

    const parsed = parseUseBindings(tokens, statement.start, statement.end);
    for (const binding of parsed.bindings) {
      const target = resolvePathBinding(scope, binding.path, binding.absolute);
      declareBinding(scope, binding.name, {
        ...binding,
        conditional: statement.conditional,
        namespaces: target === null ? allRustNamespaces : bindingNamespaces(target),
      });
    }
    for (const glob of parsed.globs) {
      scope.globs.push({ ...glob, scope });
    }
    for (const [tokenIndex, context] of parsed.pathPrefixes) {
      importPathPrefixes.set(tokenIndex, context);
    }
  }
  return importPathPrefixes;
}

function findBinding(scope, name) {
  const moduleScope = scope.moduleScope;
  for (let current = scope; current !== null; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding && (current.moduleScope === moduleScope || binding.descendantVisible)) {
      return binding;
    }
  }
  return null;
}

function bindingResolutionAlternatives(binding) {
  return binding.alternatives ?? binding.namespaceAlternatives ?? null;
}

function resolveBinding(binding, seen = new Set()) {
  if (seen.has(binding)) {
    throw new Error(
      `cyclic Rust import alias involving ${
        binding.path?.join("::") ?? binding.name ?? "cfg-conditioned binding"
      }`,
    );
  }
  const bindingAlternatives = bindingResolutionAlternatives(binding);
  if (bindingAlternatives) {
    seen.add(binding);
    const alternatives = bindingAlternatives.map((alternative) =>
      resolveBinding(alternative, seen),
    );
    seen.delete(binding);
    const restricted = alternatives.find(
      (candidate) =>
        candidate[0] === "sqlx" ||
        isStorageErrorPath(candidate) ||
        isStorageErrorVariantPath(candidate, "Sqlx"),
    );
    if (restricted) return restricted;
    const [first] = alternatives;
    if (alternatives.every((candidate) => JSON.stringify(candidate) === JSON.stringify(first))) {
      return first;
    }
    return [
      binding.namespaceAlternatives ? "NAMESPACE_DEPENDENT_BINDING" : "CFG_DEPENDENT_BINDING",
      binding.name,
    ];
  }
  if (binding.absolute || binding.path.length === 0) return [...binding.path];

  seen.add(binding);
  const resolved = resolvePath(binding.scope, binding.path, false, seen, binding);
  seen.delete(binding);
  return resolved;
}

function resolveBindingModuleScope(binding, seen = new Set()) {
  if (binding.moduleScope) return binding.moduleScope;
  if (seen.has(binding)) return null;
  const bindingAlternatives = bindingResolutionAlternatives(binding);
  if (bindingAlternatives) {
    const scopes = bindingAlternatives.map((alternative) =>
      resolveBindingModuleScope(alternative, new Set(seen)),
    );
    const [first] = scopes;
    return first !== null && scopes.every((scope) => scope === first) ? first : null;
  }
  if (binding.absolute || binding.path.length === 0) return null;

  seen.add(binding);
  const moduleScope = resolvePathModuleScope(binding.scope, binding.path, false, seen, binding);
  seen.delete(binding);
  return moduleScope;
}

function resolveBoundModuleScope(binding, remaining, seen) {
  const moduleScope = resolveBindingModuleScope(binding, seen);
  if (moduleScope === null || remaining.length === 0) return moduleScope;
  const member = moduleScope.bindings.get(remaining[0]);
  if (!member) return null;
  return resolveBoundModuleScope(member, remaining.slice(1), seen);
}

function resolvePathModuleScope(scope, pathSegments, absolute, seen, sourceBinding) {
  if (absolute || pathSegments.length === 0) return null;

  let binding;
  let remaining;
  if (["crate", "self", "super"].includes(pathSegments[0])) {
    let moduleScope = scope.moduleScope;
    let index = 0;
    if (pathSegments[index] === "crate") {
      moduleScope = scope.crateScope;
      index += 1;
    } else if (pathSegments[index] === "self") {
      index += 1;
    } else {
      while (pathSegments[index] === "super") {
        moduleScope = moduleScope?.moduleParent ?? null;
        index += 1;
      }
    }
    if (moduleScope === null) return null;
    if (index >= pathSegments.length) return moduleScope;
    binding = moduleScope.bindings.get(pathSegments[index]) ?? null;
    if (binding?.implicit) return null;
    remaining = pathSegments.slice(index + 1);
  } else {
    binding = findBinding(scope, pathSegments[0]);
    remaining = pathSegments.slice(1);
  }

  if (binding === null || binding === sourceBinding) return null;
  return resolveBoundModuleScope(binding, remaining, seen);
}

function resolvePathBinding(scope, pathSegments, absolute) {
  if (absolute || pathSegments.length === 0) return null;

  let binding;
  let index = 0;
  if (["crate", "self", "super"].includes(pathSegments[0])) {
    let moduleScope = scope.moduleScope;
    if (pathSegments[index] === "crate") {
      moduleScope = scope.crateScope;
      index += 1;
    } else if (pathSegments[index] === "self") {
      index += 1;
    } else {
      while (pathSegments[index] === "super") {
        moduleScope = moduleScope?.moduleParent ?? null;
        index += 1;
      }
    }
    if (moduleScope === null || index >= pathSegments.length) return null;
    binding = moduleScope.bindings.get(pathSegments[index]) ?? null;
    index += 1;
  } else {
    binding = findBinding(scope, pathSegments[index]);
    index += 1;
  }

  while (binding !== null && index < pathSegments.length) {
    const moduleScope = resolveBindingModuleScope(binding);
    binding = moduleScope?.bindings.get(pathSegments[index]) ?? null;
    index += 1;
  }
  return binding;
}

function resolveBoundPath(binding, remaining, seen) {
  if (remaining.length > 0) {
    const moduleScope = resolveBindingModuleScope(binding, new Set(seen));
    const member = moduleScope?.bindings.get(remaining[0]);
    if (member) {
      return resolveBoundPath(member, remaining.slice(1), seen);
    }
  }
  return [...resolveBinding(binding, seen), ...remaining];
}

function resolvePath(scope, pathSegments, absolute, seen = new Set(), sourceBinding = null) {
  if (absolute || pathSegments.length === 0) return [...pathSegments];

  let binding;
  let remaining;
  if (["crate", "self", "super"].includes(pathSegments[0])) {
    let moduleScope = scope.moduleScope;
    let index = 0;
    if (pathSegments[index] === "crate") {
      moduleScope = scope.crateScope;
      index += 1;
    } else if (pathSegments[index] === "self") {
      index += 1;
    } else {
      while (pathSegments[index] === "super") {
        moduleScope = moduleScope?.moduleParent ?? null;
        index += 1;
      }
    }
    if (moduleScope === null || index >= pathSegments.length) {
      return [...pathSegments];
    }
    binding = moduleScope.bindings.get(pathSegments[index]) ?? null;
    if (binding?.implicit) return [...pathSegments];
    remaining = pathSegments.slice(index + 1);
  } else {
    binding = findBinding(scope, pathSegments[0]);
    remaining = pathSegments.slice(1);
  }

  if (binding === null || binding === sourceBinding) return [...pathSegments];
  return resolveBoundPath(binding, remaining, seen);
}

function combinedGlobBinding(candidates, name, scope) {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];
  return {
    alternatives: unique,
    conditional: true,
    descendantVisible: false,
    name,
    scope,
  };
}

function findModuleGlobMember(moduleScope, name, seenScopes = new Set()) {
  if (moduleScope === null || seenScopes.has(moduleScope)) return null;
  const direct = moduleScope.bindings.get(name);
  if (direct) return direct;

  seenScopes.add(moduleScope);
  const candidates = [];
  for (const glob of moduleScope.globs) {
    const target = resolvePathModuleScope(glob.scope, glob.path, glob.absolute, new Set(), null);
    const candidate = findModuleGlobMember(target, name, seenScopes);
    if (candidate) candidates.push(candidate);
  }
  seenScopes.delete(moduleScope);
  return combinedGlobBinding(candidates, name, moduleScope);
}

function findGlobbedBinding(scope, name) {
  const moduleScope = scope.moduleScope;
  for (let current = scope; current !== null; current = current.parent) {
    if (current.moduleScope !== moduleScope) break;
    if (current.bindings.has(name)) return null;
    const candidates = [];
    for (const glob of current.globs) {
      const target = resolvePathModuleScope(glob.scope, glob.path, glob.absolute, new Set(), null);
      const candidate = findModuleGlobMember(target, name);
      if (candidate) candidates.push(candidate);
    }
    const binding = combinedGlobBinding(candidates, name, current);
    if (binding) return binding;
  }
  return null;
}

function isStorageErrorPath(pathSegments) {
  return (
    (pathSegments.length === 1 && pathSegments[0] === "StorageError") ||
    (pathSegments.length === 2 &&
      pathSegments[0] === "symphony_storage" &&
      pathSegments[1] === "StorageError")
  );
}

function isStorageErrorVariantPath(pathSegments, variant) {
  return pathSegments.at(-1) === variant && isStorageErrorPath(pathSegments.slice(0, -1));
}

function hasStorageErrorGlob(scope, name) {
  const moduleScope = scope.moduleScope;
  for (let current = scope; current !== null; current = current.parent) {
    if (current.moduleScope !== moduleScope) break;
    if (current.bindings.has(name)) return false;
    if (
      current.globs.some((glob) =>
        isStorageErrorPath(resolvePath(glob.scope, glob.path, glob.absolute)),
      )
    ) {
      return true;
    }
  }
  return false;
}

function qualifiedVariantClosing(tokens, index, cursor, leadingAbsolute, variant) {
  let start = leadingAbsolute ? index - 1 : index;
  let end = cursor;
  while (
    tokens[start - 1]?.value === "(" &&
    tokens[end + 1]?.value === ")" &&
    matchingDelimiter(tokens, start - 1) === end + 1
  ) {
    start -= 1;
    end += 1;
  }
  if (
    tokens[start - 1]?.value === "<" &&
    tokens[end + 1]?.value === ">" &&
    tokens[end + 2]?.value === "::" &&
    tokens[end + 3]?.value === variant
  ) {
    return end + 1;
  }
  return null;
}

function turbofishVariantClosing(tokens, cursor, variant) {
  if (tokens[cursor + 1]?.value !== "::" || tokens[cursor + 2]?.value !== "<") {
    return null;
  }
  const closing = matchingAngle(tokens, cursor + 2);
  if (
    closing === null ||
    tokens[closing + 1]?.value !== "::" ||
    tokens[closing + 2]?.value !== variant
  ) {
    return null;
  }
  return closing;
}

function followsMatchGuard(tokens, index) {
  const openingForClosing = new Map([
    [")", "("],
    ["]", "["],
    ["}", "{"],
  ]);
  const delimiters = [];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const value = tokens[cursor].value;
    if (openingForClosing.has(value)) {
      delimiters.push(openingForClosing.get(value));
      continue;
    }
    if (closingDelimiter.has(value)) {
      if (delimiters.length === 0) {
        if (value === "{") return false;
        continue;
      }
      if (delimiters.at(-1) !== value) return false;
      delimiters.pop();
      continue;
    }
    if (delimiters.length > 0) continue;
    if (value === "if" && !tokens[cursor].raw) return true;
    if ([",", "{", "}", ";"].includes(value)) return false;
    if (value === ">" && tokens[cursor - 1]?.value === "=") {
      return false;
    }
  }
  return false;
}

function followedByMatchArm(tokens, index) {
  const delimiters = [];
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor].value;
    if (closingDelimiter.has(value)) {
      delimiters.push(closingDelimiter.get(value));
      continue;
    }
    if ([")", "]", "}"].includes(value)) {
      if (delimiters.length === 0) return false;
      if (delimiters.at(-1) !== value) return false;
      delimiters.pop();
      continue;
    }
    if (delimiters.length > 0) continue;
    if (value === "=" && tokens[cursor + 1]?.value === ">") {
      return !followsMatchGuard(tokens, index);
    }
    if ([",", ";"].includes(value)) return false;
  }
  return false;
}

function followsLetPattern(tokens, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const value = tokens[cursor].value;
    if ([";", "{", "}"].includes(value)) return false;
    if (value === "=") return false;
    if (value === "let" && !tokens[cursor].raw) return true;
  }
  return false;
}

function isMatchesMacroPattern(tokens, index) {
  for (let opening = index - 1; opening >= 2; opening -= 1) {
    if (
      !closingDelimiter.has(tokens[opening].value) ||
      tokens[opening - 1]?.value !== "!" ||
      tokens[opening - 2]?.value !== "matches"
    ) {
      continue;
    }
    const closing = matchingDelimiter(tokens, opening);
    if (closing < index) continue;

    const delimiters = [];
    let patternStarted = false;
    for (let cursor = opening + 1; cursor < index; cursor += 1) {
      const value = tokens[cursor].value;
      if (closingDelimiter.has(value)) {
        delimiters.push(closingDelimiter.get(value));
      } else if ([")", "]", "}"].includes(value)) {
        if (delimiters.at(-1) === value) delimiters.pop();
      } else if (delimiters.length === 0) {
        if (value === "," && !patternStarted) {
          patternStarted = true;
        } else if (patternStarted && value === "if" && !tokens[cursor].raw) {
          return false;
        }
      }
    }
    return patternStarted;
  }
  return false;
}

function isRustPattern(tokens, index) {
  return (
    followedByMatchArm(tokens, index) ||
    followsLetPattern(tokens, index) ||
    isMatchesMacroPattern(tokens, index)
  );
}

function macroRuleScopes(tokens, definitionTokens) {
  const root = { parent: null };
  const scopeAt = [];
  const stack = [root];
  for (let index = 0; index < tokens.length; index += 1) {
    scopeAt[index] = stack.at(-1);
    if (definitionTokens.has(index)) continue;
    if (tokens[index].value === "{") {
      stack.push({ parent: stack.at(-1) });
    } else if (tokens[index].value === "}" && stack.length > 1) {
      stack.pop();
    }
  }
  return scopeAt;
}

function simpleMacroRules(tokens, definitionTokens) {
  const scopeAt = macroRuleScopes(tokens, definitionTokens);
  const definitions = new Map();
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    if (
      tokens[index].value !== "macro_rules" ||
      tokens[index].raw ||
      tokens[index + 1]?.value !== "!" ||
      !tokens[index + 2]?.identifier ||
      !closingDelimiter.has(tokens[index + 3]?.value)
    ) {
      continue;
    }
    const definitionClosing = matchingDelimiter(tokens, index + 3);
    const arms = [];
    let cursor = index + 4;
    while (cursor < definitionClosing) {
      if ([",", ";"].includes(tokens[cursor].value)) {
        cursor += 1;
        continue;
      }
      if (!closingDelimiter.has(tokens[cursor].value)) break;
      const matcherOpening = cursor;
      const matcherClosing = matchingDelimiter(tokens, matcherOpening);
      if (
        tokens[matcherClosing + 1]?.value !== "=" ||
        tokens[matcherClosing + 2]?.value !== ">" ||
        !closingDelimiter.has(tokens[matcherClosing + 3]?.value)
      ) {
        break;
      }
      const expansionOpening = matcherClosing + 3;
      const expansionClosing = matchingDelimiter(tokens, expansionOpening);
      const matcher = tokens.slice(matcherOpening + 1, matcherClosing);
      const captures = [];
      const matcherParts = [];
      let supported = true;
      let matcherIndex = 0;
      while (matcherIndex < matcher.length) {
        if (
          matcher[matcherIndex].value === "$" &&
          matcher[matcherIndex + 1]?.identifier &&
          matcher[matcherIndex + 2]?.value === ":" &&
          matcher[matcherIndex + 3]?.identifier
        ) {
          const name = matcher[matcherIndex + 1].value;
          captures.push(name);
          matcherParts.push({
            kind: "capture",
            fragment: matcher[matcherIndex + 3].value,
            name,
          });
          matcherIndex += 4;
          continue;
        }
        if (matcher[matcherIndex].value === "$") {
          supported = false;
          break;
        }
        matcherParts.push({
          kind: "literal",
          token: matcher[matcherIndex],
        });
        matcherIndex += 1;
      }
      if (supported && new Set(captures).size === captures.length) {
        arms.push({
          captures,
          matcherParts,
          expansion: tokens.slice(expansionOpening, expansionClosing + 1),
        });
      }
      cursor = expansionClosing + 1;
    }
    const name = tokens[index + 2].value;
    const named = definitions.get(name) ?? [];
    named.push({ arms, index, scope: scopeAt[index] });
    definitions.set(name, named);
    index = definitionClosing;
  }
  return { definitions, scopeAt };
}

function scopeContains(ancestor, scope) {
  for (let current = scope; current !== null; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function sameSimpleMacroToken(expected, actual) {
  return (
    expected?.value === actual?.value &&
    expected?.raw === actual?.raw &&
    expected?.literal === actual?.literal
  );
}

function balancedSimpleMacroCapture(tokens) {
  const delimiters = [];
  for (const token of tokens) {
    if (closingDelimiter.has(token.value)) {
      delimiters.push(closingDelimiter.get(token.value));
    } else if ([")", "]", "}"].includes(token.value)) {
      if (delimiters.at(-1) !== token.value) return false;
      delimiters.pop();
    }
  }
  return delimiters.length === 0;
}

function validSimpleMacroCapture(fragment, tokens) {
  if (tokens.length === 0) return fragment === "vis";
  if (!balancedSimpleMacroCapture(tokens)) return false;
  if (fragment === "ident") {
    return tokens.length === 1 && tokens[0].identifier;
  }
  if (fragment === "lifetime") {
    return tokens.length === 2 && tokens[0].value === "'" && tokens[1].identifier;
  }
  if (fragment === "literal") {
    return (
      (tokens.length === 1 && tokens[0].value === "LITERAL") ||
      (tokens.length === 2 && tokens[0].value === "-" && tokens[1].value === "LITERAL")
    );
  }
  if (fragment === "block") {
    return tokens[0].value === "{" && matchingDelimiter(tokens, 0) === tokens.length - 1;
  }
  if (fragment === "tt") {
    return (
      tokens.length === 1 ||
      (closingDelimiter.has(tokens[0].value) && matchingDelimiter(tokens, 0) === tokens.length - 1)
    );
  }
  return true;
}

function matchSimpleMacroArguments(arm, arguments_) {
  function match(partIndex, argumentIndex, replacements) {
    if (partIndex === arm.matcherParts.length) {
      return argumentIndex === arguments_.length ? replacements : null;
    }
    const part = arm.matcherParts[partIndex];
    if (part.kind === "literal") {
      if (!sameSimpleMacroToken(part.token, arguments_[argumentIndex])) {
        return null;
      }
      return match(partIndex + 1, argumentIndex + 1, replacements);
    }

    const firstEnd = part.fragment === "vis" ? argumentIndex : argumentIndex + 1;
    for (let end = firstEnd; end <= arguments_.length; end += 1) {
      const captured = arguments_.slice(argumentIndex, end);
      if (!validSimpleMacroCapture(part.fragment, captured)) continue;
      const next = new Map(replacements);
      next.set(part.name, captured);
      const result = match(partIndex + 1, end, next);
      if (result !== null) return result;
    }
    return null;
  }

  return match(0, 0, new Map());
}

function substituteSimpleMacroArm(arm, arguments_, invocation) {
  const replacements = matchSimpleMacroArguments(arm, arguments_);
  if (replacements === null) return null;
  const expanded = [];
  for (let index = 0; index < arm.expansion.length; index += 1) {
    const token = arm.expansion[index];
    if (
      token.value === "$" &&
      arm.expansion[index + 1]?.identifier &&
      replacements.has(arm.expansion[index + 1].value)
    ) {
      expanded.push(
        ...replacements.get(arm.expansion[index + 1].value).map((argument) => ({
          ...argument,
          file: invocation.file,
          line: invocation.line,
        })),
      );
      index += 1;
      continue;
    }
    if (token.value === "$") return null;
    expanded.push({
      ...token,
      file: invocation.file,
      line: invocation.line,
    });
  }
  return expanded;
}

function expandSimpleMacroInvocationsOnce(tokens) {
  const definitionTokens = macroDefinitionTokens(tokens);
  const { definitions, scopeAt } = simpleMacroRules(tokens, definitionTokens);
  if (definitions.size === 0) {
    return { expansionCount: 0, tokens };
  }

  const expanded = [];
  let expansionCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      !definitionTokens.has(index) &&
      token.identifier &&
      tokens[index + 1]?.value === "!" &&
      closingDelimiter.has(tokens[index + 2]?.value)
    ) {
      const closing = matchingDelimiter(tokens, index + 2);
      const definition = [...(definitions.get(token.value) ?? [])]
        .reverse()
        .find(
          (candidate) => candidate.index < index && scopeContains(candidate.scope, scopeAt[index]),
        );
      if (definition !== undefined) {
        const arguments_ = tokens.slice(index + 3, closing);
        const invocationExpansion = definition.arms
          .map((arm) => substituteSimpleMacroArm(arm, arguments_, token))
          .find((candidate) => candidate !== null);
        if (invocationExpansion !== undefined) {
          expanded.push(...invocationExpansion);
          expansionCount += 1;
          index = closing;
          continue;
        }
      }
    }
    expanded.push(token);
  }
  return { expansionCount, tokens: expanded };
}

function simpleMacroExpansionFingerprint(tokens) {
  return JSON.stringify(
    tokens.map((token) => [token.value, token.literal ?? null, token.raw ?? null]),
  );
}

function expandSimpleMacroInvocations(tokens) {
  const seen = new Set();
  const maximumPasses = 64;
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    const fingerprint = simpleMacroExpansionFingerprint(tokens);
    if (seen.has(fingerprint)) {
      throw new Error("cyclic simple local macro expansion");
    }
    seen.add(fingerprint);

    const expanded = expandSimpleMacroInvocationsOnce(tokens);
    if (expanded.expansionCount === 0) return tokens;
    tokens = expanded.tokens;
  }
  throw new Error(`simple local macro expansion exceeds ${maximumPasses} passes`);
}

function normalizedTokenStream(tokens, crateAliases = new Map()) {
  tokens = expandSimpleMacroInvocations(tokens);
  const ignoredTokens = macroDefinitionTokens(tokens);
  const invocationTokens = macroInvocationTokens(tokens, ignoredTokens);
  const attributes = attributeTokens(tokens);
  const { statements, groupBraces } = importStatements(
    tokens,
    ignoredTokens,
    invocationTokens,
    attributes,
  );
  const { moduleScopes, root, scopeAt } = lexicalScopes(tokens, groupBraces);
  collectLocalItems(tokens, scopeAt, moduleScopes);
  collectGenericParameters(tokens, scopeAt);
  collectImplSelfBindings(tokens, scopeAt);
  for (const scope of [root, ...moduleScopes.values()]) {
    for (const [alias, canonical] of crateAliases) {
      declareBinding(scope, alias, {
        absolute: true,
        implicit: true,
        namespaces: new Set(["type"]),
        path: [canonical],
      });
    }
  }
  const importPathPrefixes = collectBindings(tokens, statements, scopeAt);
  const importStatementTokens = new Set();
  for (const statement of statements) {
    for (let tokenIndex = statement.tokenIndex; tokenIndex <= statement.end; tokenIndex += 1) {
      importStatementTokens.add(tokenIndex);
    }
  }
  const values = tokens.map((token) => token.value);

  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].identifier) continue;
    const previousIsSeparator = tokens[index - 1]?.value === "::";
    if (
      tokens[index].value === "Sqlx" &&
      !previousIsSeparator &&
      hasStorageErrorGlob(scopeAt[index], "Sqlx")
    ) {
      values[index] = isRustPattern(tokens, index)
        ? "MATCHED_STORAGE_VARIANT"
        : "StorageError :: Sqlx";
      continue;
    }
    const previousIsSegment = previousIsSeparator && tokens[index - 2]?.identifier;
    if (previousIsSegment) continue;

    const segmentIndices = [index];
    let cursor = index;
    while (tokens[cursor + 1]?.value === "::" && tokens[cursor + 2]?.identifier) {
      segmentIndices.push(cursor + 2);
      cursor += 2;
    }
    const segments = segmentIndices.map((tokenIndex) => tokens[tokenIndex].value);
    const leadingAbsolute = tokens[index - 1]?.value === "::" && !tokens[index - 2]?.identifier;
    const importContext = importPathPrefixes.get(index);
    const sourcePath =
      importContext === undefined ? segments : [...importContext.prefix, ...segments];
    const absolute = leadingAbsolute || importContext?.absolute === true;
    const binding = absolute
      ? null
      : (findBinding(scopeAt[index], sourcePath[0]) ??
        findGlobbedBinding(scopeAt[index], sourcePath[0]));
    const importedPath = binding === null ? null : resolveBinding(binding);
    const expanded =
      importedPath === null
        ? sourcePath
        : resolveBoundPath(binding, sourcePath.slice(1), new Set());

    if (importStatementTokens.has(index) && isStorageErrorVariantPath(expanded, "Sqlx")) {
      for (const tokenIndex of segmentIndices) {
        values[tokenIndex] = "IMPORTED_STORAGE_VARIANT";
      }
    } else if (expanded[0] === "sqlx") {
      values[index] = "sqlx";
    } else if (
      expanded[0] === "StorageError" ||
      (expanded[0] === "symphony_storage" && expanded[1] === "StorageError")
    ) {
      const qualifiedClosing =
        qualifiedVariantClosing(tokens, index, cursor, leadingAbsolute, "Sqlx") ??
        turbofishVariantClosing(tokens, cursor, "Sqlx");
      if (
        (isStorageErrorVariantPath(expanded, "Sqlx") || qualifiedClosing !== null) &&
        isRustPattern(tokens, qualifiedClosing === null ? cursor : qualifiedClosing + 2)
      ) {
        for (const tokenIndex of segmentIndices) {
          values[tokenIndex] = "MATCHED_STORAGE_VARIANT";
        }
        index = cursor;
        continue;
      }
      if (importedPath !== null && isStorageErrorPath(importedPath)) {
        values[index] = "StorageError";
      }
      if (
        importedPath !== null &&
        !importStatementTokens.has(index) &&
        isStorageErrorVariantPath(importedPath, "Sqlx")
      ) {
        values[index] = "StorageError :: Sqlx";
      }
      if (qualifiedClosing !== null) {
        values[index] = "StorageError";
        for (let tokenIndex = index + 1; tokenIndex <= qualifiedClosing; tokenIndex += 1) {
          values[tokenIndex] = "";
        }
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
    locations.push({
      start,
      end: source.length,
      file: token.file,
      line: token.line,
    });
  }

  return { source, locations };
}

function locationForMatch(locations, index) {
  let low = 0;
  let high = locations.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (locations[middle].end <= index) {
      low = middle + 1;
    } else if (locations[middle].start > index) {
      high = middle - 1;
    } else {
      return locations[middle];
    }
  }
  return (
    locations[Math.min(low, locations.length - 1)] ?? {
      file: undefined,
      line: 1,
    }
  );
}

export async function scanRestrictedSources(metadata, policy, options = {}) {
  validatePolicy(policy);
  const packages = workspacePackages(metadata);
  const errors = new Set();

  for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
    const cfgContext = packageCfgContext(metadata, pkg, options.activeCfg);
    const rules = policy.sourceRules
      .filter((rule) => !rule.allowedPackages.includes(pkg.name))
      .map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, "g") }));
    if (rules.length === 0) continue;

    const expandedTokenCache = new Map();
    const crateAliases = restrictedCrateAliases(pkg);
    async function scanExpandedSource(file, moduleDirectory, expandModules) {
      const relative = path.relative(metadata.workspace_root, file);
      let tokenStream;
      try {
        tokenStream = normalizedTokenStream(
          await expandedRustTokens(
            file,
            moduleDirectory,
            expandModules,
            cfgContext,
            expandedTokenCache,
          ),
          crateAliases,
        );
      } catch (error) {
        throw new Error(`cannot lex ${relative}: ${error.message}`);
      }
      for (const rule of rules) {
        rule.regex.lastIndex = 0;
        let match = rule.regex.exec(tokenStream.source);
        while (match !== null) {
          const location = locationForMatch(tokenStream.locations, match.index);
          errors.add(
            diagnostic(
              path.relative(metadata.workspace_root, location.file ?? file),
              location.line,
              `[${rule.id}] ${rule.message} (package ${pkg.name})`,
            ),
          );
          if (match[0].length === 0) rule.regex.lastIndex += 1;
          match = rule.regex.exec(tokenStream.source);
        }
      }
    }

    for (const file of await packageRustFiles(pkg, cfgContext)) {
      await scanExpandedSource(file, path.dirname(file), false);
    }
    const manifestDirectory = path.dirname(pkg.manifest_path);
    const targets = [...(pkg.targets ?? [])].sort((a, b) =>
      String(a.src_path).localeCompare(String(b.src_path)),
    );
    for (const target of targets) {
      const entryFile = path.resolve(manifestDirectory, target.src_path);
      await scanExpandedSource(entryFile, path.dirname(entryFile), true);
    }
  }

  return [...errors].sort();
}

export async function verifyBoundaries(metadata, policy, options = {}) {
  return [
    ...verifyCargoMetadata(metadata, policy),
    ...(await scanRestrictedSources(metadata, policy, options)),
  ].sort();
}
