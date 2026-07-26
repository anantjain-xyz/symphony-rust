import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = path.join(projectRoot, "scripts", "hygiene-tools.json");

export async function loadToolPolicy() {
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
  for (const name of ["actionlint", "shellcheck"]) {
    const tool = policy[name];
    if (!tool || !/^\d+\.\d+\.\d+$/.test(tool.version)) {
      throw new Error(`${policyPath}: ${name} must declare an exact semantic version`);
    }
    for (const [platform, asset] of Object.entries(tool.assets ?? {})) {
      assertSafeArchiveAsset(asset);
      if (!/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")) {
        throw new Error(`${policyPath}: ${name}/${platform} must declare a SHA-256 checksum`);
      }
      if (!asset.archive?.includes(tool.version) || !asset.binaryPath) {
        throw new Error(`${policyPath}: ${name}/${platform} is not pinned to ${tool.version}`);
      }
    }
  }
  return policy;
}

export function platformKey(platform = process.platform, architecture = process.arch) {
  if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(architecture)) {
    throw new Error(
      `unsupported hygiene tool platform ${platform}/${architecture}; supported: macOS or Linux on arm64/x64`,
    );
  }
  return `${platform}-${architecture}`;
}

export function releaseUrl(tool, asset) {
  return `https://github.com/${tool.repository}/releases/download/v${tool.version}/${asset.archive}`;
}

function extractionMode(archive) {
  if (archive.endsWith(".tar.gz")) return "-xzOf";
  if (archive.endsWith(".tar.xz")) return "-xJOf";
  throw new Error(`unsupported hygiene tool archive format: ${archive}`);
}

function assertSafeArchiveAsset(asset) {
  if (
    typeof asset.archive !== "string" ||
    path.posix.basename(asset.archive) !== asset.archive ||
    asset.archive.includes("\\") ||
    asset.archive.includes("\0")
  ) {
    throw new Error("hygiene tool archive must be a safe filename");
  }
  if (
    typeof asset.binaryPath !== "string" ||
    !asset.binaryPath ||
    path.posix.isAbsolute(asset.binaryPath) ||
    path.posix.normalize(asset.binaryPath) !== asset.binaryPath ||
    asset.binaryPath === ".." ||
    asset.binaryPath.startsWith("../") ||
    asset.binaryPath.startsWith("-") ||
    asset.binaryPath.includes("\\") ||
    asset.binaryPath.includes("\0")
  ) {
    throw new Error("hygiene tool binary must use a safe relative path");
  }
  extractionMode(asset.archive);
}

