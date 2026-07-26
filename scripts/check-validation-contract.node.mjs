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
import { validateValidationContract } from "./check-validation-contract.mjs";

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
      "check:harness": "node scripts/check-agent-assets.mjs",
      "test:validation": "node --test scripts/fixture.node.mjs",
      "test:e2e": "playwright test",
      "verify:fast": "node scripts/run-validation.mjs fast",
      "verify:full": "node scripts/run-validation.mjs full",
    },
    devDependencies: {
      "@playwright/test": "1.0.0",
    },
  });
  for (const path of [
    "scripts/check-validation-contract.mjs",
    "scripts/check-agent-assets.mjs",
    "scripts/fixture.node.mjs",
    "scripts/run-validation.mjs",
  ]) {
    write(root, path, "\n");
  }
  write(
    root,
    ".github/workflows/ci.yml",
    "steps:\n  - run: pnpm verify:full\n",
  );
  write(
    root,
    "CONTRIBUTING.md",
    "`pnpm verify:fast`\n\n`pnpm verify:full`\n",
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
    executables: ["pnpm"],
    entrypoints: {
      fast: { packageScript: "verify:fast", profile: "fast" },
      full: { packageScript: "verify:full", profile: "full" },
    },
    profiles: {
      fast: ["contract", "harness", "checker-tests"],
      full: ["contract", "harness", "checker-tests", "browser-install", "browser"],
    },
    commands: {
      contract: {
        label: "contract",
        argv: ["pnpm", "check:validation-contract"],
        packageScript: "check:validation-contract",
      },
      harness: {
        label: "harness",
        argv: ["pnpm", "check:harness"],
        packageScript: "check:harness",
      },
      "checker-tests": {
        label: "checker tests",
        argv: ["pnpm", "test:validation"],
        packageScript: "test:validation",
      },
      "browser-install": {
        label: "browser install",
        argv: ["pnpm", "exec", "playwright", "install", "chromium"],
        installsBrowser: true,
      },
      browser: {
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
    /validation command harness references missing package script check:harness/,
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
    "steps:\n  - run: pnpm test:e2e\n",
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

test("rejects recursive scripts and unsupported shell syntax descriptively", (t) => {
  const root = validationFixture(t);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson.scripts["check:cycle"] = "pnpm check:cycle";
  packageJson.scripts["test:unsafe"] = "node scripts/fixture.node.mjs | tee result.txt";
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
  contract.profiles.full.push("cycle", "unsafe");
  writeJson(root, "validation/contract.json", contract);

  const errors = validateValidationContract(root).join("\n");
  assert.match(errors, /package scripts contain a cycle: check:cycle -> check:cycle/);
  assert.match(errors, /package script test:unsafe uses unsupported shell syntax/);
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
    /browser command browser must follow a command with installsBrowser in the full profile/,
  );
});
