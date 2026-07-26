import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function harnessFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "symphony-agent-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const portableGate =
    "7. Re-run the target repository's documented validation gate before pushing.";
  const adaptedGate =
    "7. Re-run validation (`pnpm verify:full`) before pushing.";

  writeJson(root, "package.json", {
    scripts: {
      "verify:full": "node scripts/run-validation.mjs full",
    },
  });
  write(
    root,
    "src-tauri/assets/skills/commit/SKILL.md",
    skill("commit", "Commit carefully."),
  );
  write(
    root,
    "src-tauri/assets/skills/pull/SKILL.md",
    skill("pull", portableGate),
  );
  write(
    root,
    ".agents/skills/symphony-commit/SKILL.md",
    skill("commit", "Commit carefully."),
  );
  write(
    root,
    ".agents/skills/symphony-pull/SKILL.md",
    skill("pull", adaptedGate),
  );
  write(root, ".claude/skills", "../.agents/skills");

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
  vec![skill!("commit"), skill!("pull")]
}
`,
  );
  write(
    root,
    "src-tauri/src/settings.rs",
    'const PROMPT: &str = include_str!("../assets/default-prompt.md");\n',
  );
  write(
    root,
    "src-tauri/assets/default-prompt.md",
    `| Skill | Use when |
| --- | --- |
| \`symphony-commit\` | committing |
| \`symphony-pull\` | syncing |
`,
  );
  writeJson(root, "validation/agent-assets.json", {
    version: 1,
    rustSourceRoots: ["src-tauri"],
    skills: {
      ownerRoot: "src-tauri/assets/skills",
      inventoryFile: "src-tauri/src/lib.rs",
      inventoryFunction: "bundled_skills",
      projectionRoot: ".agents/skills",
      projectionPrefix: "symphony-",
      discoveryProjection: {
        path: ".claude/skills",
        target: "../.agents/skills",
      },
      standaloneRoots: [],
      allowedAdaptations: {
        pull: [{ match: portableGate, replacement: adaptedGate }],
      },
    },
    defaultPrompt: {
      path: "src-tauri/assets/default-prompt.md",
      forbiddenNamespacePattern: "mcp__[A-Za-z0-9_-]+__",
    },
    pnpmBuiltins: ["install", "exec"],
    forbiddenText: [
      {
        paths: ["src-tauri/assets/skills"],
        pattern: "pnpm (?:format:check|lint)",
        message: "portable assets must not assume pnpm scripts",
      },
    ],
  });
  return root;
}

test("accepts discovered owners, inventory, includes, and declared projections", (t) => {
  const root = harnessFixture(t);
  assert.deepEqual(validateAgentAssets(root), []);
});

test(
  "accepts a symlink discovery projection",
  { skip: process.platform === "win32" },
  (t) => {
    const root = harnessFixture(t);
    rmSync(join(root, ".claude/skills"));
    symlinkSync("../.agents/skills", join(root, ".claude/skills"), "dir");

    assert.deepEqual(validateAgentAssets(root), []);
  },
);

test("rejects an invalid Git-flattened discovery projection", (t) => {
  const root = harnessFixture(t);
  write(root, ".claude/skills", "../wrong/skills");

  assert.match(
    validateAgentAssets(root).join("\n"),
    /expected Git flattened symlink target "\.\.\/\.agents\/skills"/,
  );
});

test("rejects every undeclared projection difference", (t) => {
  const root = harnessFixture(t);
  const projection = join(
    root,
    ".agents/skills/symphony-pull/SKILL.md",
  );
  writeFileSync(
    projection,
    `${readFileSync(projection, "utf8")}Undeclared local edit.\n`,
  );

  assert.match(
    validateAgentAssets(root).join("\n"),
    /differs from owner .* after declared adaptations .*declare every intentional projection change/,
  );
});

test("pins allowed adaptations to the validation-gate substitutions", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.skills.allowedAdaptations.commit = [
    {
      match: "Commit carefully.",
      replacement: "Bypass verification hooks.",
    },
  ];
  contract.skills.allowedAdaptations.pull[0].replacement =
    "7. Skip validation before pushing.";
  writeJson(root, "validation/agent-assets.json", contract);
  write(
    root,
    ".agents/skills/symphony-commit/SKILL.md",
    skill("commit", "Bypass verification hooks."),
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /allowed adaptation skill ids has undeclared extra commit/,
  );
  assert.match(
    errors,
    /allowed adaptations for pull must be the exact validation-gate substitution/,
  );
});

