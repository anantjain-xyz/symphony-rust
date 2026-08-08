import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { validateAgentAssets } from "./check-agent-assets.mjs";

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeJson(root, path, value) {
  write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function skill(name, body) {
  return `---\nname: symphony-${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n\n${body}\n`;
}

function runtimeConsumerSource() {
  return `fn worker_start_config() {
  WorkerStartConfig { skills: bundled_skills() }
}

async fn start_retro() {
  let proposal_config = RetroProposalConfig {
    skills: bundled_skills().into_iter().map(transform_skill).collect(),
  };
  state
    .retro
    .start(state.repo.clone(), tracker, proposal_config);
}

async fn get_skills_status(repo_url: String, session_env: SessionEnv) {
  let names: Vec<String> = bundled_skills()
    .into_iter()
    .map(skill_name)
    .collect();
  check_skills(&repo_url, &names, &session_env);
}

async fn install_skills() {
  installer.start(SkillsInstallConfig { skills: bundled_skills() });
}

fn get_default_prompt() -> String {
  default_prompt_template()
}
`;
}

function defaultPromptContractConsumers() {
  return `struct AppSettings {
  #[serde(default = "default_prompt_template")]
  pub prompt_template: String,
}

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      prompt_template: default_prompt_template(),
    }
  }
}
`;
}

function defaultPromptRuntimeConsumers() {
  return `
pub fn parse_settings() {
  let prompt_template = None::<String>.unwrap_or_else(default_prompt_template);
}
`;
}

function harnessFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "symphony-agent-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const portableGate =
    "7. Re-run the target repository's documented validation gate before pushing.";
  const adaptedGate = "7. Re-run the local pre-push gate (`pnpm verify:fast`) before pushing.";
  const portablePushGate =
    "- The target repository's documented validation gate has been run for the latest commit.";
  const adaptedPushGate =
    "- The local pre-push gate has been run for the latest commit (`pnpm verify:fast`).";

  writeJson(root, "package.json", {
    scripts: {
      "verify:fast": "node scripts/run-validation.mjs fast",
      "verify:full": "node scripts/run-validation.mjs full",
    },
  });
  write(root, "src-tauri/assets/skills/commit/SKILL.md", skill("commit", "Commit carefully."));
  write(root, "src-tauri/assets/skills/pull/SKILL.md", skill("pull", portableGate));
  write(root, "src-tauri/assets/skills/push/SKILL.md", skill("push", portablePushGate));
  write(root, ".agents/skills/symphony-commit/SKILL.md", skill("commit", "Commit carefully."));
  write(root, ".agents/skills/symphony-pull/SKILL.md", skill("pull", adaptedGate));
  write(root, ".agents/skills/symphony-push/SKILL.md", skill("push", adaptedPushGate));
  write(root, ".claude/skills", "../.agents/skills");
  write(
    root,
    ".codex/skills/local/SKILL.md",
    "---\nname: local\ndescription: local fixture\n---\n\n# Local\n\nRun the local procedure.\n",
  );

  write(
    root,
    "src-tauri/src/lib.rs",
    `use settings::{default_prompt_template};

const SYMPHONY_SKILL_PREFIX: &str = "symphony-";

fn bundled_skills() {
  macro_rules! skill {
    ($name:literal) => {
      SkillFile {
        name: format!("{}{}", SYMPHONY_SKILL_PREFIX, $name),
        content: include_str!(concat!("../assets/skills/", $name, "/SKILL.md")).to_string(),
      }
    };
  }
  vec![skill!("commit"), skill!("pull"), skill!("push")]
}

${runtimeConsumerSource()}
`,
  );
  write(root, "src-tauri/src/settings.rs", defaultPromptRuntimeConsumers());
  write(
    root,
    "crates/symphony-contracts/src/settings.rs",
    `${defaultPromptContractConsumers()}

pub fn default_prompt_template() -> String {
  include_str!("../../../src-tauri/assets/default-prompt.md").to_string()
}
`,
  );
  write(root, "crates/fixture.rs", 'const FIXTURE: &str = "fixture";\n');
  write(
    root,
    "src-tauri/assets/default-prompt.md",
    `| Skill | Use when |
| --- | --- |
| \`symphony-commit\` | committing |
| \`symphony-pull\` | syncing |
| \`symphony-push\` | publishing |
`,
  );
  writeJson(root, "validation/agent-assets.json", {
    version: 1,
    rustSourceRoots: ["crates", "src-tauri"],
    skills: {
      ownerRoot: "src-tauri/assets/skills",
      inventoryFile: "src-tauri/src/lib.rs",
      inventoryFunction: "bundled_skills",
      projectionRoot: ".agents/skills",
      projectionPrefix: "symphony-",
      portableOwnerForbiddenPattern: "\\bpnpm\\b",
      discoveryProjection: {
        path: ".claude/skills",
        target: "../.agents/skills",
      },
      standaloneRoots: [".codex/skills"],
      allowedAdaptations: {
        pull: [{ match: portableGate, replacement: adaptedGate }],
        push: [{ match: portablePushGate, replacement: adaptedPushGate }],
      },
    },
    defaultPrompt: {
      path: "src-tauri/assets/default-prompt.md",
      returnFunction: "default_prompt_template",
      forbiddenNamespacePattern: "mcp__[A-Za-z0-9_-]+__",
    },
    pnpmBuiltins: ["add", "dlx", "exec", "install", "remove", "run"],
    forbiddenText: [],
  });
  return root;
}

