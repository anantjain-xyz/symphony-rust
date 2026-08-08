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
