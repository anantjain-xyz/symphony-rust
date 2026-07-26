import assert from "node:assert/strict";
import test from "node:test";

import { bindingsDifference } from "./check-bindings.mjs";
import { checkIpcContract } from "./check-ipc.mjs";
import {
  checkProjectionContract,
  storageMutationDiagnostics,
} from "./check-projections.mjs";
import { checkReleaseContract } from "./check-release.mjs";

test("bindings byte comparison accepts equality and pinpoints drift", () => {
  assert.equal(bindingsDifference(Buffer.from("one\ntwo\n"), Buffer.from("one\ntwo\n")), null);
  const difference = bindingsDifference(Buffer.from("one\ntwo\n"), Buffer.from("one\nthree\n"));
  assert.match(difference, /line 2/u);
  assert.match(difference, /"two"/u);
  assert.match(difference, /"three"/u);
});

const ipcFixture = {
  rustSources: [
    {
      path: "src-tauri/src/commands.rs",
      source: `
        #[tauri::command(rename_all = "snake_case")]
        fn frontend() {}
        #[tauri::command]
        async fn diagnostic() {}
      `,
    },
    {
      path: "src-tauri/src/lib.rs",
      source: `
        fn run() {
          invoke_handler(tauri::generate_handler![
            commands::frontend,
            commands::diagnostic,
          ]);
        }
      `,
    },
  ],
  frontendSources: [
    {
      path: "src/app.ts",
      source: `
        import { invoke as tauriInvoke } from "@tauri-apps/api/core";
        function invokeCommand(command: string, args?: Record<string, unknown>) {
          return tauriInvoke(command, args);
        }
        invokeCommand("frontend");
      `,
    },
  ],
  backendOnly: ["diagnostic"],
};

test("IPC checker accepts aliases, wrappers, command attributes, and qualified handlers", () => {
  assert.deepEqual(checkIpcContract(ipcFixture), []);
});

test("IPC checker reports exact missing and extra ownership", () => {
  const diagnostics = checkIpcContract({
    ...ipcFixture,
    frontendSources: [
      {
        path: "src/app.ts",
        source: `
          import { invoke as tauriInvoke } from "@tauri-apps/api/core";
          tauriInvoke("unexpected");
        `,
      },
    ],
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("frontend use + backend-only") &&
        message.includes("missing [frontend]") &&
        message.includes("extra [unexpected]"),
    ),
  );
});

test("IPC checker rejects dynamic calls through an invoke wrapper", () => {
  const diagnostics = checkIpcContract({
    ...ipcFixture,
    frontendSources: [
      {
        path: "src/app.ts",
        source: `
          import * as tauriCore from "@tauri-apps/api/core";
          function invokeCommand(command: string) {
            return tauriCore.invoke(command);
          }
          const command = "frontend";
          invokeCommand(command);
        `,
      },
    ],
  });
  assert.ok(diagnostics.some((message) => message.includes("non-literal frontend invokes")));
});

test("IPC checker ignores unrelated invoke functions without a Tauri import", () => {
  const diagnostics = checkIpcContract({
    ...ipcFixture,
    frontendSources: [
      {
        path: "src/app.ts",
        source: `function invoke(command: string) { return command; } invoke("frontend");`,
      },
    ],
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("frontend use + backend-only") &&
        message.includes("missing [frontend]"),
    ),
  );
});

test("IPC checker rejects duplicate Rust and backend-only ownership", () => {
  const diagnostics = checkIpcContract({
    ...ipcFixture,
    rustSources: [
      {
        path: "src-tauri/src/lib.rs",
        source: `
          #[tauri::command]
          fn frontend() {}
          #[tauri::command]
          fn frontend() {}
          tauri::generate_handler![frontend, frontend, diagnostic];
        `,
      },
    ],
    backendOnly: ["diagnostic", "diagnostic"],
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("Rust command definitions") &&
        message.includes("duplicates [frontend]"),
    ),
  );
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("generate_handler! registrations") &&
        message.includes("duplicates [frontend]"),
    ),
  );
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("backend-only command allowlist") &&
        message.includes("duplicates [diagnostic]"),
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
  storageSource: `
    impl Repository {
      fn save(&self) {
        sqlx::query("insert into issues (id) values (?1)");
        self.changed("issues", "upsert");
      }
    }
  `,
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

test("projection checker rejects a durable mutation without its table notification", () => {
  const diagnostics = checkProjectionContract({
    ...projectionFixture,
    storageSource: `
      impl Repository {
        fn save(&self) {
          sqlx::query("insert into issues (id) values (?1)");
          sqlx::query("delete from runs where issue_id = ?1");
          self.changed("issues", "upsert");
        }
      }
    `,
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("Repository::save") &&
        message.includes("mutates [runs]") &&
        message.includes("self.changed"),
    ),
  );
});