test("accepts discovered owners, inventory, includes, and declared projections", (t) => {
  const root = harnessFixture(t);
  assert.deepEqual(validateAgentAssets(root), []);
});

test("accepts a symlink discovery projection", { skip: process.platform === "win32" }, (t) => {
  const root = harnessFixture(t);
  rmSync(join(root, ".claude/skills"));
  symlinkSync("../.agents/skills", join(root, ".claude/skills"), "dir");

  assert.deepEqual(validateAgentAssets(root), []);
});

test("rejects a discovery target that does not resolve to the projection root", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.skills.discoveryProjection = {
    path: ".claude/skills",
    target: "../unrelated/skills",
  };
  writeJson(root, "validation/agent-assets.json", contract);
  write(root, ".claude/skills", "../unrelated/skills");

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skill discovery projection target "\.\.\/unrelated\/skills" must resolve to skills\.projectionRoot "\.agents\/skills"/,
  );
});

test("accepts a projection prefix containing regex metacharacters", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  const prefix = "sym(phony)-";
  contract.skills.projectionPrefix = prefix;
  writeJson(root, "validation/agent-assets.json", contract);

  for (const skillId of ["commit", "pull", "push"]) {
    for (const path of [
      `src-tauri/assets/skills/${skillId}/SKILL.md`,
      `.agents/skills/symphony-${skillId}/SKILL.md`,
    ]) {
      const absolute = join(root, path);
      writeFileSync(
        absolute,
        readFileSync(absolute, "utf8").replaceAll(`symphony-${skillId}`, `${prefix}${skillId}`),
      );
    }
    const projection = readFileSync(
      join(root, `.agents/skills/symphony-${skillId}/SKILL.md`),
      "utf8",
    );
    write(root, `.agents/skills/${prefix}${skillId}/SKILL.md`, projection);
    rmSync(join(root, `.agents/skills/symphony-${skillId}`), { recursive: true, force: true });
  }

  const lib = join(root, "src-tauri/src/lib.rs");
  writeFileSync(
    lib,
    readFileSync(lib, "utf8").replace(
      'const SYMPHONY_SKILL_PREFIX: &str = "symphony-";',
      `const SYMPHONY_SKILL_PREFIX: &str = "${prefix}";`,
    ),
  );
  const prompt = join(root, "src-tauri/assets/default-prompt.md");
  writeFileSync(
    prompt,
    readFileSync(prompt, "utf8")
      .replaceAll("`symphony-commit`", "`sym(phony)-commit`")
      .replaceAll("`symphony-pull`", "`sym(phony)-pull`")
      .replaceAll("`symphony-push`", "`sym(phony)-push`"),
  );

  assert.deepEqual(validateAgentAssets(root), []);
});

