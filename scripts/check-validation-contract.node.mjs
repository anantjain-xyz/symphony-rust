import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CANONICAL_RUNNER_SOURCE,
  runValidationProfile,
  validateValidationContract,
} from "./check-validation-contract.mjs";

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeJson(root, path, value) {
  write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function validationFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "symphony-validation-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeJson(root, "package.json", {
    scripts: {
      "check:validation-contract":
        "node scripts/check-validation-contract.mjs",
      "check:bundle": "node scripts/check-bundle-budget.mjs",
      "check:frontend-boundaries":
        "node scripts/check-frontend-boundaries.mjs",
      "check:frontend-contracts":
        "pnpm check:frontend-boundaries && pnpm check:preview-coverage",
      "check:harness": "node scripts/check-agent-assets.mjs",
      "check:preview-coverage": "node scripts/check-preview-coverage.mjs",
      test: "vitest run",
      "test:bundle": "node --test scripts/check-bundle-budget.node.mjs",
      "test:frontend-contracts":
        "node --test scripts/check-frontend-boundaries.node.mjs scripts/check-preview-coverage.node.mjs && vitest run src/desktop/events.test.ts src/dashboardRefreshCoordinator.test.ts src/pollController.test.ts src/settingsValidationController.test.ts",
      "test:validation":
        "node --test scripts/check-agent-assets.node.mjs scripts/check-validation-contract.node.mjs",
      "test:e2e": "playwright test",
      typecheck: "tsc --noEmit",
      build: "tsc && vite build",
      "verify:fast": "node scripts/run-validation.mjs fast",
      "verify:full": "node scripts/run-validation.mjs full",
    },
    devDependencies: {
      "@playwright/test": "1.0.0",
      typescript: "1.0.0",
      vite: "1.0.0",
      vitest: "1.0.0",
    },
  });
  for (const path of [
    "scripts/check-validation-contract.mjs",
    "scripts/check-validation-contract.node.mjs",
    "scripts/check-agent-assets.mjs",
    "scripts/check-agent-assets.node.mjs",
    "scripts/check-bundle-budget.mjs",
    "scripts/check-bundle-budget.node.mjs",
    "scripts/check-frontend-boundaries.mjs",
    "scripts/check-frontend-boundaries.node.mjs",
    "scripts/check-preview-coverage.mjs",
    "scripts/check-preview-coverage.node.mjs",
    "scripts/fixture.node.mjs",
  ]) {
    write(root, path, "\n");
  }
  write(root, "scripts/run-validation.mjs", CANONICAL_RUNNER_SOURCE);
  write(
    root,
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  validate:\n    steps:\n      - run: pnpm verify:full\n",
  );
  write(
    root,
    "CONTRIBUTING.md",
    "```sh\npnpm verify:fast\n\npnpm verify:full\n```\n",
  );
  write(
    root,
    "docs/DEVELOPMENT.md",
    "The canonical CI gate is:\n\n```sh\npnpm verify:full\n```\n",
  );
  for (const name of ["pull", "push"]) {
    write(
      root,
      `.agents/skills/symphony-${name}/SKILL.md`,
      "Run `pnpm verify:full`.\n",
    );
  }
  writeJson(root, "validation/contract.json", {
    version: 1,
    executables: ["cargo", "pnpm"],
    entrypoints: {
      fast: { packageScript: "verify:fast", profile: "fast" },
      full: { packageScript: "verify:full", profile: "full" },
    },
    profiles: {
      fast: [
        "validation-contract",
        "agent-assets",
        "validation-tests",
        "frontend-contracts",
        "frontend-contract-tests",
        "rust-format",
        "rust-clippy",
        "rust-tests",
        "frontend-typecheck",
        "frontend-tests",
      ],
      full: [
        "validation-contract",
        "agent-assets",
        "validation-tests",
        "frontend-contracts",
        "frontend-contract-tests",
        "rust-format",
        "rust-clippy",
        "rust-tests",
        "frontend-typecheck",
        "frontend-tests",
        "frontend-build",
        "bundle-budget",
        "bundle-tests",
        "browser-install",
        "browser-e2e",
      ],
    },
    commands: {
      "validation-contract": {
        label: "contract",
        argv: ["pnpm", "check:validation-contract"],
        packageScript: "check:validation-contract",
      },
      "agent-assets": {
        label: "harness",
        argv: ["pnpm", "check:harness"],
        packageScript: "check:harness",
      },
      "validation-tests": {
        label: "checker tests",
        argv: ["pnpm", "test:validation"],
        packageScript: "test:validation",
      },
      "frontend-contracts": {
        label: "frontend static contracts",
        argv: ["pnpm", "check:frontend-contracts"],
        packageScript: "check:frontend-contracts",
      },
      "frontend-contract-tests": {
        label: "frontend contract tests",
        argv: ["pnpm", "test:frontend-contracts"],
        packageScript: "test:frontend-contracts",
      },
      "rust-format": {
        label: "Rust formatting",
        argv: ["cargo", "fmt", "--all", "--check"],
      },
      "rust-clippy": {
        label: "Rust Clippy",
        argv: [
          "cargo",
          "clippy",
          "--workspace",
          "--exclude",
          "symphony-desktop",
          "--all-targets",
          "--",
          "-D",
          "warnings",
        ],
      },
      "rust-tests": {
        label: "Rust tests",
        argv: [
          "cargo",
          "test",
          "--workspace",
          "--exclude",
          "symphony-desktop",
        ],
      },
      "frontend-typecheck": {
        label: "TypeScript typecheck",
        argv: ["pnpm", "typecheck"],
        packageScript: "typecheck",
      },
      "frontend-tests": {
        label: "frontend tests",
        argv: ["pnpm", "test"],
        packageScript: "test",
      },
      "frontend-build": {
        label: "frontend build",
        argv: ["pnpm", "build"],
        packageScript: "build",
      },
      "bundle-budget": {
        label: "bundle budget",
        argv: ["pnpm", "check:bundle"],
        packageScript: "check:bundle",
      },
      "bundle-tests": {
        label: "bundle tests",
        argv: ["pnpm", "test:bundle"],
        packageScript: "test:bundle",
      },
      "browser-install": {
        label: "browser install",
        argv: [
          "pnpm",
          "exec",
          "playwright",
          "install",
          "--with-deps",
          "chromium",
        ],
        installsBrowser: true,
      },
      "browser-e2e": {
        label: "browser",
        argv: ["pnpm", "test:e2e"],
        packageScript: "test:e2e",
        requiresBrowser: true,
      },
    },
    integrations: {
      ci: {
        path: ".github/workflows/ci.yml",
        command: "pnpm verify:full",
      },
      contributing: {
        path: "CONTRIBUTING.md",
        commands: ["pnpm verify:fast", "pnpm verify:full"],
      },
      skills: {
        paths: [
          ".agents/skills/symphony-pull/SKILL.md",
          ".agents/skills/symphony-push/SKILL.md",
        ],
        command: "pnpm verify:full",
      },
    },
  });
  return root;
}

