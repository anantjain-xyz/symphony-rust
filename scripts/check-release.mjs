import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tomlSectionValue(source, section, key, path) {
  let current = "";
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const trimmed = line.replace(/#.*$/u, "").trim();
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(trimmed);
    if (sectionMatch) {
      current = sectionMatch[1];
      continue;
    }
    if (current !== section) continue;
    const valueMatch = new RegExp(`^${key}\\s*=\\s*"([^"]+)"$`, "u").exec(trimmed);
    if (valueMatch) return valueMatch[1];
    if (trimmed.startsWith(`${key} =`)) {
      throw new Error(`${path}:${index + 1}: ${section}.${key} must be a literal string`);
    }
  }
  throw new Error(`${path}: missing ${section}.${key}`);
}

export function cargoLockPackages(source) {
  const packages = [];
  let current = null;
  for (const line of source.split(/\r?\n/u)) {
    if (line.trim() === "[[package]]") {
      if (current?.name && current?.version) packages.push(current);
      current = {};
      continue;
    }
    if (!current) continue;
    const match = /^(name|version)\s*=\s*"([^"]+)"$/u.exec(line.trim());
    if (match) current[match[1]] = match[2];
  }
  if (current?.name && current?.version) packages.push(current);
  return packages;
}

function requireText(source, literal, path, diagnostics) {
  if (!source.includes(literal)) diagnostics.push(`${path}: missing ${JSON.stringify(literal)}`);
}

function shellCode(source) {
  return source
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

export function checkReleaseContract({
  rootCargo,
  desktopCargo,
  packageJson,
  tauriConfig,
  updaterConfig,
  cargoLock,
  cargoMetadata,
  releaseScript,
  publishScript,
  contract,
}) {
  const diagnostics = [];
  const rootVersion = tomlSectionValue(rootCargo, "workspace.package", "version", "Cargo.toml");
  const desktopVersion = tomlSectionValue(
    desktopCargo,
    "package",
    "version",
    "src-tauri/Cargo.toml",
  );
  const versions = new Map([
    ["Cargo.toml workspace.package", rootVersion],
    ["src-tauri/Cargo.toml package", desktopVersion],
    ["package.json", packageJson.version],
    ["src-tauri/tauri.conf.json", tauriConfig.version],
  ]);
  for (const [owner, version] of versions) {
    if (version !== rootVersion) {
      diagnostics.push(`${owner}: version ${JSON.stringify(version)} != ${rootVersion}`);
    }
  }

  const workspacePackages = cargoMetadata.packages.filter((entry) =>
    cargoMetadata.workspace_members.includes(entry.id),
  );
  const lockPackages = cargoLockPackages(cargoLock);
  for (const entry of workspacePackages) {
    if (entry.version !== rootVersion) {
      diagnostics.push(
        `${entry.manifest_path}: workspace package ${entry.name} is ${entry.version}, expected ${rootVersion}`,
      );
    }
    const locked = lockPackages.filter((candidate) => candidate.name === entry.name);
    if (locked.length !== 1) {
      diagnostics.push(
        `Cargo.lock: expected exactly one local ${entry.name} package, found ${locked.length}`,
      );
    } else if (locked[0].version !== rootVersion) {
      diagnostics.push(
        `Cargo.lock: ${entry.name} is ${locked[0].version}, expected ${rootVersion}`,
      );
    }
  }

  if (tauriConfig.productName !== contract.productName) {
    diagnostics.push(
      `src-tauri/tauri.conf.json: productName ${JSON.stringify(tauriConfig.productName)} != ${JSON.stringify(contract.productName)}`,
    );
  }
  const expectedEndpoint = `https://github.com/${contract.repository}/releases/latest/download/${contract.updaterFeed}`;
  const endpoints = tauriConfig.plugins?.updater?.endpoints;
  if (JSON.stringify(endpoints) !== JSON.stringify([expectedEndpoint])) {
    diagnostics.push(
      `src-tauri/tauri.conf.json: updater endpoints ${JSON.stringify(endpoints)} != ${JSON.stringify([expectedEndpoint])}`,
    );
  }
  if (updaterConfig.bundle?.createUpdaterArtifacts !== true) {
    diagnostics.push(
      "src-tauri/tauri.updater.conf.json: bundle.createUpdaterArtifacts must be true",
    );
  }

  const releaseCode = shellCode(releaseScript);
  const publishCode = shellCode(publishScript);
  const versionedDmg = contract.versionedDmg.replace("<version>", "${VERSION}");
  for (const literal of [
    `target/release/bundle/macos/${contract.productName}.app`,
    `target/release/bundle/macos/${contract.updaterBundle}`,
    'src-tauri/tauri.updater.conf.json',
  ]) {
    requireText(releaseCode, literal, "scripts/release-macos.sh", diagnostics);
  }
  for (const literal of [
    `VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"`,
    versionedDmg,
    `target/release/bundle/macos/${contract.updaterBundle}`,
    contract.stableDmg,
    contract.updaterSignature,
    contract.updaterFeed,
    `"${contract.updaterTarget}"`,
    `releases/download/$TAG/${contract.updaterBundle}`,
  ]) {
    requireText(publishCode, literal, "scripts/publish-macos.sh", diagnostics);
  }
  return diagnostics;
}

function cargoMetadata(root) {
  const result = spawnSync(
    "cargo",
    ["metadata", "--locked", "--no-deps", "--format-version", "1"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      ["cargo metadata failed", result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return JSON.parse(result.stdout);
}

export function checkRelease(root = ROOT) {
  const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const diagnostics = checkReleaseContract({
    rootCargo: readFileSync(join(root, "Cargo.toml"), "utf8"),
    desktopCargo: readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"),
    packageJson: json("package.json"),
    tauriConfig: json("src-tauri/tauri.conf.json"),
    updaterConfig: json("src-tauri/tauri.updater.conf.json"),
    cargoLock: readFileSync(join(root, "Cargo.lock"), "utf8"),
    cargoMetadata: cargoMetadata(root),
    releaseScript: readFileSync(join(root, "scripts/release-macos.sh"), "utf8"),
    publishScript: readFileSync(join(root, "scripts/publish-macos.sh"), "utf8"),
    contract: json("scripts/contracts/release.json"),
  });
  if (diagnostics.length > 0) throw new Error(diagnostics.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkRelease();
    console.log("release contract is consistent");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
