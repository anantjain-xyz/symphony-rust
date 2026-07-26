import assert from "node:assert/strict";
import test from "node:test";

import { bindingsDifference } from "./check-bindings.mjs";
import { checkIpcContract } from "./check-ipc.mjs";
import { checkProjectionContract } from "./check-projections.mjs";
import { checkReleaseContract } from "./check-release.mjs";

test("bindings byte comparison accepts equality and pinpoints drift", () => {
  assert.equal(bindingsDifference(Buffer.from("one\ntwo\n"), Buffer.from("one\ntwo\n")), null);
  const difference = bindingsDifference(Buffer.from("one\ntwo\n"), Buffer.from("one\nthree\n"));
  assert.match(difference, /line 2/u);
  assert.match(difference, /"two"/u);
  assert.match(difference, /"three"/u);
});

const ipcFixture = {
  rustSource: `
    #[tauri::command]
    fn frontend() {}
    #[tauri::command]
    async fn diagnostic() {}
    fn run() {
      invoke_handler(tauri::generate_handler![frontend, diagnostic]);
    }
  `,
  frontendSources: [
    {
      path: "src/app.ts",
      source: `invoke("frontend");`,
    },
  ],
  contractSource: `
    export const IPC_COMMANDS = {
      frontend: { preview: true },
    } as const;
    export const BACKEND_ONLY_COMMANDS = ["diagnostic"] as const;
  `,
  previewSource: `
    export const previewCommandMocks = {
      frontend: () => "fixture",
    } satisfies Record<string, unknown>;
  `,
};

test("IPC checker accepts a complete command projection", () => {
  assert.deepEqual(checkIpcContract(ipcFixture), []);
});

test("IPC checker reports exact missing and extra ownership", () => {
  const diagnostics = checkIpcContract({
    ...ipcFixture,
    frontendSources: [{ path: "src/app.ts", source: `invoke("unexpected");` }],
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("frontend invoke literals") &&
        message.includes("missing [frontend]") &&
        message.includes("extra [unexpected]"),
    ),
  );
});

const projectionFixture = {
  rustPromptSource: `pub const PROMPT_VARIABLES: [&str; 1] = ["issue.id"];`,
  settingsSource: `
    const PROMPT_VARIABLES = [
      { name: "issue.id", description: "id", example: "" },
    ];
  `,
  readmeSource: `
| Placeholder | Renders as |
|---|---|
| \`{{issue.id}}\` | ID |
`,
  storageSource: `fn save(&self) { self.changed("issues", "upsert"); }`,
  dashboardSource: `
    const TABLE_INVALIDATIONS = {
      issues: ["overview"],
    };
  `,
};

test("projection checker accepts matching prompt and invalidation owners", () => {
  assert.deepEqual(checkProjectionContract(projectionFixture), []);
});

test("projection checker reports both missing and extra values", () => {
  const diagnostics = checkProjectionContract({
    ...projectionFixture,
    settingsSource: `
      const PROMPT_VARIABLES = [
        { name: "issue.title", description: "title", example: "" },
      ];
    `,
    dashboardSource: `const TABLE_INVALIDATIONS = { runs: ["overview"] };`,
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("Settings UI") &&
        message.includes("missing [issue.id]") &&
        message.includes("extra [issue.title]"),
    ),
  );
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("frontend invalidations") &&
        message.includes("missing [issues]") &&
        message.includes("extra [runs]"),
    ),
  );
});

const releaseContract = {
  repository: "acme/symphony",
  productName: "Symphony",
  updaterTarget: "darwin-aarch64",
  versionedDmg: "Symphony_<version>_aarch64.dmg",
  stableDmg: "Symphony.dmg",
  updaterBundle: "Symphony.app.tar.gz",
  updaterSignature: "Symphony.app.tar.gz.sig",
  updaterFeed: "latest.json",
};

const releaseFixture = {
  rootCargo: `[workspace.package]\nversion = "1.2.3"\n`,
  desktopCargo: `[package]\nname = "symphony-desktop"\nversion = "1.2.3"\n`,
  packageJson: { version: "1.2.3" },
  tauriConfig: {
    productName: "Symphony",
    version: "1.2.3",
    plugins: {
      updater: {
        endpoints: [
          "https://github.com/acme/symphony/releases/latest/download/latest.json",
        ],
      },
    },
  },
  updaterConfig: { bundle: { createUpdaterArtifacts: true } },
  cargoLock: `[[package]]\nname = "symphony-desktop"\nversion = "1.2.3"\n`,
  cargoMetadata: {
    workspace_members: ["path#symphony-desktop@1.2.3"],
    packages: [
      {
        id: "path#symphony-desktop@1.2.3",
        name: "symphony-desktop",
        version: "1.2.3",
        manifest_path: "/repo/src-tauri/Cargo.toml",
      },
    ],
  },
  releaseScript: `
    pnpm tauri build --config src-tauri/tauri.updater.conf.json
    target/release/bundle/macos/Symphony.app
    target/release/bundle/macos/Symphony.app.tar.gz
  `,
  publishScript: `
    VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
    Symphony_\${VERSION}_aarch64.dmg
    target/release/bundle/macos/Symphony.app.tar.gz
    Symphony.dmg
    Symphony.app.tar.gz.sig
    latest.json
    "darwin-aarch64"
    releases/download/$TAG/Symphony.app.tar.gz
  `,
  contract: releaseContract,
};

test("release checker accepts synchronized versions and artifacts", () => {
  assert.deepEqual(checkReleaseContract(releaseFixture), []);
});

test("release checker rejects version and artifact drift", () => {
  const diagnostics = checkReleaseContract({
    ...releaseFixture,
    packageJson: { version: "9.9.9" },
    publishScript: releaseFixture.publishScript.replace("Symphony.dmg", "Other.dmg"),
  });
  assert.ok(diagnostics.some((message) => message.includes("package.json")));
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("scripts/publish-macos.sh") && message.includes("Symphony.dmg"),
    ),
  );
});