test("accepts a complete canonical validation contract", (t) => {
  const root = validationFixture(t);
  assert.deepEqual(validateValidationContract(root), []);
});

test("pins every command required by the advertised fast profile", (t) => {
  const root = validationFixture(t);
  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  contract.profiles.fast = ["validation-contract"];
  writeJson(root, "validation/contract.json", contract);

  const errors = validateValidationContract(root).join("\n");
  for (const commandId of [
    "agent-assets",
    "validation-tests",
    "frontend-contracts",
    "frontend-contract-tests",
    "rust-format",
    "rust-clippy",
    "rust-tests",
    "frontend-typecheck",
    "frontend-tests",
  ]) {
    assert.match(
      errors,
      new RegExp(
        `fast validation profile must include required command ${commandId}`,
      ),
    );
  }
});

test("requires the tested canonical validation runner entrypoint", (t) => {
  const root = validationFixture(t);
  write(root, "scripts/run-validation.mjs", "// no-op\n");

  assert.match(
    validateValidationContract(root).join("\n"),
    /validation runner scripts\/run-validation\.mjs must delegate to the tested canonical profile executor/,
  );
});

test("validation runner traverses profiles and propagates failures", (t) => {
  const root = validationFixture(t);
  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  const invocations = [];
  const successStatus = runValidationProfile({
    root,
    profileName: "fast",
    spawn(executable, args) {
      invocations.push([executable, ...args]);
      return { status: 0 };
    },
    stdout() {},
    stderr() {},
  });

  assert.equal(successStatus, 0);
  assert.deepEqual(
    invocations,
    contract.profiles.fast.map((commandId) => contract.commands[commandId].argv),
  );

  let attempts = 0;
  const failureStatus = runValidationProfile({
    root,
    profileName: "fast",
    spawn() {
      attempts += 1;
      return { status: attempts === 4 ? 23 : 0 };
    },
    stdout() {},
    stderr() {},
  });
  assert.equal(failureStatus, 23);
  assert.equal(attempts, 4);

  const windowsInvocations = [];
  const windowsStatus = runValidationProfile({
    root,
    profileName: "fast",
    platform: "win32",
    spawn(executable, args) {
      windowsInvocations.push([executable, ...args]);
      return { status: 0 };
    },
    stdout() {},
    stderr() {},
  });
  assert.equal(windowsStatus, 0);
  assert.deepEqual(windowsInvocations[0], [
    "cmd.exe",
    "/d",
    "/s",
    "/c",
    "pnpm.cmd",
    "check:validation-contract",
  ]);
  assert.deepEqual(
    windowsInvocations.find((argv) => argv[0] === "cargo"),
    ["cargo", "fmt", "--all", "--check"],
  );
});

