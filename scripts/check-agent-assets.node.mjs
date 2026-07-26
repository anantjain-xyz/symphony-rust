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
  mkdirSync(join(root, ".claude"), { recursive: true });
  symlinkSync("../.agents/skills", join(root, ".claude/skills"), "dir");

  write(
    root,
    "src-tauri/src/lib.rs",
    `macro_rules! skill {
  ($name:literal) => {
    include_str!(concat!("../assets/skills/", $name, "/SKILL.md"))
  };
}
fn bundled() {
  let _ = [skill!("commit"), skill!("pull")];
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

test("ignores commented skill macros and accepts multiline inventory entries", (t) => {
  const root = harnessFixture(t);
  write(
    root,
    "src-tauri/src/lib.rs",
    `macro_rules! skill {
  ($name:literal) => {
    include_str!(concat!("../assets/skills/", $name, "/SKILL.md"))
  };
}
fn bundled() {
  // skill!("removed")
  let text = r#"skill!("also-removed")"#;
  let _ = [
    skill!(
      "commit",
    ),
    skill!(
      "pull"
    ),
  ];
}
`,
  );

  assert.deepEqual(validateAgentAssets(root), []);
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