test("applies adaptation replacements containing $$ literally", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  const match = "Commit carefully.";
  const replacement = "Commit carefully with shell pid $$.";
  contract.skills.allowedAdaptations.commit = [{ match, replacement }];
  writeJson(root, "validation/agent-assets.json", contract);
  write(root, ".agents/skills/symphony-commit/SKILL.md", skill("commit", replacement));

  assert.deepEqual(validateAgentAssets(root), []);
});

test("rejects an invalid Git-flattened discovery projection", (t) => {
  const root = harnessFixture(t);
  write(root, ".claude/skills", "../wrong/skills");

  assert.match(
    validateAgentAssets(root).join("\n"),
    /expected Git flattened symlink target "\.\.\/\.agents\/skills"/,
  );
});

test("requires discoveryProjection configuration", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  delete contract.skills.discoveryProjection;
  writeJson(root, "validation/agent-assets.json", contract);
  rmSync(join(root, ".claude/skills"));

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skills\.discoveryProjection must be an object/,
  );
});

test("rejects directory-valued inventoryFile before reading", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.skills.inventoryFile = "src-tauri/src";
  writeJson(root, "validation/agent-assets.json", contract);

  assert.match(
    validateAgentAssets(root).join("\n"),
    /bundled skill inventory at src-tauri\/src must be a regular file/,
  );
});

test("skips malformed adaptation entries after schema validation", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.skills.allowedAdaptations.pull = { match: "not", replacement: "an array" };
  contract.skills.allowedAdaptations.push = [null, { match: "x", replacement: "y" }];
  writeJson(root, "validation/agent-assets.json", contract);

  const errors = validateAgentAssets(root).join("\n");
  assert.match(errors, /skills\.allowedAdaptations\.pull must be an array/);
  assert.match(errors, /skills\.allowedAdaptations\.push\[0\] must be an object/);
  assert.doesNotMatch(errors, /TypeError/);
});

test("rejects directory-valued defaultPrompt.path before reading", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.defaultPrompt.path = "src-tauri/assets";
  writeJson(root, "validation/agent-assets.json", contract);

  assert.match(
    validateAgentAssets(root).join("\n"),
    /default prompt at src-tauri\/assets must be a regular file/,
  );
});

test("deduplicates files reached through overlapping rustSourceRoots", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.rustSourceRoots = ["crates", "crates/symphony-contracts", "src-tauri"];
  writeJson(root, "validation/agent-assets.json", contract);

  assert.deepEqual(validateAgentAssets(root), []);
});

test("deduplicates files reached through symlink-aliased rustSourceRoots", {
  skip: process.platform === "win32",
}, (t) => {
  const root = harnessFixture(t);
  symlinkSync("crates", join(root, "rust-alias"), "dir");
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.rustSourceRoots = ["crates", "rust-alias", "src-tauri"];
  writeJson(root, "validation/agent-assets.json", contract);

  assert.deepEqual(validateAgentAssets(root), []);
});

test("accepts relocated topology paths from the contract", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));

  for (const skillId of ["commit", "pull", "push"]) {
    const projection = readFileSync(
      join(root, `.agents/skills/symphony-${skillId}/SKILL.md`),
      "utf8",
    );
    write(root, `fixtures/projections/symphony-${skillId}/SKILL.md`, projection);
  }
  rmSync(join(root, ".agents/skills"), { recursive: true, force: true });
  write(root, "fixtures/discovery/skills", "../projections");
  rmSync(join(root, ".claude/skills"));
  write(
    root,
    "fixtures/standalone/local/SKILL.md",
    readFileSync(join(root, ".codex/skills/local/SKILL.md"), "utf8"),
  );
  rmSync(join(root, ".codex/skills"), { recursive: true, force: true });
  write(
    root,
    "fixtures/default-prompt.md",
    readFileSync(join(root, "src-tauri/assets/default-prompt.md"), "utf8"),
  );
  rmSync(join(root, "src-tauri/assets/default-prompt.md"));
  write(
    root,
    "crates/symphony-contracts/src/settings.rs",
    `${defaultPromptContractConsumers()}

pub fn default_prompt_template() -> String {
  include_str!("../../../fixtures/default-prompt.md").to_string()
}
`,
  );

  contract.skills.projectionRoot = "fixtures/projections";
  contract.skills.discoveryProjection = {
    path: "fixtures/discovery/skills",
    target: "../projections",
  };
  contract.skills.standaloneRoots = ["fixtures/standalone"];
  contract.defaultPrompt.path = "fixtures/default-prompt.md";
  writeJson(root, "validation/agent-assets.json", contract);

  assert.deepEqual(validateAgentAssets(root), []);
});