test("pins the bodies of package scripts owned by required gates", (t) => {
  const root = validationFixture(t);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson.scripts["test:validation"] = "node --help";
  packageJson.scripts["check:frontend-boundaries"] = "node --help";
  writeJson(root, "package.json", packageJson);

  const errors = validateValidationContract(root).join("\n");
  assert.match(
    errors,
    /required package script test:validation must be "node --test scripts\/check-agent-assets\.node\.mjs scripts\/check-validation-contract\.node\.mjs", received "node --help"/,
  );
  assert.match(
    errors,
    /required package script check:frontend-boundaries must be "node scripts\/check-frontend-boundaries\.mjs", received "node --help"/,
  );
});

test("reports missing package scripts and command ids with owners", (t) => {
  const root = validationFixture(t);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  delete packageJson.scripts["check:harness"];
  writeJson(root, "package.json", packageJson);
  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  contract.profiles.fast.push("not-defined");
  writeJson(root, "validation/contract.json", contract);

  const errors = validateValidationContract(root).join("\n");
  assert.match(
    errors,
    /validation command agent-assets references missing package script check:harness/,
  );
  assert.match(
    errors,
    /validation profile fast references missing command not-defined/,
  );
});

test("rejects CI and adapted skills that bypass the canonical gate", (t) => {
  const root = validationFixture(t);
  write(
    root,
    ".github/workflows/ci.yml",
    "jobs:\n  validate:\n    steps:\n      - run: pnpm test:e2e\n",
  );
  write(
    root,
    ".agents/skills/symphony-pull/SKILL.md",
    "Run a copied command list.\n",
  );

  const errors = validateValidationContract(root).join("\n");
  assert.match(
    errors,
    /must run canonical entrypoint "pnpm verify:full" exactly once; found 0/,
  );
  assert.match(
    errors,
    /symphony-pull\/SKILL\.md must reference canonical gate "pnpm verify:full" exactly once; found 0/,
  );
});

