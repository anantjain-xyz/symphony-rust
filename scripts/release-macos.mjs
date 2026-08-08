#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const RELEASE_REPOSITORY = "anantjain-xyz/symphony-rust";
export const PRODUCT_NAME = "Symphony";
export const UPDATER_TARGET = "darwin-aarch64";
export const VERSIONED_DMG_TEMPLATE = "Symphony_<version>_aarch64.dmg";
export const STABLE_DMG = "Symphony.dmg";
export const UPDATER_BUNDLE = "Symphony.app.tar.gz";
export const UPDATER_SIGNATURE = "Symphony.app.tar.gz.sig";
export const UPDATER_FEED = "latest.json";
export const REQUIRED_APPLE_ENV = [
  "APPLE_SIGNING_IDENTITY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const versionedDmgName = (version) =>
  VERSIONED_DMG_TEMPLATE.replaceAll("<version>", version);
export function releaseArtifactPaths(root, { version } = {}) {
  const macosDir = join(root, "target/release/bundle/macos");
  const dmgDir = join(root, "target/release/bundle/dmg");
  const updaterBundle = join(macosDir, UPDATER_BUNDLE);
  const paths = {
    app: join(macosDir, `${PRODUCT_NAME}.app`),
    updaterBundle,
    updaterSignature: `${updaterBundle}.sig`,
    dmgDir,
    stableDmgName: STABLE_DMG,
  };
  if (version != null) {
    paths.versionedDmgName = versionedDmgName(version);
    paths.versionedDmgPath = join(dmgDir, paths.versionedDmgName);
  }
  return paths;
}
export const requiredReleaseAssets = (version) => [
  versionedDmgName(version),
  STABLE_DMG,
  UPDATER_BUNDLE,
  UPDATER_SIGNATURE,
  UPDATER_FEED,
];
export const updaterDownloadUrl = (repository, tag) =>
  `https://github.com/${repository}/releases/download/${tag}/${UPDATER_BUNDLE}`;
export const buildLatestJson = ({ version, url, signature }) => ({
  version,
  platforms: { [UPDATER_TARGET]: { url, signature } },
});
export const formatLatestJson = (feed) => `${JSON.stringify(feed, null, 2)}\n`;
export function assertLatestJson(feed) {
  const platform = feed?.platforms?.[UPDATER_TARGET];
  if (!feed?.version || !platform?.url || !platform?.signature) {
    throw new Error("error: latest.json is missing version, url, or signature");
  }
}
export function parseEnvFile(contents) {
  const env = {};
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[line.slice(0, i).trim()] = value;
  }
  return env;
}
export const credentialsEnvPath = (processEnv = process.env, home = homedir()) =>
  processEnv.SYMPHONY_RELEASE_ENV || join(home, ".symphony-release.env");
export function resolveCredentialsEnvironment({
  fileContents,
  processEnv = {},
  home = homedir(),
  fileExists = existsSync,
}) {
  const merged = { ...processEnv, ...parseEnvFile(fileContents) };
  if (!merged.TAURI_SIGNING_PRIVATE_KEY) {
    const keyPath = merged.TAURI_SIGNING_PRIVATE_KEY_PATH || join(home, ".tauri", "symphony.key");
    if (!fileExists(keyPath)) throw new Error(`error: updater signing key not found: ${keyPath}`);
    merged.TAURI_SIGNING_PRIVATE_KEY = keyPath;
    merged.TAURI_SIGNING_PRIVATE_KEY_PATH = keyPath;
  }
  return merged;
}
export function validateCredentialsEnvironment(env, { fileExists = existsSync } = {}) {
  for (const name of REQUIRED_APPLE_ENV) {
    const value = env[name] ?? "";
    if (!value || value.includes("<")) throw new Error(`error: ${name} is not filled in`);
  }
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error("error: configure TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH");
  }
  if (!fileExists(env.APPLE_API_KEY_PATH)) {
    throw new Error(`error: API key file not found: ${env.APPLE_API_KEY_PATH}`);
  }
}
export function assertSigningIdentityPresent(securityOutput, identity) {
  if (!securityOutput.includes(identity)) {
    throw new Error(`error: signing identity not in keychain: ${identity}`);
  }
}
export function assertNonEmptyArtifacts(entries, { missingMessage } = {}) {
  for (const entry of entries) {
    if (!entry.exists || !entry.isFile || entry.size <= 0) {
      throw new Error(
        missingMessage ?? "error: Tauri did not produce the signed macOS updater artifacts",
      );
    }
  }
}
export function artifactEntries(paths, { exists = existsSync, stat = statSync } = {}) {
  return paths.map((path) => {
    if (!exists(path)) return { path, exists: false, isFile: false, size: 0 };
    const info = stat(path);
    return { path, exists: true, isFile: info.isFile(), size: info.size };
  });
}
export function createDefaultRunner() {
  return ({ command, args = [], cwd, env, capture = false } = {}) => {
    const result = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    return {
      status: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ?? null,
    };
  };
}
export function requireOk(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(detail || `error: ${label} failed with status ${result.status}`);
  }
  return result;
}
const run = (runner, command, args, opts) =>
  requireOk(runner({ command, args, ...opts }), opts.label ?? command);