test("rejects every undeclared projection difference", (t) => {
  const root = harnessFixture(t);
  const projection = join(root, ".agents/skills/symphony-pull/SKILL.md");
  writeFileSync(projection, `${readFileSync(projection, "utf8")}Undeclared local edit.\n`);

  assert.match(
    validateAgentAssets(root).join("\n"),
    /differs from owner .* after declared adaptations .*declare every intentional projection change/,
  );
});

test("rejects adaptations that do not reconcile owners and projections", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.skills.allowedAdaptations.missing = [
    {
      match: "does not exist",
      replacement: "still missing",
    },
  ];
  contract.skills.allowedAdaptations.pull[0].replacement = "7. Skip validation before pushing.";
  writeJson(root, "validation/agent-assets.json", contract);

  const errors = validateAgentAssets(root).join("\n");
  assert.match(errors, /allowed adaptations declare unknown owner skill missing/);
  assert.match(
    errors,
    /differs from owner .* after declared adaptations .*declare every intentional projection change/,
  );
});

test("reports missing include_str targets with the owning Rust file", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "crates/symphony-contracts/src/settings.rs",
    `${defaultPromptContractConsumers()}

pub fn default_prompt_template() -> String {
  include_str!("../../../src-tauri/assets/missing-prompt.md").to_string()
}
`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /crates\/symphony-contracts\/src\/settings\.rs include_str! target is missing: src-tauri\/assets\/missing-prompt\.md/,
  );
  assert.match(
    errors,
    /default prompt src-tauri\/assets\/default-prompt\.md must have exactly one Rust include_str! owner; found 0/,
  );
});

test("requires every bundled skill owner to have one Rust include", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "src-tauri/src/lib.rs",
    `use settings::{default_prompt_template};

const SYMPHONY_SKILL_PREFIX: &str = "symphony-";

fn bundled_skills() {
  macro_rules! skill {
    ($name:literal) => {
      SkillFile {
        name: format!("{}{}", SYMPHONY_SKILL_PREFIX, $name),
        content: "".to_string(),
      }
    };
  }
  vec![skill!("commit"), skill!("pull")]
}
`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /bundled skill owner src-tauri\/assets\/skills\/commit\/SKILL\.md must have exactly one Rust include_str! owner; found 0/,
  );
  assert.match(
    errors,
    /bundled skill owner src-tauri\/assets\/skills\/pull\/SKILL\.md must have exactly one Rust include_str! owner; found 0/,
  );
});

test("ignores commented skill macros and accepts multiline inventory entries", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "src-tauri/src/lib.rs",
    `use settings::{default_prompt_template};

const SYMPHONY_SKILL_PREFIX: &str = "symphony-";

fn bundled_skills() {
  macro_rules! skill {
    ($name:literal) => {
      SkillFile {
        name: format!("{}{}", SYMPHONY_SKILL_PREFIX, $name),
        content: include_str!(concat!("../assets/skills/", $name, "/SKILL.md")).to_string(),
      }
    };
  }
  // skill!("removed")
  let text = r#"skill!("also-removed")"#;
  vec![
    skill!(
      "commit",
    ),
    skill!(
      "pull"
    ),
    skill!(
      "push"
    ),
  ]
}

${runtimeConsumerSource()}
`,
  );

  assert.deepEqual(validateAgentAssets(root), []);
});