test("requires the canonical CI step and its job to be failure-gating", (t) => {
  const root = validationFixture(t);
  write(
    root,
    ".github/workflows/ci.yml",
    `defaults:
  run:
    shell: true {0}
jobs:
  validate:
    if: \${{ false }}
    continue-on-error: true
    defaults:
      run:
        shell: true {0}
    steps:
      - run: pnpm verify:full
        if: \${{ false }}
        continue-on-error: true
        shell: true {0}
`,
  );

  const errors = validateValidationContract(root).join("\n");
  assert.match(
    errors,
    /canonical entrypoint step must be unconditional and failure-gating; remove continue-on-error/,
  );
  assert.match(
    errors,
    /canonical entrypoint step must be unconditional and failure-gating; remove if/,
  );
  assert.match(
    errors,
    /canonical entrypoint job must be unconditional and failure-gating; remove if/,
  );
  assert.match(
    errors,
    /canonical entrypoint job must be unconditional and failure-gating; remove continue-on-error/,
  );
  assert.match(
    errors,
    /canonical entrypoint step must use the default shell from the repository root; remove shell/,
  );
  assert.match(
    errors,
    /canonical entrypoint job must not override run defaults; remove defaults/,
  );
  assert.match(
    errors,
    /must not override workflow run defaults/,
  );
});

test("requires pull request and main push CI triggers", (t) => {
  const root = validationFixture(t);
  write(
    root,
    ".github/workflows/ci.yml",
    `on:
  workflow_dispatch:
jobs:
  validate:
    steps:
      - run: pnpm verify:full
`,
  );

  const errors = validateValidationContract(root).join("\n");
  assert.match(
    errors,
    /must trigger every pull_request without filters/,
  );
  assert.match(
    errors,
    /must trigger pushes to main with branches: \[main\] and no filters/,
  );
});

test("requires visible contributor and adapted-skill gate references", (t) => {
  const root = validationFixture(t);
  write(
    root,
    "CONTRIBUTING.md",
    "<!--\npnpm verify:fast\npnpm verify:full\n-->\n",
  );
  write(
    root,
    ".agents/skills/symphony-pull/SKILL.md",
    "<!-- Run pnpm verify:full. -->\n",
  );
  write(
    root,
    "docs/DEVELOPMENT.md",
    "<!--\npnpm verify:full\n-->\n",
  );

  const errors = validateValidationContract(root).join("\n");
  assert.match(
    errors,
    /CONTRIBUTING\.md must show pnpm verify:fast on a visible command line/,
  );
  assert.match(
    errors,
    /CONTRIBUTING\.md must show pnpm verify:full on a visible command line/,
  );
  assert.match(
    errors,
    /symphony-pull\/SKILL\.md must reference canonical gate "pnpm verify:full" exactly once; found 0/,
  );
  assert.match(
    errors,
    /development guide docs\/DEVELOPMENT\.md must show canonical full entrypoint pnpm verify:full on a visible command line/,
  );
});

test("rejects validation scripts omitted from the canonical full profile", (t) => {
  const root = validationFixture(t);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson.scripts["check:omitted"] = "node scripts/omitted.mjs";
  writeJson(root, "package.json", packageJson);
  write(root, "scripts/omitted.mjs", "\n");

  assert.match(
    validateValidationContract(root).join("\n"),
    /validation package script check:omitted is not owned by a command in validation\/contract\.json and included in the full profile/,
  );
});

test("validates nested pnpm and Cargo validation scripts without executing them", (t) => {
  const root = validationFixture(t);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson.scripts["check:static"] =
    "pnpm check:harness && pnpm run test:runtime-contracts";
  packageJson.scripts["test:runtime-contracts"] =
    "cargo test -p symphony-worker runtime_contracts && cargo test -p symphony-storage transition_contracts";
  writeJson(root, "package.json", packageJson);

  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  contract.commands.static = {
    label: "static contracts",
    argv: ["pnpm", "check:static"],
    packageScript: "check:static",
  };
  contract.commands.runtime = {
    label: "runtime contracts",
    argv: ["pnpm", "test:runtime-contracts"],
    packageScript: "test:runtime-contracts",
  };
  contract.profiles.full.push("static", "runtime");
  writeJson(root, "validation/contract.json", contract);

  assert.deepEqual(validateValidationContract(root), []);
});