export function extractArchiveBinary(archivePath, asset) {
  assertSafeArchiveAsset(asset);
  // Stream only the checksum-pinned member to stdout. Archive-controlled paths
  // are never materialized, so traversal and link entries cannot write outside
  // the installer staging directory.
  const extracted = spawnSync(
    "tar",
    [extractionMode(asset.archive), archivePath, "--", asset.binaryPath],
    {
      cwd: projectRoot,
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  if (extracted.error || extracted.status !== 0) {
    const detail =
      extracted.error?.message ??
      extracted.stderr?.toString("utf8").trim() ??
      `exit ${extracted.status}`;
    throw new Error(`could not extract ${asset.archive}: ${detail}`);
  }
  return extracted.stdout;
}

function cacheDirectory(name, tool, key) {
  return path.join(projectRoot, ".cache", "hygiene-tools", `${name}-${tool.version}-${key}`);
}

function versionMatches(name, expected, output) {
  if (name === "actionlint") return output.split(/\r?\n/, 1)[0].trim() === expected;
  return new RegExp(`^version:\\s*${expected.replaceAll(".", "\\.")}\\s*$`, "m").test(output);
}

function verifyExecutable(name, executable, tool) {
  const version = spawnSync(executable, [tool.versionFlag], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (version.error || version.status !== 0) return false;
  return versionMatches(name, tool.version, `${version.stdout}\n${version.stderr}`);
}

async function validCachedTool(name, tool, key) {
  const directory = cacheDirectory(name, tool, key);
  const executable = path.join(directory, name);
  const markerPath = path.join(directory, ".installed.json");
  try {
    const [stat, marker] = await Promise.all([
      fs.lstat(executable),
      fs.readFile(markerPath, "utf8").then(JSON.parse),
    ]);
    const asset = tool.assets[key];
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      marker.version !== tool.version ||
      marker.archive !== asset.archive ||
      marker.sha256 !== asset.sha256
    ) {
      return null;
    }
    return verifyExecutable(name, executable, tool) ? executable : null;
  } catch {
    return null;
  }
}

async function findOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      const resolved = await fs.realpath(candidate);
      const stat = await fs.stat(resolved);
      if (stat.isFile()) return resolved;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

export async function resolveTool(name) {
  const policy = await loadToolPolicy();
  const tool = policy[name];
  if (!tool) throw new Error(`unknown hygiene tool ${name}`);
  const key = platformKey();
  if (!tool.assets[key]) {
    throw new Error(`${name} ${tool.version} has no pinned asset for ${key}`);
  }
  const cached = await validCachedTool(name, tool, key);
  if (cached) return cached;

  const system = await findOnPath(name);
  if (system && verifyExecutable(name, system, tool)) return system;

  const found = system ? `Found an incompatible ${name} on PATH.` : `${name} was not found.`;
  throw new Error(
    `${found} Expected ${name} ${tool.version} for ${key}. Run "pnpm install:hygiene-tools" with network access; downloads are pinned and checksum-verified.`,
  );
}

export function download(url, { get = https.get, redirects = 0, timeoutMs = 30_000 } = {}) {
  if (redirects > 5) return Promise.reject(new Error(`too many redirects downloading ${url}`));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("download timeout must be a positive number"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => finish(reject, error);
    const succeed = (value) => finish(resolve, value);
    const request = get(
      url,
      { headers: { "user-agent": "symphony-hygiene-installer" } },
      (response) => {
        response.on("error", (error) => {
          fail(new Error(`download stream failed for ${url}: ${error.message}`, { cause: error }));
        });
        response.once("aborted", () => {
          fail(new Error(`download stream was aborted for ${url}`));
        });
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          succeed(
            download(new URL(response.headers.location, url).toString(), {
              get,
              redirects: redirects + 1,
              timeoutMs,
            }),
          );
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          fail(new Error(`download failed with HTTP ${response.statusCode}: ${url}`));
          return;
        }
        const chunks = [];
        let ended = false;
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () => {
          ended = true;
          succeed(Buffer.concat(chunks));
        });
        response.once("close", () => {
          if (!ended && response.complete === false) {
            fail(new Error(`download stream closed before completion for ${url}`));
          }
        });
      },
    );
    request.on("error", fail);
    timer = setTimeout(() => {
      const error = new Error(`download timed out after ${timeoutMs}ms: ${url}`);
      request.destroy(error);
      fail(error);
    }, timeoutMs);
    if (settled) clearTimeout(timer);
  });
}

export async function installTool(name) {
  const policy = await loadToolPolicy();
  const tool = policy[name];
  if (!tool) throw new Error(`unknown hygiene tool ${name}`);
  const key = platformKey();
  const asset = tool.assets[key];
  if (!asset) throw new Error(`${name} ${tool.version} has no pinned asset for ${key}`);

  const cached = await validCachedTool(name, tool, key);
  if (cached) {
    console.log(`${name} ${tool.version} already installed at ${cached}`);
    return cached;
  }

  const base = path.join(projectRoot, ".cache", "hygiene-tools");
  await fs.mkdir(base, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(base, ".install-"));
  try {
    const url = releaseUrl(tool, asset);
    console.log(`Downloading ${name} ${tool.version} from ${url}`);
    const archive = await download(url);
    const actual = crypto.createHash("sha256").update(archive).digest("hex");
    if (actual !== asset.sha256) {
      throw new Error(
        `${name} checksum mismatch for ${asset.archive}: expected ${asset.sha256}, got ${actual}`,
      );
    }

    const archivePath = path.join(temporary, asset.archive);
    const staged = path.join(temporary, "staged");
    await Promise.all([fs.writeFile(archivePath, archive), fs.mkdir(staged)]);

    const executable = path.join(staged, name);
    await fs.writeFile(executable, extractArchiveBinary(archivePath, asset));
    await fs.chmod(executable, 0o755);
    await fs.writeFile(
      path.join(staged, ".installed.json"),
      `${JSON.stringify(
        { version: tool.version, archive: asset.archive, sha256: asset.sha256 },
        null,
        2,
      )}\n`,
    );
    if (!verifyExecutable(name, executable, tool)) {
      throw new Error(`${name} archive did not contain the expected ${tool.version} binary`);
    }

    const destination = cacheDirectory(name, tool, key);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staged, destination);
    const installed = path.join(destination, name);
    console.log(`Installed ${name} ${tool.version} at ${installed}`);
    return installed;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
