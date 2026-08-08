import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as r from "./release-macos.mjs";

const ID = "Developer ID Application: Jane Doe (TEAMID1234)";
const p = r;

function writeCreds(home) {
  mkdirSync(join(home, ".tauri"), { recursive: true });
  writeFileSync(join(home, ".tauri/symphony.key"), "k");
  writeFileSync(join(home, "AuthKey.p8"), "a");
  writeFileSync(
    join(home, ".symphony-release.env"),
    `APPLE_SIGNING_IDENTITY="${ID}"\nAPPLE_API_ISSUER=i\nAPPLE_API_KEY=k\nAPPLE_API_KEY_PATH=${join(home, "AuthKey.p8")}\n`,
  );
}

function runner(handlers) {
  const calls = [];
  const run = (spec) => {
    calls.push(spec);
    const key = [spec.command, ...(spec.args ?? [])].join(" ");
    const hit =
      handlers.find(([x]) => x === key) ||
      handlers
        .filter(([x]) => key.startsWith(`${x} `))
        .sort((a, b) => b[0].length - a[0].length)[0];
    return hit ? hit[1] : { status: 0, stdout: "", stderr: "", error: null };
  };
  return { calls, run };
}

test("constants, artifacts, feed, credentials", () => {
  assert.equal(r.RELEASE_REPOSITORY, "anantjain-xyz/symphony-rust");
  assert.equal(r.PRODUCT_NAME, "Symphony");
  assert.equal(r.UPDATER_TARGET, "darwin-aarch64");
  assert.equal(r.VERSIONED_DMG_TEMPLATE, "Symphony_<version>_aarch64.dmg");
  assert.equal(r.STABLE_DMG, "Symphony.dmg");
  assert.equal(r.UPDATER_BUNDLE, "Symphony.app.tar.gz");
  assert.equal(r.UPDATER_SIGNATURE, "Symphony.app.tar.gz.sig");
  assert.equal(r.UPDATER_FEED, "latest.json");
  const tauri = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
  const updater = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.updater.conf.json", import.meta.url)),
  );
  assert.equal(tauri.productName, r.PRODUCT_NAME);
  assert.equal(tauri.build.beforeBuildCommand, "pnpm typecheck && pnpm build");
  assert.deepEqual(tauri.plugins.updater.endpoints, [
    `https://github.com/${r.RELEASE_REPOSITORY}/releases/latest/download/${r.UPDATER_FEED}`,
  ]);
  assert.equal(updater.bundle.createUpdaterArtifacts, true);
  assert.equal(r.versionedDmgName("1.2.3"), "Symphony_1.2.3_aarch64.dmg");
  assert.deepEqual(r.requiredReleaseAssets("1.2.3"), [
    "Symphony_1.2.3_aarch64.dmg",
    "Symphony.dmg",
    "Symphony.app.tar.gz",
    "Symphony.app.tar.gz.sig",
    "latest.json",
  ]);
  assert.equal(
    r.releaseArtifactPaths("/r", { version: "1.2.3" }).versionedDmgPath,
    "/r/target/release/bundle/dmg/Symphony_1.2.3_aarch64.dmg",
  );
  const url = r.updaterDownloadUrl("acme/s", "v1.2.3");
  const feed = r.buildLatestJson({ version: "1.2.3", url, signature: "sig" });
  assert.deepEqual(feed.platforms["darwin-aarch64"], { url, signature: "sig" });
  assert.equal(r.formatLatestJson(feed), `${JSON.stringify(feed, null, 2)}\n`);
  assert.throws(() => r.assertLatestJson({ version: "1.2.3", platforms: {} }), /missing/);
  assert.deepEqual(
    p.releaseFeedPlan({ version: "1.2.3", repository: "acme/s", tag: "v1.2.3", signature: "sig" })
      .assets,
    r.requiredReleaseAssets("1.2.3"),
  );
  assert.equal(r.credentialsEnvPath({}, "/h"), "/h/.symphony-release.env");
  assert.equal(r.parseEnvFile('K="V"').K, "V");
  assert.throws(
    () =>
      r.resolveCredentialsEnvironment({
        fileContents: "",
        processEnv: {},
        home: "/h",
        fileExists: () => false,
      }),
    /updater signing key/,
  );
  const env = r.resolveCredentialsEnvironment({
    fileContents: `APPLE_SIGNING_IDENTITY=${ID}\nAPPLE_API_ISSUER=i\nAPPLE_API_KEY=k\nAPPLE_API_KEY_PATH=/a.p8`,
    processEnv: {},
    home: "/h",
    fileExists: (x) => x === "/h/.tauri/symphony.key",
  });
  assert.throws(
    () => r.validateCredentialsEnvironment({ ...env, APPLE_API_KEY: "<x>" }),
    /APPLE_API_KEY/,
  );
  assert.throws(
    () => r.validateCredentialsEnvironment(env, { fileExists: () => false }),
    /API key file/,
  );
  assert.throws(() => r.assertSigningIdentityPresent("none", ID), /keychain/);
});

for (const [label, fn] of [
  ["host", () => p.assertAppleSiliconHost({ os: "Linux", arch: "arm64" })],
  ["arch", () => p.assertAppleSiliconHost({ os: "Darwin", arch: "x86_64" })],
  ["branch", () => p.assertMainBranch("feature")],
  ["dirty", () => p.assertCleanWorkingTree(" M f")],
  ["origin", () => p.assertHeadMatchesOriginMain("a", "b")],
  ["tag", () => p.assertTagMatchesHead({ tag: "v1", tagCommit: "x", head: "y" })],
  ["release", () => p.assertReleaseAbsent({ tag: "v1", exists: true })],
  ["repo", () => p.assertRepositoryMatches("acme/other")],
  ["dmg-count", () => p.selectVersionedDmg({ candidates: [], version: "1.2.3" })],
  [
    "dmg-arch",
    () => p.selectVersionedDmg({ candidates: ["/t/Symphony_1.2.3_x64.dmg"], version: "1.2.3" }),
  ],
  [
    "empty-artifacts",
    () =>
      r.assertNonEmptyArtifacts([{ path: "x", exists: true, isFile: true, size: 0 }], {
        missingMessage: "error: signed updater artifacts are missing",
      }),
  ],
]) {
  test(`preflight rejects ${label}`, () => assert.throws(fn, /error:/));
}