test("accepts quoted and escaped hashes in validation script arguments", (t) => {
  const root = validationFixture(t);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson.scripts["test:hash-args"] =
    'node scripts/fixture.node.mjs "value # literal" value\\#literal';
  writeJson(root, "package.json", packageJson);

  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  contract.commands["hash-args"] = {
    label: "hash arguments",
    argv: ["pnpm", "test:hash-args"],
    packageScript: "test:hash-args",
  };
  contract.profiles.full.push("hash-args");
  writeJson(root, "validation/contract.json", contract);

  assert.deepEqual(validateValidationContract(root), []);
});

test("rejects recursive scripts and unsupported shell syntax descriptively", (t) => {
  const root = validationFixture(t);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson.scripts["check:cycle"] = "pnpm check:cycle";
  packageJson.scripts["test:unsafe"] = "node scripts/fixture.node.mjs | tee result.txt";
  packageJson.scripts["test:backgrounded"] =
    "node scripts/fixture.node.mjs & node scripts/fixture.node.mjs";
  packageJson.scripts["test:commented"] =
    "node scripts/fixture.node.mjs # && vitest run";
  packageJson.scripts["test:line-break"] =
    "vitest run\nnode scripts/fixture.node.mjs";
  writeJson(root, "package.json", packageJson);

  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  contract.commands.cycle = {
    label: "cycle",
    argv: ["pnpm", "check:cycle"],
    packageScript: "check:cycle",
  };
  contract.commands.unsafe = {
    label: "unsafe",
    argv: ["pnpm", "test:unsafe"],
    packageScript: "test:unsafe",
  };
  contract.commands.backgrounded = {
    label: "backgrounded",
    argv: ["pnpm", "test:backgrounded"],
    packageScript: "test:backgrounded",
  };
  contract.commands.commented = {
    label: "commented",
    argv: ["pnpm", "test:commented"],
    packageScript: "test:commented",
  };
  contract.commands["line-break"] = {
    label: "line break",
    argv: ["pnpm", "test:line-break"],
    packageScript: "test:line-break",
  };
  contract.profiles.full.push(
    "cycle",
    "unsafe",
    "backgrounded",
    "commented",
    "line-break",
  );
  writeJson(root, "validation/contract.json", contract);

  const errors = validateValidationContract(root).join("\n");
  assert.match(errors, /package scripts contain a cycle: check:cycle -> check:cycle/);
  assert.match(errors, /package script test:unsafe uses unsupported shell syntax/);
  assert.match(
    errors,
    /package script test:backgrounded uses unsupported shell syntax near "&"/,
  );
  assert.match(
    errors,
    /package script test:commented uses unsupported shell comment syntax near "#"/,
  );
  assert.match(
    errors,
    /package script test:line-break uses unsupported shell line break/,
  );
});

test("pins required full-gate commands independently of the command inventory", (t) => {
  const root = validationFixture(t);
  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  for (const commandId of [
    "validation-contract",
    "agent-assets",
    "validation-tests",
    "frontend-contracts",
    "frontend-contract-tests",
    "rust-format",
    "rust-clippy",
    "rust-tests",
    "frontend-typecheck",
    "frontend-tests",
    "frontend-build",
    "bundle-budget",
    "bundle-tests",
    "browser-install",
    "browser-e2e",
  ]) {
    delete contract.commands[commandId];
    contract.profiles.full = contract.profiles.full.filter(
      (candidate) => candidate !== commandId,
    );
  }
  writeJson(root, "validation/contract.json", contract);

  const errors = validateValidationContract(root).join("\n");
  for (const commandId of [
    "validation-contract",
    "agent-assets",
    "validation-tests",
    "frontend-contracts",
    "frontend-contract-tests",
    "rust-format",
    "rust-clippy",
    "rust-tests",
    "frontend-typecheck",
    "frontend-tests",
    "frontend-build",
    "bundle-budget",
    "bundle-tests",
    "browser-install",
    "browser-e2e",
  ]) {
    assert.match(
      errors,
      new RegExp(`full validation contract is missing required command ${commandId}`),
    );
  }
});