test("scopes bundled inventory to the returned vector", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "src-tauri/src/lib.rs",
    `const SYMPHONY_SKILL_PREFIX: &str = "symphony-";

fn bundled_skills() {
  macro_rules! skill {
    ($name:literal) => {
      SkillFile {
        name: format!("{}{}", SYMPHONY_SKILL_PREFIX, $name),
        content: include_str!(concat!("../assets/skills/", $name, "/SKILL.md")).to_string(),
      }
    };
  }
  #[cfg(test)]
  let _ = skill!("pull");
  vec![skill!("commit")]
}
`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(errors, /Rust bundled skill inventory is missing pull/);
  assert.match(
    errors,
    /bundled skill owner src-tauri\/assets\/skills\/pull\/SKILL\.md must have exactly one Rust include_str! owner; found 0/,
  );
});

test("requires inventoryFunction configuration", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  delete contract.skills.inventoryFunction;
  writeJson(root, "validation/agent-assets.json", contract);

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skills\.inventoryFunction must be a non-empty string/,
  );
});

test("ties the validated skill inventory to every runtime consumer", (t) => {
  const root = harnessFixture(t);
  const source = join(root, "src-tauri/src/lib.rs");
  const original = readFileSync(source, "utf8");
  writeFileSync(
    source,
    original
      .replace(
        `fn worker_start_config() {
  WorkerStartConfig { skills: bundled_skills() }
}`,
        `fn worker_start_config() {
  let _decoy = WorkerStartConfig { skills: bundled_skills() };
  WorkerStartConfig { skills: empty_skills() }
}`,
      )
      .replace(
        `async fn start_retro() {
  let proposal_config = RetroProposalConfig {
    skills: bundled_skills().into_iter().map(transform_skill).collect(),
  };`,
        `async fn start_retro() {
  let _decoy = RetroProposalConfig {
    skills: bundled_skills().into_iter().map(transform_skill).collect(),
  };
  let proposal_config = RetroProposalConfig {
    skills: empty_skills().into_iter().map(transform_skill).collect(),
  };`,
      )
      .replace(
        `  let names: Vec<String> = bundled_skills()
    .into_iter()
    .map(skill_name)
    .collect();
  check_skills(&repo_url, &names, &session_env);`,
        `  let names: Vec<String> = bundled_skills()
    .into_iter()
    .map(skill_name)
    .collect();
  let names: Vec<String> = empty_skills()
    .into_iter()
    .map(skill_name)
    .collect();
  check_skills(&repo_url, &names, &session_env);`,
      )
      .replace(
        `async fn install_skills() {
  installer.start(SkillsInstallConfig { skills: bundled_skills() });
}`,
        `async fn install_skills() {
  let _decoy = SkillsInstallConfig { skills: bundled_skills() };
  installer.start(SkillsInstallConfig { skills: empty_skills() });
}`,
      ),
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /runtime consumer worker_start_config must set skills from bundled_skills \( \)/,
  );
  assert.match(
    errors,
    /runtime consumer start_retro must set skills from bundled_skills \( \) as its expression prefix/,
  );
  assert.match(
    errors,
    /get_skills_status must derive its single names binding from bundled_skills\(\)/,
  );
  assert.match(errors, /runtime consumer install_skills must set skills from bundled_skills \( \)/);
});

test("rejects conditional compilation inside bundled inventory", (t) => {
  const root = harnessFixture(t);
  const source = join(root, "src-tauri/src/lib.rs");
  writeFileSync(
    source,
    readFileSync(source, "utf8").replace(
      'vec![skill!("commit"), skill!("pull"), skill!("push")]',
      'vec![skill!("commit"), #[cfg(test)] skill!("pull"), skill!("push")]',
    ),
  );

  assert.match(
    validateAgentAssets(root).join("\n"),
    /bundled_skills returned inventory must not use conditional compilation; bundled inventory must be release-invariant/,
  );
});

