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

async function packageRustFiles(pkg) {
  const manifestDir = path.dirname(pkg.manifest_path);
  const roots = ["src", "tests", "examples", "benches"].map((name) =>
    path.join(manifestDir, name),
  );
  const files = [];
  for (const root of roots) files.push(...(await collectRustFiles(root)));
  const buildScript = path.join(manifestDir, "build.rs");
  try {
    const stat = await fs.lstat(buildScript);
    if (stat.isSymbolicLink()) {
      throw new Error(`boundary scan refuses symbolic link ${buildScript}`);
    }
    if (stat.isFile()) files.push(buildScript);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return files.sort();
}

export async function scanRestrictedSources(metadata, policy) {
  validatePolicy(policy);
  const packages = workspacePackages(metadata);
  const errors = [];

  for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
    const rules = policy.sourceRules
      .filter((rule) => !rule.allowedPackages.includes(pkg.name))
      .map((rule) => ({ ...rule, regex: new RegExp(rule.pattern) }));
    if (rules.length === 0) continue;

    for (const file of await packageRustFiles(pkg)) {
      let source;
      try {
        source = await fs.readFile(file, "utf8");
      } catch (error) {
        throw new Error(`cannot read ${file}: ${error.message}`);
      }
      const relative = path.relative(metadata.workspace_root, file);
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        for (const rule of rules) {
          if (rule.regex.test(line)) {
            errors.push(
              diagnostic(
                relative,
                index + 1,
                `[${rule.id}] ${rule.message} (package ${pkg.name})`,
              ),
            );
          }
        }
      }
    }
  }

  return errors.sort();
}

export async function verifyBoundaries(metadata, policy) {
  return [
    ...verifyCargoMetadata(metadata, policy),
    ...(await scanRestrictedSources(metadata, policy)),
  ].sort();
}