test("pins the semantics of required full-gate commands", (t) => {
  const root = validationFixture(t);
  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  contract.commands["rust-clippy"].argv = ["cargo", "clippy"];
  contract.commands["frontend-build"].packageScript = "typecheck";
  contract.commands["frontend-build"].argv = ["pnpm", "typecheck"];
  contract.commands["frontend-tests"].argv = ["pnpm", "typecheck"];
  contract.commands["bundle-budget"].packageScript = "test:bundle";
  contract.commands["bundle-tests"].argv = ["pnpm", "check:bundle"];
  contract.commands["browser-install"].argv = [
    "pnpm",
    "exec",
    "playwright",
    "install",
    "chromium",
  ];
  contract.commands["browser-install"].installsBrowser = false;
  contract.commands["browser-e2e"].requiresBrowser = false;
  writeJson(root, "validation/contract.json", contract);

  const errors = validateValidationContract(root).join("\n");
  assert.match(
    errors,
    /required command rust-clippy argv must be cargo clippy --workspace/,
  );
  assert.match(
    errors,
    /required command frontend-build argv must be pnpm build, received pnpm typecheck/,
  );
  assert.match(
    errors,
    /required command frontend-build must own package script build, received "typecheck"/,
  );
  assert.match(
    errors,
    /required command frontend-tests argv must be pnpm test, received pnpm typecheck/,
  );
  assert.match(
    errors,
    /required command bundle-budget must own package script check:bundle, received "test:bundle"/,
  );
  assert.match(
    errors,
    /required command bundle-tests argv must be pnpm test:bundle, received pnpm check:bundle/,
  );
  assert.match(
    errors,
    /required command browser-install argv must be pnpm exec playwright install --with-deps chromium/,
  );
  assert.match(
    errors,
    /required command browser-install must declare installsBrowser: true/,
  );
  assert.match(
    errors,
    /required command browser-e2e must declare requiresBrowser: true/,
  );
});

test("binds canonical entrypoints to matching profiles", (t) => {
  const root = validationFixture(t);
  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  contract.entrypoints.full.profile = "fast";
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson.scripts["verify:full"] = "node scripts/run-validation.mjs fast";
  writeJson(root, "validation/contract.json", contract);
  writeJson(root, "package.json", packageJson);

  assert.match(
    validateValidationContract(root).join("\n"),
    /entrypoint full must target profile full, received "fast"/,
  );
});

test("requires browser installation before browser validation", (t) => {
  const root = validationFixture(t);
  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  contract.profiles.full = contract.profiles.full.filter(
    (command) => command !== "browser-install",
  );
  delete contract.commands["browser-install"];
  writeJson(root, "validation/contract.json", contract);

  assert.match(
    validateValidationContract(root).join("\n"),
    /browser command browser-e2e must follow required command browser-install in the full profile/,
  );
});

test("requires production build before bundle inspection", (t) => {
  const root = validationFixture(t);
  const contract = JSON.parse(
    readFileSync(join(root, "validation/contract.json"), "utf8"),
  );
  contract.profiles.full = contract.profiles.full.filter(
    (command) => command !== "frontend-build",
  );
  contract.profiles.full.splice(
    contract.profiles.full.indexOf("bundle-budget") + 1,
    0,
    "frontend-build",
  );
  writeJson(root, "validation/contract.json", contract);

  assert.match(
    validateValidationContract(root).join("\n"),
    /full validation profile must run frontend-build before bundle-budget so bundle inspection uses current artifacts/,
  );
});