test("ties bundled includes to the skill macro content field", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "src-tauri/src/lib.rs",
    `const SYMPHONY_SKILL_PREFIX: &str = "symphony-";

fn bundled_skills() {
  macro_rules! unused_skill_content {
    ($name:literal) => {
      include_str!(concat!("../assets/skills/", $name, "/SKILL.md"))
    };
  }
  macro_rules! skill {
    ($name:literal) => {
      SkillFile {
        name: format!("{}{}", SYMPHONY_SKILL_PREFIX, $name),
        content: "".to_string(),
      }
    };
  }
  vec![skill!("commit"), skill!("pull")]
}
`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(errors, /skill! content field must be include_str!\(\.\.\.\)\.to_string\(\)/);
  assert.match(errors, /src-tauri\/src\/lib\.rs has an unsupported include_str! expression/);
  assert.match(
    errors,
    /bundled skill owner src-tauri\/assets\/skills\/commit\/SKILL\.md must have exactly one Rust include_str! owner; found 0/,
  );
});

test("pins the runtime names produced by the bundled skill macro", (t) => {
  const root = harnessFixture(t);
  const source = join(root, "src-tauri/src/lib.rs");
  writeFileSync(
    source,
    readFileSync(source, "utf8").replace(
      'name: format!("{}{}", SYMPHONY_SKILL_PREFIX, $name),',
      "name: $name.to_string(),",
    ),
  );

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skill! name field must format a constant prefix followed by the literal skill id/,
  );
});

test("pins the runtime skill-name prefix to the projection prefix", (t) => {
  const root = harnessFixture(t);
  const source = join(root, "src-tauri/src/lib.rs");
  writeFileSync(
    source,
    readFileSync(source, "utf8").replace(
      'const SYMPHONY_SKILL_PREFIX: &str = "symphony-";',
      'const SYMPHONY_SKILL_PREFIX: &str = "wrong-";',
    ),
  );

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skill! runtime name prefix SYMPHONY_SKILL_PREFIX must be the single string literal "symphony-"/,
  );
});

test("discovers the default prompt owner instead of pinning its Rust path", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "crates/symphony-contracts/src/settings.rs",
    `${defaultPromptContractConsumers()}

pub use crate::prompt::default_prompt_template;
`,
  );
  write(
    root,
    "crates/symphony-contracts/src/prompt.rs",
    `pub fn default_prompt_template() -> String {
  include_str!("../../../src-tauri/assets/default-prompt.md").to_string()
}
`,
  );

  assert.deepEqual(validateAgentAssets(root), []);
});

test("ties the default prompt include to its runtime return expression", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "crates/symphony-contracts/src/settings.rs",
    `pub fn default_prompt_template() -> String {
  let _decoy = include_str!("../../../src-tauri/assets/default-prompt.md");
  String::new()
}
`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /settings\.rs default_prompt_template must directly return include_str!\("\.\.\."\)\.to_string\(\)/,
  );
});

test("ties the validated default prompt to settings and IPC consumers", (t) => {
  const root = harnessFixture(t);
  const contractSettings = join(root, "crates/symphony-contracts/src/settings.rs");
  writeFileSync(
    contractSettings,
    readFileSync(contractSettings, "utf8")
      .replace(
        '#[serde(default = "default_prompt_template")]',
        '#[serde(default = "empty_prompt")]',
      )
      .replace(
        `fn default() -> Self {
    Self {
      prompt_template: default_prompt_template(),
    }
  }`,
        `fn default() -> Self {
    let _decoy = Self {
      prompt_template: default_prompt_template(),
    };
    Self {
      prompt_template: empty_prompt(),
    }
  }`,
      ),
  );
  const runtimeSettings = join(root, "src-tauri/src/settings.rs");
  writeFileSync(
    runtimeSettings,
    readFileSync(runtimeSettings, "utf8").replace(
      `pub fn parse_settings() {
  let prompt_template = None::<String>.unwrap_or_else(default_prompt_template);
}`,
      `pub fn parse_settings() {
  let _decoy = None::<String>.unwrap_or_else(default_prompt_template);
  let prompt_template = None::<String>.unwrap_or_else(empty_prompt);
}`,
    ),
  );
  const desktop = join(root, "src-tauri/src/lib.rs");
  writeFileSync(
    desktop,
    readFileSync(desktop, "utf8")
      .replace("use settings::{default_prompt_template};", "use settings::{empty_prompt};")
      .replace(
        "fn get_default_prompt() -> String {\n  default_prompt_template()\n}",
        "fn get_default_prompt() -> String {\n  empty_prompt()\n}",
      ),
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /runtime consumer default must set prompt_template from default_prompt_template \( \)/,
  );
  assert.match(
    errors,
    /parse_settings must derive its single prompt_template binding with default_prompt_template/,
  );
  assert.match(
    errors,
    /AppSettings\.prompt_template must use serde default_prompt_template exactly once; found 0/,
  );
  assert.match(errors, /must import default_prompt_template from settings exactly once; found 0/);
  assert.match(errors, /get_default_prompt must directly return default_prompt_template\(\)/);
});