test("reports missing include_str targets with the owning Rust file", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "src-tauri/src/settings.rs",
    'const PROMPT: &str = include_str!("../assets/missing-prompt.md");\n',
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /src-tauri\/src\/settings\.rs include_str! target is missing: src-tauri\/assets\/missing-prompt\.md/,
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
    `const SYMPHONY_SKILL_PREFIX: &str = "symphony-";

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
  // skill!("removed")
  let text = r#"skill!("also-removed")"#;
  vec![
    skill!(
      "commit",
    ),
    skill!(
      "pull"
    ),
  ]
}
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

test("pins inventory discovery to bundled_skills", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.skills.inventoryFunction = "decoy_inventory";
  writeJson(root, "validation/agent-assets.json", contract);

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skill inventoryFunction must be bundled_skills, received "decoy_inventory"/,
  );
});

test("rejects conditional compilation inside bundled inventory", (t) => {
  const root = harnessFixture(t);
  const source = join(root, "src-tauri/src/lib.rs");
  writeFileSync(
    source,
    readFileSync(source, "utf8").replace(
      'vec![skill!("commit"), skill!("pull")]',
      'vec![skill!("commit"), #[cfg(test)] skill!("pull")]',
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
  assert.match(
    errors,
    /skill! content field must be include_str!\(\.\.\.\)\.to_string\(\)/,
  );
  assert.match(
    errors,
    /src-tauri\/src\/lib\.rs has an unsupported include_str! expression/,
  );
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
  write(root, "src-tauri/src/settings.rs", "const SETTINGS: &str = \"settings\";\n");
  write(
    root,
    "src-tauri/src/prompt.rs",
    'const PROMPT: &str = include_str!("../assets/default-prompt.md");\n',
  );

  assert.deepEqual(validateAgentAssets(root), []);
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
      readFileSync(absolute, "utf8").replace(
        "description: pull fixture",
        "description: true",
      ),
    );
  }

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /description must be a valid string scalar in the supported YAML subset/,
  );
  assert.match(
    errors,
    /symphony-pull\/SKILL\.md frontmatter line 3 description must be a valid string scalar/,
  );
});

test("rejects companion files that the bundled skill runtime cannot ship", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "src-tauri/assets/skills/commit/scripts/helper.sh",
    "#!/bin/sh\n",
  );

  assert.match(
    validateAgentAssets(root).join("\n"),
    /skill owner root skill commit contains unbundled companion .*scripts; bundled skills may contain only SKILL\.md/,
  );
});

test("rejects hard-coded MCP namespaces in the default prompt", (t) => {
  const root = harnessFixture(t);
  const prompt = join(root, "src-tauri/assets/default-prompt.md");
  writeFileSync(
    prompt,
    `${readFileSync(prompt, "utf8")}\nUse mcp__linear-server__save_comment.\n`,
  );

  assert.match(
    validateAgentAssets(root).join("\n"),
    /hard-codes MCP namespace mcp__linear-server__; describe the capability without assuming a server name/,
  );
});

test("requires the default prompt skill table to remain visible", (t) => {
  const root = harnessFixture(t);
  const prompt = join(root, "src-tauri/assets/default-prompt.md");
  writeFileSync(
    prompt,
    `<!--\n${readFileSync(prompt, "utf8")}-->\n`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(errors, /default prompt skill table is missing symphony-commit/);
  assert.match(errors, /default prompt skill table is missing symphony-pull/);
});

test("requires the portable MCP namespace policy", (t) => {
  const root = harnessFixture(t);
  const contractPath = join(root, "validation/agent-assets.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  delete contract.defaultPrompt.forbiddenNamespacePattern;
  writeJson(root, "validation/agent-assets.json", contract);
  const prompt = join(root, "src-tauri/assets/default-prompt.md");
  writeFileSync(
    prompt,
    `${readFileSync(prompt, "utf8")}\nUse mcp__linear-server__save_comment.\n`,
  );

  const errors = validateAgentAssets(root).join("\n");
  assert.match(
    errors,
    /defaultPrompt forbiddenNamespacePattern must be "mcp__\[A-Za-z0-9_-\]\+__", received undefined/,
  );
  assert.match(
    errors,
    /hard-codes MCP namespace mcp__linear-server__; describe the capability without assuming a server name/,
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
  assert.doesNotMatch(
    errors,
    /references missing package script pnpm run verify:full/,
  );
});