test("preflight accepts happy path", () => {
  p.assertAppleSiliconHost({ os: "Darwin", arch: "arm64" });
  p.assertMainBranch("main");
  p.assertCleanWorkingTree("");
  p.assertHeadMatchesOriginMain("a", "a");
  p.assertTagMatchesHead({ tag: "v1", tagCommit: null, head: "a" });
  p.assertReleaseAbsent({ tag: "v1", exists: false });
  p.assertRepositoryMatches(r.RELEASE_REPOSITORY);
  assert.equal(
    p.selectVersionedDmg({ candidates: ["/t/Symphony_1.2.3_aarch64.dmg"], version: "1.2.3" }),
    "/t/Symphony_1.2.3_aarch64.dmg",
  );
});

test("injected runners prove command sequence without git/GitHub mutation", () => {
  const home = mkdtempSync(join(tmpdir(), "h-"));
  const root = mkdtempSync(join(tmpdir(), "r-"));
  try {
    writeCreds(home);
    mkdirSync(join(root, "src-tauri"), { recursive: true });
    writeFileSync(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "9.9.9" }));
    const arts = r.releaseArtifactPaths(root, { version: "9.9.9" });
    mkdirSync(arts.dmgDir, { recursive: true });
    mkdirSync(join(root, "target/release/bundle/macos"), { recursive: true });
    writeFileSync(arts.versionedDmgPath, "d");
    writeFileSync(arts.updaterBundle, "b");
    writeFileSync(arts.updaterSignature, "sig");
    const rel = runner([
      ["security find-identity -v -p codesigning", { status: 0, stdout: `1) ${ID}`, stderr: "" }],
    ]);
    r.runReleaseMacos({ root, runner: rel.run, processEnv: {}, home, log() {} });
    const cmds = rel.calls.map((c) => [c.command, ...(c.args ?? [])]);
    assert.equal(cmds[0][0], "security");
    assert.deepEqual(cmds[1], [
      "pnpm",
      "tauri",
      "build",
      "--config",
      "src-tauri/tauri.updater.conf.json",
    ]);
    assert.equal(cmds[2][0], "spctl");
    assert.equal(cmds[3][0], "xcrun");
    assert.ok(cmds[4].includes("verify-updater-signature"));
    assert.ok(cmds.every((c) => c[0] !== "gh"));
    const assets = r.requiredReleaseAssets("9.9.9").join("\n");
    const pub = runner([
      ["git rev-parse --abbrev-ref HEAD", { status: 0, stdout: "main\n", stderr: "" }],
      ["git status --porcelain", { status: 0, stdout: "", stderr: "" }],
      ["git fetch origin main --tags", { status: 0, stdout: "", stderr: "" }],
      ["git rev-parse HEAD", { status: 0, stdout: "deadbeef\n", stderr: "" }],
      ["git rev-parse origin/main", { status: 0, stdout: "deadbeef\n", stderr: "" }],
      [
        "git rev-parse -q --verify refs/tags/v9.9.9^{commit}",
        { status: 1, stdout: "", stderr: "" },
      ],
      ["gh release view v9.9.9", { status: 1, stdout: "", stderr: "x" }],
      ["security find-identity -v -p codesigning", { status: 0, stdout: `1) ${ID}`, stderr: "" }],
      [
        "gh repo view --json url -q .url",
        { status: 0, stdout: "https://github.com/anantjain-xyz/symphony-rust\n", stderr: "" },
      ],
      [
        "gh repo view --json nameWithOwner -q .nameWithOwner",
        { status: 0, stdout: "anantjain-xyz/symphony-rust\n", stderr: "" },
      ],
      [
        "gh release view v9.9.9 --json assets --jq .assets[].name",
        { status: 0, stdout: `${assets}\n`, stderr: "" },
      ],
    ]);
    const out = p.runPublishMacos({
      root,
      runner: pub.run,
      processEnv: {},
      host: { os: "Darwin", arch: "arm64" },
      log() {},
      runRelease: (o) => r.runReleaseMacos({ ...o, home, processEnv: {}, log() {} }),
    });
    assert.equal(out.tag, "v9.9.9");
    assert.equal(out.head, "deadbeef");
    const create = pub.calls.find((c) => c.args?.[1] === "create");
    const edit = pub.calls.find((c) => c.args?.includes("--draft=false"));
    const view = pub.calls.findIndex((c) => c.args?.includes("--jq"));
    assert.ok(create.args.includes("--draft"));
    assert.equal(create.args[create.args.indexOf("--target") + 1], "deadbeef");
    for (const s of [
      "Symphony_9.9.9_aarch64.dmg",
      "Symphony.dmg",
      "Symphony.app.tar.gz",
      "Symphony.app.tar.gz.sig",
      "latest.json",
    ]) {
      assert.ok(create.args.some((a) => String(a).endsWith(s)));
    }
    assert.ok(pub.calls.indexOf(create) < view && view < pub.calls.indexOf(edit));
    assert.ok(!pub.calls.some((c) => c.command === "git" && c.args?.[0] === "tag"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