test("accepts CRLF skill frontmatter on Windows-style checkouts", (t) => {
  const root = harnessFixture(t);
  for (const path of [
    "src-tauri/assets/skills/commit/SKILL.md",
    "src-tauri/assets/skills/pull/SKILL.md",
    ".agents/skills/symphony-commit/SKILL.md",
    ".agents/skills/symphony-pull/SKILL.md",
  ]) {
    const absolute = join(root, path);
    writeFileSync(absolute, readFileSync(absolute, "utf8").replaceAll("\n", "\r\n"));
  }

  assert.deepEqual(validateAgentAssets(root), []);
});

test("rejects malformed YAML string scalars in skill frontmatter", (t) => {
  const root = harnessFixture(t);
  for (const path of [
    "src-tauri/assets/skills/commit/SKILL.md",
    ".agents/skills/symphony-commit/SKILL.md",
  ]) {
    const absolute = join(root, path);
    writeFileSync(
      absolute,
      readFileSync(absolute, "utf8").replace(
        "description: commit fixture",
        "description: [unterminated",
      ),
    );
  }
  for (const path of [
    "src-tauri/assets/skills/pull/SKILL.md",
    ".agents/skills/symphony-pull/SKILL.md",
  ]) {
    const absolute = join(root, path);
    writeFileSync(
      absolute,
      readFileSync(absolute, "utf8").replace("description: pull fixture", "description: true"),
    );
  }

  const errors = validateAgentAssets(root).join("\n");
  assert.match(errors, /description must be a valid string scalar in the supported YAML subset/);
  assert.match(
    errors,
    /symphony-pull\/SKILL\.md frontmatter line 3 description must be a valid string scalar/,
  );
});

test("requires an instructional body in every discovered skill manifest", (t) => {
  const root = harnessFixture(t);
  const emptyBundled = `---
name: symphony-commit
description: empty bundled fixture
---

`;
  write(root, "src-tauri/assets/skills/commit/SKILL.md", emptyBundled);
  write(root, ".agents/skills/symphony-commit/SKILL.md", emptyBundled);

  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.skills.standaloneRoots = [".codex/skills"];
  writeJson(root, "validation/agent-assets.json", contract);
  write(
    root,
    ".codex/skills/local/SKILL.md",
    `---
name: local
description: empty standalone fixture
---

<!-- A comment is not an instructional body. -->
`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /src-tauri\/assets\/skills\/commit\/SKILL\.md must contain a non-empty Markdown instructional body/,
  );
  assert.match(
    errors,
    /\.agents\/skills\/symphony-commit\/SKILL\.md must contain a non-empty Markdown instructional body/,
  );
  assert.match(
    errors,
    /\.codex\/skills\/local\/SKILL\.md must contain a non-empty Markdown instructional body/,
  );
});

test("requires standaloneRoots configuration", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  delete contract.skills.standaloneRoots;
  writeJson(root, "validation/agent-assets.json", contract);
  write(
    root,
    ".codex/skills/local/SKILL.md",
    "---\nname: local\ndescription: malformed standalone fixture\n---\n",
  );

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skills\.standaloneRoots must be an array of non-empty strings/,
  );
});