export function assertAppleSiliconHost({ os, arch }) {
  if (os !== "Darwin" || arch !== "arm64") {
    throw new Error(
      `error: updater releases must be built on Apple Silicon macOS (found ${os}/${arch})`,
    );
  }
}
export function assertMainBranch(branch) {
  if (branch !== "main")
    throw new Error(`error: releases are cut from main (currently on ${branch})`);
}
export function assertCleanWorkingTree(porcelain) {
  if (porcelain.trim() !== "") throw new Error("error: working tree is not clean");
}
export function assertHeadMatchesOriginMain(head, originMain) {
  if (head !== originMain)
    throw new Error("error: HEAD does not match origin/main — push or pull first");
}
export function assertTagMatchesHead({ tag, tagCommit, head }) {
  if (tagCommit != null && tagCommit !== head) {
    throw new Error(
      `error: tag ${tag} already exists and does not point at HEAD — bump the version or delete the tag`,
    );
  }
}
export function assertReleaseAbsent({ tag, exists }) {
  if (exists) {
    throw new Error(
      `error: release ${tag} already exists — bump the version in src-tauri/tauri.conf.json`,
    );
  }
}
export function assertRepositoryMatches(repoSlug) {
  if (repoSlug !== RELEASE_REPOSITORY) {
    throw new Error(
      `error: current repository ${repoSlug} does not match release contract ${RELEASE_REPOSITORY}`,
    );
  }
}
export function selectVersionedDmg({ candidates, version }) {
  const expected = versionedDmgName(version);
  if (candidates.length !== 1) {
    throw new Error(
      `error: expected exactly one Symphony_${version}_*.dmg in target/release/bundle/dmg, found ${candidates.length}`,
    );
  }
  if (basename(candidates[0]) !== expected) {
    throw new Error(
      `error: updater feed targets darwin-aarch64, but the built DMG is ${basename(candidates[0])}`,
    );
  }
  return candidates[0];
}
export function releaseFeedPlan({ version, repository, tag, signature }) {
  const url = updaterDownloadUrl(repository, tag);
  const feed = buildLatestJson({ version, url, signature });
  assertLatestJson(feed);
  return { url, feed, feedText: formatLatestJson(feed), assets: requiredReleaseAssets(version) };
}
export function runReleaseMacos({
  root = ROOT,
  runner = createDefaultRunner(),
  processEnv = process.env,
  home = homedir(),
  fileExists = existsSync,
  readFile = readFileSync,
  fileStat = statSync,
  log = console.log,
} = {}) {
  const envPath = credentialsEnvPath(processEnv, home);
  if (!fileExists(envPath)) {
    throw new Error(`error: credentials file not found: ${envPath} (see header of this script)`);
  }
  const env = resolveCredentialsEnvironment({
    fileContents: readFile(envPath, "utf8"),
    processEnv,
    home,
    fileExists,
  });
  validateCredentialsEnvironment(env, { fileExists });
  assertSigningIdentityPresent(
    run(runner, "security", ["find-identity", "-v", "-p", "codesigning"], {
      cwd: root,
      env,
      capture: true,
    }).stdout,
    env.APPLE_SIGNING_IDENTITY,
  );
  run(runner, "pnpm", ["tauri", "build", "--config", "src-tauri/tauri.updater.conf.json"], {
    cwd: root,
    env,
  });
  const artifacts = releaseArtifactPaths(root);
  log("\n── verifying signature and notarization ──");
  run(runner, "spctl", ["-a", "-vv", "-t", "exec", artifacts.app], { cwd: root, env });
  run(runner, "xcrun", ["stapler", "validate", artifacts.app], { cwd: root, env });
  assertNonEmptyArtifacts(
    artifactEntries([artifacts.updaterBundle, artifacts.updaterSignature], {
      exists: fileExists,
      stat: fileStat,
    }),
  );
  run(
    runner,
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      join(root, "src-tauri/Cargo.toml"),
      "--example",
      "verify-updater-signature",
      "--",
      artifacts.updaterBundle,
      artifacts.updaterSignature,
      join(root, "src-tauri/tauri.conf.json"),
    ],
    { cwd: root, env, label: "verify-updater-signature" },
  );
  return artifacts;
}
function gitText(runner, root, env, args) {
  return requireOk(
    runner({ command: "git", args, cwd: root, env, capture: true }),
    `git ${args.join(" ")}`,
  ).stdout.trim();
}
function ghText(runner, root, env, args, label) {
  return requireOk(
    runner({ command: "gh", args, cwd: root, env, capture: true }),
    label,
  ).stdout.trim();
}
export function runPublishMacos({
  root = ROOT,
  runner = createDefaultRunner(),
  processEnv = process.env,
  host = {
    os: process.platform === "darwin" ? "Darwin" : process.platform,
    arch: process.arch,
  },
  io = {
    readFileSync,
    writeFileSync,
    copyFileSync,
    mkdtempSync,
    rmSync,
    readdirSync,
    existsSync,
    statSync,
  },
  runRelease = runReleaseMacos,
  log = console.log,
} = {}) {
  const env = { ...processEnv };
  assertAppleSiliconHost(host);
  const version = JSON.parse(
    io.readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  ).version;
  const tag = `v${version}`;
  assertMainBranch(gitText(runner, root, env, ["rev-parse", "--abbrev-ref", "HEAD"]));
  assertCleanWorkingTree(gitText(runner, root, env, ["status", "--porcelain"]));
  requireOk(
    runner({ command: "git", args: ["fetch", "origin", "main", "--tags"], cwd: root, env }),
    "git fetch origin main --tags",
  );
  const head = gitText(runner, root, env, ["rev-parse", "HEAD"]);
  assertHeadMatchesOriginMain(head, gitText(runner, root, env, ["rev-parse", "origin/main"]));
  const tagProbe = runner({
    command: "git",
    args: ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`],
    cwd: root,
    env,
    capture: true,
  });
  assertTagMatchesHead({
    tag,
    tagCommit: tagProbe.status === 0 ? tagProbe.stdout.trim() : null,
    head,
  });
  assertReleaseAbsent({
    tag,
    exists:
      runner({ command: "gh", args: ["release", "view", tag], cwd: root, env, capture: true })
        .status === 0,
  });
  runRelease({
    root,
    runner,
    processEnv: env,
    fileExists: io.existsSync,
    readFile: io.readFileSync,
    fileStat: io.statSync,
    log,
  });
  const artifacts = releaseArtifactPaths(root, { version });
  const dmg = selectVersionedDmg({
    candidates: io
      .readdirSync(artifacts.dmgDir)
      .filter((name) => name.startsWith(`Symphony_${version}_`) && name.endsWith(".dmg"))
      .map((name) => join(artifacts.dmgDir, name)),
    version,
  });
  assertNonEmptyArtifacts(
    artifactEntries([artifacts.updaterBundle, artifacts.updaterSignature], {
      exists: io.existsSync,
      stat: io.statSync,
    }),
    { missingMessage: "error: signed updater artifacts are missing" },
  );
  const stage = io.mkdtempSync(join(tmpdir(), "symphony-release-"));
  try {
    const stableDmgPath = join(stage, STABLE_DMG);
    io.copyFileSync(dmg, stableDmgPath);
    const repoUrl = ghText(
      runner,
      root,
      env,
      ["repo", "view", "--json", "url", "-q", ".url"],
      "gh url",
    );
    const repoSlug = ghText(
      runner,
      root,
      env,
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      "gh slug",
    );
    assertRepositoryMatches(repoSlug);
    const plan = releaseFeedPlan({
      version,
      repository: repoSlug,
      tag,
      signature: io.readFileSync(artifacts.updaterSignature, "utf8"),
    });
    const feedPath = join(stage, UPDATER_FEED);
    io.writeFileSync(feedPath, plan.feedText);
    log(`\n── creating draft GitHub release ${tag} ──`);
    requireOk(
      runner({
        command: "gh",
        args: [
          "release",
          "create",
          tag,
          "--target",
          head,
          "--title",
          `Symphony ${tag}`,
          "--generate-notes",
          "--draft",
          dmg,
          stableDmgPath,
          artifacts.updaterBundle,
          artifacts.updaterSignature,
          feedPath,
        ],
        cwd: root,
        env,
      }),
      "gh release create",
    );
    const uploaded = ghText(
      runner,
      root,
      env,
      ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"],
      "gh assets",
    )
      .split(/\r?\n/u)
      .filter(Boolean);
    for (const asset of plan.assets) {
      if (!uploaded.includes(asset)) {
        throw new Error(`error: draft release is missing ${asset}; leaving ${tag} as a draft`);
      }
    }
    log(`\n── publishing verified release ${tag} ──`);
    requireOk(
      runner({ command: "gh", args: ["release", "edit", tag, "--draft=false"], cwd: root, env }),
      "gh release edit",
    );
    log(`\nPublished: ${repoUrl}/releases/tag/${tag}`);
    log(`Stable download: ${repoUrl}/releases/latest/download/${STABLE_DMG}`);
    log(`Updater feed: ${repoUrl}/releases/latest/download/${UPDATER_FEED}`);
    return { tag, head, assets: plan.assets, feed: plan.feed };
  } finally {
    io.rmSync(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runReleaseMacos();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