test("projection checker narrowly exempts internal retro batch bookkeeping", () => {
  assert.deepEqual(
    storageMutationDiagnostics(`
      impl Repository {
        fn reserve_retro_batch(&self) {
          sqlx::query("update retros set id = id where id = ?1");
          sqlx::query("insert into retro_batches (id) values (?1)");
          sqlx::query("insert into retro_batch_items (batch_id) values (?1)");
          self.changed("retro_batches", "insert");
        }
      }
    `),
    [],
  );
  assert.ok(
    storageMutationDiagnostics(`
      impl Repository {
        fn write_join_row_directly(&self) {
          sqlx::query("insert into retro_batch_items (batch_id) values (?1)");
        }
      }
    `).some(
      (message) =>
        message.includes("Repository::write_join_row_directly") &&
        message.includes("retro_batch_items"),
    ),
  );
});

test("projection checker rejects opaque sqlx::query ownership", () => {
  assert.ok(
    storageMutationDiagnostics(`
      impl Repository {
        fn save(&self, statement: &str) {
          sqlx::query(statement);
        }
      }
    `).some(
      (message) =>
        message.includes("Repository::save") &&
        message.includes("non-literal sqlx::query"),
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
    set -euo pipefail
    pnpm tauri build --config src-tauri/tauri.updater.conf.json
    APP="$ROOT/target/release/bundle/macos/Symphony.app"
    UPDATER_BUNDLE="$ROOT/target/release/bundle/macos/Symphony.app.tar.gz"
    UPDATER_SIGNATURE="$UPDATER_BUNDLE.sig"
    cargo run --quiet --manifest-path "$ROOT/src-tauri/Cargo.toml" \\
      --example verify-updater-signature -- \\
      "$UPDATER_BUNDLE" "$UPDATER_SIGNATURE" "$ROOT/src-tauri/tauri.conf.json"
  `,
  publishScript: `
    set -euo pipefail
    VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
    TAG="v$VERSION"
    COMMIT="$(git rev-parse HEAD)"
    bash "$ROOT/scripts/release-macos.sh"
    DMGS=("$ROOT"/target/release/bundle/dmg/Symphony_"$VERSION"_*.dmg)
    if (( \${#DMGS[@]} != 1 )); then
      exit 1
    fi
    DMG="\${DMGS[0]}"
    if [[ "$(basename "$DMG")" != "Symphony_\${VERSION}_aarch64.dmg" ]]; then
      exit 1
    fi
    UPDATER_BUNDLE="$ROOT/target/release/bundle/macos/Symphony.app.tar.gz"
    UPDATER_SIGNATURE="$UPDATER_BUNDLE.sig"
    STAGE="$(mktemp -d)"
    cp "$DMG" "$STAGE/Symphony.dmg"
    REPO_SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
    UPDATER_URL="https://github.com/$REPO_SLUG/releases/download/$TAG/Symphony.app.tar.gz"
    SIGNATURE="$(<"$UPDATER_SIGNATURE")"
    VERSION="$VERSION" UPDATER_URL="$UPDATER_URL" SIGNATURE="$SIGNATURE" \\
      node -e '
        const feed = {
          version: process.env.VERSION,
          platforms: {
            "darwin-aarch64": {
              url: process.env.UPDATER_URL,
              signature: process.env.SIGNATURE,
            },
          },
        };
        process.stdout.write(JSON.stringify(feed, null, 2) + "\\n");
      ' > "$STAGE/latest.json"
    gh release create "$TAG" \\
      --target "$COMMIT" \\
      --draft \\
      "$DMG" \\
      "$STAGE/Symphony.dmg" \\
      "$UPDATER_BUNDLE" \\
      "$UPDATER_SIGNATURE" \\
      "$STAGE/latest.json"
    for asset in \\
      "$(basename "$DMG")" \\
      Symphony.dmg \\
      Symphony.app.tar.gz \\
      Symphony.app.tar.gz.sig \\
      latest.json; do
      if ! gh release view "$TAG" --json assets --jq '.assets[].name' | grep -qxF "$asset"; then
        exit 1
      fi
    done
    gh release edit "$TAG" --draft=false
  `,
  contract: releaseContract,
};

test("release checker accepts synchronized versions and artifacts", () => {
  assert.deepEqual(checkReleaseContract(releaseFixture), []);
});

function removeExactShellLine(source, expected) {
  const lines = source.split("\n");
  const matches = lines.filter((line) => line.trim() === expected);
  assert.equal(
    matches.length,
    1,
    `fixture must contain exactly one shell line ${JSON.stringify(expected)}`,
  );
  return lines.filter((line) => line.trim() !== expected).join("\n");
}

test("release checker rejects version and artifact drift", () => {
  const diagnostics = checkReleaseContract({
    ...releaseFixture,
    packageJson: { version: "9.9.9" },
    publishScript: releaseFixture.publishScript.replaceAll("Symphony.dmg", "Other.dmg"),
  });
  assert.ok(diagnostics.some((message) => message.includes("package.json")));
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("scripts/publish-macos.sh") && message.includes("Symphony.dmg"),
    ),
  );
});

for (const [label, operand] of [
  ["versioned DMG", '"$DMG" \\'],
  ["stable DMG", '"$STAGE/Symphony.dmg" \\'],
  ["updater bundle", '"$UPDATER_BUNDLE" \\'],
  ["updater signature", '"$UPDATER_SIGNATURE" \\'],
  ["updater feed", '"$STAGE/latest.json"'],
]) {
  test(`release checker rejects a missing ${label} upload operand`, () => {
    const publishScript = removeExactShellLine(releaseFixture.publishScript, operand);
    const diagnostics = checkReleaseContract({ ...releaseFixture, publishScript });
    assert.ok(
      diagnostics.some(
        (message) =>
          message.includes("gh release create") &&
          message.includes(operand.replaceAll('"', "").replace(/ \\$/u, "")),
      ),
    );
  });
}

for (const [label, asset] of [
  ["versioned DMG", '"$(basename "$DMG")" \\'],
  ["stable DMG", "Symphony.dmg \\"],
  ["updater bundle", "Symphony.app.tar.gz \\"],
  ["updater signature", "Symphony.app.tar.gz.sig \\"],
  ["updater feed", "latest.json; do"],
]) {
  test(`release checker rejects a missing ${label} post-upload check`, () => {
    const publishScript = removeExactShellLine(releaseFixture.publishScript, asset);
    const diagnostics = checkReleaseContract({ ...releaseFixture, publishScript });
    assert.ok(
      diagnostics.some(
        (message) =>
          message.includes("assets verified after upload") ||
          message.includes("verification loop"),
      ),
    );
  });
}

test("release checker requires draft creation targeted at the verified commit", () => {
  for (const flagLine of ['--draft \\', '--target "$COMMIT" \\']) {
    const publishScript = removeExactShellLine(releaseFixture.publishScript, flagLine);
    const diagnostics = checkReleaseContract({ ...releaseFixture, publishScript });
    assert.ok(
      diagnostics.some(
        (message) =>
          message.includes(
            flagLine.startsWith("--draft") ? "draft release" : "--target $COMMIT",
          ),
      ),
    );
  }
});

test("release checker requires exact-name post-upload verification to fail closed", () => {
  const publishScript = releaseFixture.publishScript.replace(
    'if ! gh release view "$TAG" --json assets --jq \'.assets[].name\' | grep -qxF "$asset"; then',
    'if gh release view "$TAG" --json assets --jq \'.assets[].name\' | grep -qxF "$asset"; then',
  );
  assert.notEqual(publishScript, releaseFixture.publishScript);
  const diagnostics = checkReleaseContract({ ...releaseFixture, publishScript });
  assert.ok(
    diagnostics.some((message) => message.includes("exact-name gh release view")),
  );
});

test("release checker rejects publication before post-upload verification", () => {
  const publish = '    gh release edit "$TAG" --draft=false\n';
  assert.ok(releaseFixture.publishScript.includes(publish));
  const publishScript = releaseFixture.publishScript
    .replace(publish, "")
    .replace("    for asset in \\\n", `${publish}    for asset in \\\n`);
  const diagnostics = checkReleaseContract({ ...releaseFixture, publishScript });
  assert.ok(
    diagnostics.some((message) =>
      message.includes("publication must follow successful post-upload verification"),
    ),
  );
});

test("release checker binds updater feed target and URL to the release contract", () => {
  for (const [from, to, expected] of [
    ['"darwin-aarch64": {', '"darwin-x86_64": {', "must define platform"],
    [
      "url: process.env.UPDATER_URL",
      'url: "https://example.invalid/stale"',
      ".url must come from process.env.UPDATER_URL",
    ],
  ]) {
    const publishScript = releaseFixture.publishScript.replace(from, to);
    assert.notEqual(publishScript, releaseFixture.publishScript);
    const diagnostics = checkReleaseContract({ ...releaseFixture, publishScript });
    assert.ok(diagnostics.some((message) => message.includes(expected)));
  }
});