test("forbids every pnpm reference in portable owner manifests only", (t) => {
  const root = harnessFixture(t);
  for (const path of [
    "src-tauri/assets/skills/commit/SKILL.md",
    ".agents/skills/symphony-commit/SKILL.md",
  ]) {
    const absolute = join(root, path);
    writeFileSync(absolute, `${readFileSync(absolute, "utf8")}Run \`pnpm install\`.\n`);
  }

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /src-tauri\/assets\/skills\/commit\/SKILL\.md:\d+ portable bundled skill owners must not reference pnpm/,
  );
  assert.doesNotMatch(
    errors,
    /\.agents\/skills\/symphony-commit\/SKILL\.md:\d+ portable bundled skill owners must not reference pnpm/,
  );
});

test("requires portableOwnerForbiddenPattern configuration", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  delete contract.skills.portableOwnerForbiddenPattern;
  writeJson(root, "validation/agent-assets.json", contract);

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skills\.portableOwnerForbiddenPattern must be a non-empty string/,
  );
});

test("uses configured pnpmBuiltins for script validation", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.pnpmBuiltins.push("custom-builtin");
  writeJson(root, "validation/agent-assets.json", contract);
  const prompt = join(root, "src-tauri/assets/default-prompt.md");
  writeFileSync(
    prompt,
    `${readFileSync(prompt, "utf8")}
Run \`pnpm custom-builtin\`, not \`pnpm definitely-missing\`.
`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.doesNotMatch(errors, /references missing package script pnpm custom-builtin/);
  assert.match(
    errors,
    /default-prompt\.md:\d+ references missing package script pnpm definitely-missing/,
  );
});

test("rejects companion files that the bundled skill runtime cannot ship", (t) => {
  const root = harnessFixture(t);
  write(root, "src-tauri/assets/skills/commit/scripts/helper.sh", "#!/bin/sh\n");

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skill owner root skill commit contains unbundled companion .*scripts; bundled skills may contain only SKILL\.md/,
  );
});

test("rejects hard-coded MCP namespaces in the default prompt", (t) => {
  const root = harnessFixture(t);
  const prompt = join(root, "src-tauri/assets/default-prompt.md");
  writeFileSync(prompt, `${readFileSync(prompt, "utf8")}\nUse mcp__linear-server__save_comment.\n`);

  assert.match(
    validateAgentAssets(root).join("\n"),
    /hard-codes MCP namespace mcp__linear-server__; describe the capability without assuming a server name/,
  );
});

test("requires the default prompt skill table to remain visible", (t) => {
  const root = harnessFixture(t);
  const prompt = join(root, "src-tauri/assets/default-prompt.md");
  writeFileSync(prompt, `<!--\n${readFileSync(prompt, "utf8")}-->\n`);

  const errors = validateAgentAssets(root).join("\n");
  assert.match(errors, /default prompt skill table is missing symphony-commit/);
  assert.match(errors, /default prompt skill table is missing symphony-pull/);
});

test("requires defaultPrompt.forbiddenNamespacePattern configuration", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  delete contract.defaultPrompt.forbiddenNamespacePattern;
  writeJson(root, "validation/agent-assets.json", contract);

  assert.match(
    validateAgentAssets(root).join("\n"),
    /defaultPrompt\.forbiddenNamespacePattern must be a non-empty string/,
  );
});

test("validates the script named after pnpm run in agent Markdown", (t) => {
  const root = harnessFixture(t);
  const prompt = join(root, "src-tauri/assets/default-prompt.md");
  writeFileSync(
    prompt,
    `${readFileSync(prompt, "utf8")}
Run \`pnpm run verify:full\`, not \`pnpm run definitely-missing\`.
`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /default-prompt\.md:\d+ references missing package script pnpm run definitely-missing/,
  );
  assert.doesNotMatch(errors, /references missing package script pnpm run verify:full/);
});
