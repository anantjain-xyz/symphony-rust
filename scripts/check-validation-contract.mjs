import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SCRIPT = "scripts/run-validation.mjs";
const DEVELOPMENT_GUIDE = "docs/DEVELOPMENT.md";
export const CANONICAL_RUNNER_SOURCE = `import { runValidationProfile } from "./check-validation-contract.mjs";

process.exitCode = runValidationProfile({ profileName: process.argv[2] });
`;
const REQUIRED_FAST_COMMANDS = new Set([
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
]);
const REQUIRED_FULL_COMMANDS = new Map([
  [
    "validation-contract",
    {
      argv: ["pnpm", "check:validation-contract"],
      packageScript: "check:validation-contract",
    },
  ],
  [
    "agent-assets",
    {
      argv: ["pnpm", "check:harness"],
      packageScript: "check:harness",
    },
  ],
  [
    "validation-tests",
    {
      argv: ["pnpm", "test:validation"],
      packageScript: "test:validation",
    },
  ],
  [
    "frontend-contracts",
    {
      argv: ["pnpm", "check:frontend-contracts"],
      packageScript: "check:frontend-contracts",
    },
  ],
  [
    "frontend-contract-tests",
    {
      argv: ["pnpm", "test:frontend-contracts"],
      packageScript: "test:frontend-contracts",
    },
  ],
  [
    "rust-format",
    {
      argv: ["cargo", "fmt", "--all", "--check"],
    },
  ],
  [
    "rust-clippy",
    {
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
  ],
  [
    "rust-tests",
    {
      argv: [
        "cargo",
        "test",
        "--workspace",
        "--exclude",
        "symphony-desktop",
      ],
    },
  ],
  [
    "frontend-typecheck",
    {
      argv: ["pnpm", "typecheck"],
      packageScript: "typecheck",
    },
  ],
  [
    "frontend-tests",
    {
      argv: ["pnpm", "test"],
      packageScript: "test",
    },
  ],
  [
    "frontend-build",
    {
      argv: ["pnpm", "build"],
      packageScript: "build",
    },
  ],
  [
    "bundle-budget",
    {
      argv: ["pnpm", "check:bundle"],
      packageScript: "check:bundle",
    },
  ],
  [
    "bundle-tests",
    {
      argv: ["pnpm", "test:bundle"],
      packageScript: "test:bundle",
    },
  ],
  [
    "browser-install",
    {
      argv: [
        "pnpm",
        "exec",
        "playwright",
        "install",
        "--with-deps",
        "chromium",
      ],
    },
  ],
  [
    "browser-e2e",
    {
      argv: ["pnpm", "test:e2e"],
      packageScript: "test:e2e",
      requiresBrowser: true,
    },
  ],
]);
const REQUIRED_PACKAGE_SCRIPTS = new Map([
  [
    "check:validation-contract",
    "node scripts/check-validation-contract.mjs",
  ],
  ["check:harness", "node scripts/check-agent-assets.mjs"],
  [
    "test:validation",
    "node --test scripts/check-agent-assets.node.mjs scripts/check-validation-contract.node.mjs",
  ],
  [
    "check:frontend-contracts",
    "pnpm check:frontend-boundaries && pnpm check:preview-coverage",
  ],
  [
    "check:frontend-boundaries",
    "node scripts/check-frontend-boundaries.mjs",
  ],
  [
    "check:preview-coverage",
    "node scripts/check-preview-coverage.mjs",
  ],
  [
    "test:frontend-contracts",
    "node --test scripts/check-frontend-boundaries.node.mjs scripts/check-preview-coverage.node.mjs && vitest run src/desktop/events.test.ts src/dashboardRefreshCoordinator.test.ts src/pollController.test.ts src/settingsValidationController.test.ts",
  ],
  ["typecheck", "tsc --noEmit"],
  ["test", "vitest run"],
  ["build", "tsc && vite build"],
  ["check:bundle", "node scripts/check-bundle-budget.mjs"],
  ["test:bundle", "node --test scripts/check-bundle-budget.node.mjs"],
  ["test:e2e", "playwright test"],
]);
const SUPPORTED_SCRIPT_EXECUTABLES = new Map([
  ["biome", ["@biomejs/biome"]],
  ["cargo", null],
  ["node", null],
  ["playwright", ["@playwright/test", "playwright"]],
  ["tsc", ["typescript"]],
  ["vite", ["vite"]],
  ["vitest", ["vitest"]],
]);

function readJson(root, path, errors, label) {
  const absolute = resolveInside(root, path, errors, label);
  if (!absolute || !existsSync(absolute)) {
    if (absolute) errors.push(`${label} is missing at ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    errors.push(`${label} at ${path} is not valid JSON: ${error.message}`);
    return null;
  }
}

function resolveInside(root, path, errors, label) {
  if (typeof path !== "string" || path.trim() === "") {
    errors.push(`${label} must be a non-empty repository-relative path`);
    return null;
  }
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    errors.push(`${label} escapes the repository root: ${path}`);
    return null;
  }
  return absolute;
}

function duplicates(items) {
  const seen = new Set();
  const repeated = new Set();
  for (const item of items) {
    if (seen.has(item)) repeated.add(item);
    seen.add(item);
  }
  return [...repeated].sort();
}

function parseSimpleShellScript(script, scriptName, errors) {
  const commands = [];
  let tokens = [];
  let token = "";
  let tokenStarted = false;
  let quote = null;
  let escaped = false;

  const finishToken = () => {
    if (tokenStarted) tokens.push(token);
    token = "";
    tokenStarted = false;
  };
  const finishCommand = () => {
    finishToken();
    if (tokens.length === 0) {
      errors.push(`package script ${scriptName} contains an empty command`);
    } else {
      commands.push(tokens);
    }
    tokens = [];
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    const next = script[index + 1];
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      tokenStarted = true;
      quote = character;
      continue;
    }
    if (character === "#" && !tokenStarted) {
      errors.push(
        `package script ${scriptName} uses unsupported shell comment syntax near "#"; validation scripts may not contain unquoted comments`,
      );
      return [];
    }
    if (character === "\n" || character === "\r") {
      errors.push(
        `package script ${scriptName} uses unsupported shell line break; validation scripts may use argv commands joined only with &&`,
      );
      return [];
    }
    if (character === "&" && next === "&") {
      finishCommand();
      index += 1;
      continue;
    }
    if (
      character === "&" ||
      character === ";" ||
      character === "|" ||
      character === ">" ||
      character === "<" ||
      character === "`" ||
      (character === "$" && next === "(")
    ) {
      errors.push(
        `package script ${scriptName} uses unsupported shell syntax near ${JSON.stringify(
          script.slice(index, index + 2).trim(),
        )}; validation scripts may use argv commands joined only with &&`,
      );
      return [];
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (quote) {
    errors.push(`package script ${scriptName} has an unterminated ${quote} quote`);
    return [];
  }
  if (escaped) {
    errors.push(`package script ${scriptName} ends with an incomplete escape`);
    return [];
  }
  finishCommand();
  return commands;
}

function validatePackageExecutable(
  root,
  scriptName,
  tokens,
  packageJson,
  errors,
) {
  const executable = tokens[0];
  if (!SUPPORTED_SCRIPT_EXECUTABLES.has(executable)) {
    errors.push(
      `package script ${scriptName} uses unsupported executable ${JSON.stringify(
        executable,
      )}; teach check-validation-contract.mjs how to validate it`,
    );
    return;
  }

  const packages = SUPPORTED_SCRIPT_EXECUTABLES.get(executable);
  if (packages) {
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    if (!packages.some((name) => dependencies?.[name])) {
      errors.push(
        `package script ${scriptName} invokes ${executable}, but none of ${packages.join(
          ", ",
        )} is declared in package.json`,
      );
    }
  }

  if (executable === "node") {
    for (const token of tokens.slice(1)) {
      if (token.startsWith("-") || !/\.(?:c?js|mjs)$/.test(token)) continue;
      const target = resolveInside(
        root,
        token,
        errors,
        `file referenced by package script ${scriptName}`,
      );
      if (target && !existsSync(target)) {
        errors.push(`package script ${scriptName} references missing file ${token}`);
      }
    }
  }
}

function validatePackageScript(
  root,
  scriptName,
  packageJson,
  errors,
  validated = new Set(),
  stack = [],
) {
  if (validated.has(scriptName)) return;
  if (stack.includes(scriptName)) {
    errors.push(
      `package scripts contain a cycle: ${[...stack, scriptName].join(" -> ")}`,
    );
    return;
  }
  const body = packageJson.scripts?.[scriptName];
  if (typeof body !== "string" || body.trim() === "") {
    errors.push(`package script ${scriptName} is missing or empty`);
    return;
  }

  const nextStack = [...stack, scriptName];
  for (const tokens of parseSimpleShellScript(body, scriptName, errors)) {
    if (tokens[0] !== "pnpm") {
      validatePackageExecutable(root, scriptName, tokens, packageJson, errors);
      continue;
    }

    const referenced =
      tokens[1] === "run" && tokens.length === 3
        ? tokens[2]
        : tokens.length === 2
          ? tokens[1]
          : null;
    if (!referenced) {
      errors.push(
        `package script ${scriptName} must invoke another package script as "pnpm <name>" or "pnpm run <name>"`,
      );
      continue;
    }
    if (!packageJson.scripts?.[referenced]) {
      errors.push(
        `package script ${scriptName} references missing package script ${referenced}`,
      );
      continue;
    }
    validatePackageScript(
      root,
      referenced,
      packageJson,
      errors,
      validated,
      nextStack,
    );
  }
  validated.add(scriptName);
}

function isValidationPackageScript(scriptName) {
  return (
    scriptName === "check" ||
    scriptName.startsWith("check:") ||
    scriptName === "test" ||
    scriptName.startsWith("test:")
  );
}

function exactRunLine(command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*-\\s+run:\\s*${escaped}\\s*$`, "gm");
}

function stripMarkdownHtmlComments(content) {
  let visible = "";
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf("<!--", cursor);
    if (start === -1) return visible + content.slice(cursor);
    visible += content.slice(cursor, start);
    const end = content.indexOf("-->", start + 4);
    if (end === -1) return visible;
    cursor = end + 3;
  }
  return visible;
}

function hasMarkdownCommandLine(content, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:\\$\\s*)?${escaped}\\s*$`, "m").test(
    stripMarkdownHtmlComments(content),
  );
}

function yamlIndent(line) {
  return line.match(/^ */)[0].length;
}

function previousYamlParent(lines, index, childIndent) {
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const line = lines[candidate];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = yamlIndent(line);
    if (indent < childIndent) {
      return { index: candidate, indent, text: line.trim() };
    }
  }
  return null;
}

function validateCiRunStep(content, command, workflowPath, errors) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const runPattern = new RegExp(`^( *)-\\s+run:\\s*${escaped}\\s*$`);
  const lines = content.replace(/\r\n?/g, "\n").split("\n");

  for (const [lineIndex, line] of lines.entries()) {
    const match = runPattern.exec(line);
    if (!match) continue;
    const stepIndent = match[1].length;
    const steps = previousYamlParent(lines, lineIndex, stepIndent);
    if (
      !steps ||
      steps.indent !== stepIndent - 2 ||
      steps.text !== "steps:"
    ) {
      errors.push(
        `CI workflow ${workflowPath} canonical entrypoint must be a direct workflow step under steps`,
      );
      continue;
    }

    const job = previousYamlParent(lines, steps.index, steps.indent);
    if (
      !job ||
      job.indent !== steps.indent - 2 ||
      !/^[A-Za-z_][A-Za-z0-9_-]*:$/.test(job.text)
    ) {
      errors.push(
        `CI workflow ${workflowPath} canonical entrypoint must belong to a job`,
      );
      continue;
    }

    let stepEnd = lines.length;
    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      if (lines[index].trim() === "") continue;
      if (yamlIndent(lines[index]) <= stepIndent) {
        stepEnd = index;
        break;
      }
    }
    for (let index = lineIndex + 1; index < stepEnd; index += 1) {
      if (
        yamlIndent(lines[index]) === stepIndent + 2 &&
        /^(?:if|continue-on-error)\s*:/.test(lines[index].trim())
      ) {
        errors.push(
          `CI workflow ${workflowPath} canonical entrypoint step must be unconditional and failure-gating; remove ${lines[
            index
          ]
            .trim()
            .split(":")[0]}`,
        );
      }
    }

    let jobEnd = lines.length;
    for (let index = job.index + 1; index < lines.length; index += 1) {
      if (lines[index].trim() === "") continue;
      if (yamlIndent(lines[index]) <= job.indent) {
        jobEnd = index;
        break;
      }
    }
    for (let index = job.index + 1; index < jobEnd; index += 1) {
      if (
        yamlIndent(lines[index]) === steps.indent &&
        /^(?:if|continue-on-error)\s*:/.test(lines[index].trim())
      ) {
        const field = lines[index].trim().split(":")[0];
        errors.push(
          `CI workflow ${workflowPath} canonical entrypoint job must be unconditional and failure-gating; remove ${field}`,
        );
      }
    }
  }
}

function validateCiTriggers(content, workflowPath, errors) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const triggerBlocks = lines
    .map((line, index) => ({ index, line }))
    .filter(
      ({ line }) => yamlIndent(line) === 0 && line.trim() === "on:",
    );
  if (triggerBlocks.length !== 1) {
    errors.push(
      `CI workflow ${workflowPath} must define exactly one top-level on trigger block; found ${triggerBlocks.length}`,
    );
    return;
  }

  const triggerStart = triggerBlocks[0].index;
  let triggerEnd = lines.length;
  for (let index = triggerStart + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "" || lines[index].trimStart().startsWith("#")) {
      continue;
    }
    if (yamlIndent(lines[index]) === 0) {
      triggerEnd = index;
      break;
    }
  }

  const directTriggers = new Map();
  for (let index = triggerStart + 1; index < triggerEnd; index += 1) {
    const line = lines[index];
    if (
      line.trim() === "" ||
      line.trimStart().startsWith("#") ||
      yamlIndent(line) !== 2
    ) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line.trim());
    if (!match) continue;
    const indexes = directTriggers.get(match[1]) ?? [];
    indexes.push(index);
    directTriggers.set(match[1], indexes);
  }

  const pullRequestIndexes = directTriggers.get("pull_request") ?? [];
  if (pullRequestIndexes.length !== 1) {
    errors.push(
      `CI workflow ${workflowPath} must trigger every pull_request without filters`,
    );
  } else {
    const pullRequestIndex = pullRequestIndexes[0];
    const nextTriggerIndex = [...directTriggers.values()]
      .flat()
      .filter((index) => index > pullRequestIndex)
      .sort((left, right) => left - right)[0];
    const pullRequestEnd = nextTriggerIndex ?? triggerEnd;
    const filters = lines
      .slice(pullRequestIndex + 1, pullRequestEnd)
      .filter(
        (line) =>
          line.trim() !== "" && !line.trimStart().startsWith("#"),
      );
    if (filters.length > 0) {
      errors.push(
        `CI workflow ${workflowPath} must trigger every pull_request without filters`,
      );
    }
  }

  const pushIndexes = directTriggers.get("push") ?? [];
  if (pushIndexes.length !== 1) {
    errors.push(
      `CI workflow ${workflowPath} must trigger pushes to main with branches: [main] and no filters`,
    );
  } else {
    const pushIndex = pushIndexes[0];
    const nextTriggerIndex = [...directTriggers.values()]
      .flat()
      .filter((index) => index > pushIndex)
      .sort((left, right) => left - right)[0];
    const pushEnd = nextTriggerIndex ?? triggerEnd;
    const pushConfiguration = lines
      .slice(pushIndex + 1, pushEnd)
      .filter(
        (line) =>
          line.trim() !== "" && !line.trimStart().startsWith("#"),
      );
    if (
      pushConfiguration.length !== 1 ||
      yamlIndent(pushConfiguration[0]) !== 4 ||
      pushConfiguration[0].trim() !== "branches: [main]"
    ) {
      errors.push(
        `CI workflow ${workflowPath} must trigger pushes to main with branches: [main] and no filters`,
      );
    }
  }
}

export function runValidationProfile({
  root = DEFAULT_ROOT,
  profileName,
  spawn = spawnSync,
  platform = process.platform,
  environment = process.env,
  stdout = (message) => console.log(message),
  stderr = (message) => console.error(message),
} = {}) {
  let contract;
  try {
    contract = JSON.parse(
      readFileSync(resolve(root, "validation/contract.json"), "utf8"),
    );
  } catch (error) {
    stderr(
      `Validation runner: cannot read validation/contract.json: ${error.message}`,
    );
    return 2;
  }

  const contractErrors = validateValidationContract(root);
  if (contractErrors.length > 0) {
    stderr("Validation runner refused an invalid contract:");
    for (const error of contractErrors) stderr(`- ${error}`);
    return 2;
  }

  const commandIds = contract.profiles?.[profileName];
  if (!Array.isArray(commandIds)) {
    stderr(
      `Validation runner: unknown profile ${JSON.stringify(
        profileName,
      )}; choose one of ${Object.keys(contract.profiles ?? {}).join(", ")}`,
    );
    return 2;
  }

  for (const [index, commandId] of commandIds.entries()) {
    const command = contract.commands?.[commandId];
    if (!command || !Array.isArray(command.argv) || command.argv.length === 0) {
      stderr(
        `Validation runner: profile ${profileName} references invalid command ${commandId}`,
      );
      return 2;
    }

    const [executable, ...args] = command.argv;
    const usesWindowsPnpm = platform === "win32" && executable === "pnpm";
    const platformExecutable = usesWindowsPnpm ? "cmd.exe" : executable;
    const platformArgs = usesWindowsPnpm
      ? ["/d", "/s", "/c", "pnpm.cmd", ...args]
      : args;
    stdout(
      `\n==> [${index + 1}/${commandIds.length}] ${
        command.label ?? commandId
      }`,
    );
    stdout(`$ ${command.argv.join(" ")}`);

    const result = spawn(platformExecutable, platformArgs, {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    if (result.error) {
      stderr(
        `Validation command ${commandId} could not start: ${result.error.message}`,
      );
      return 1;
    }
    if (result.signal) {
      stderr(
        `Validation command ${commandId} terminated by signal ${result.signal}`,
      );
      return 1;
    }
    if (result.status !== 0) {
      stderr(
        `Validation command ${commandId} failed with exit ${result.status}`,
      );
      return result.status ?? 1;
    }
  }

  stdout(
    `\nValidation profile ${profileName} passed (${commandIds.length} commands).`,
  );
  return 0;
}

export function validateValidationContract(
  root = DEFAULT_ROOT,
  contractRelativePath = "validation/contract.json",
) {
  const errors = [];
  const contract = readJson(
    root,
    contractRelativePath,
    errors,
    "validation contract",
  );
  const packageJson = readJson(root, "package.json", errors, "package.json");
  if (!contract || !packageJson) return errors;

  if (contract.version !== 1) {
    errors.push(
      `validation contract version must be 1, received ${JSON.stringify(
        contract.version,
      )}`,
    );
  }

  const commands =
    contract.commands && typeof contract.commands === "object"
      ? contract.commands
      : {};
  const commandIds = Object.keys(commands);
  if (commandIds.length === 0) {
    errors.push("validation contract must define at least one command");
  }
  for (const [scriptName, expectedBody] of REQUIRED_PACKAGE_SCRIPTS) {
    const actualBody = packageJson.scripts?.[scriptName];
    if (actualBody !== expectedBody) {
      errors.push(
        `required package script ${scriptName} must be ${JSON.stringify(
          expectedBody,
        )}, received ${JSON.stringify(actualBody)}`,
      );
    }
  }
  const executableSet = new Set(contract.executables ?? []);
  const validatedPackageScripts = new Set();
  const packageScriptOwners = new Map();

  for (const [commandId, command] of Object.entries(commands)) {
    if (!command || !Array.isArray(command.argv) || command.argv.length === 0) {
      errors.push(`validation command ${commandId} must define a non-empty argv`);
      continue;
    }
    if (!command.argv.every((part) => typeof part === "string" && part !== "")) {
      errors.push(`validation command ${commandId} argv must contain only non-empty strings`);
      continue;
    }
    if (!executableSet.has(command.argv[0])) {
      errors.push(
        `validation command ${commandId} uses undeclared executable ${command.argv[0]}`,
      );
    }
    if (typeof command.label !== "string" || command.label.trim() === "") {
      errors.push(`validation command ${commandId} must have a descriptive label`);
    }

    if (command.packageScript !== undefined) {
      const scriptName = command.packageScript;
      const owners = packageScriptOwners.get(scriptName) ?? [];
      owners.push(commandId);
      packageScriptOwners.set(scriptName, owners);
      const expectedArgv = ["pnpm", scriptName];
      if (JSON.stringify(command.argv) !== JSON.stringify(expectedArgv)) {
        errors.push(
          `validation command ${commandId} declares packageScript ${scriptName} but argv is ${command.argv.join(
            " ",
          )}; expected ${expectedArgv.join(" ")}`,
        );
      }
      const body = packageJson.scripts?.[scriptName];
      if (typeof body !== "string" || body.trim() === "") {
        errors.push(
          `validation command ${commandId} references missing package script ${scriptName}`,
        );
      } else {
        validatePackageScript(
          root,
          scriptName,
          packageJson,
          errors,
          validatedPackageScripts,
        );
      }
    }
  }
  for (const [scriptName, owners] of packageScriptOwners) {
    if (owners.length > 1) {
      errors.push(
        `package script ${scriptName} is owned by multiple validation commands: ${owners.join(
          ", ",
        )}`,
      );
    }
  }

  const profiles =
    contract.profiles && typeof contract.profiles === "object"
      ? contract.profiles
      : {};
  for (const required of ["fast", "full"]) {
    if (!Array.isArray(profiles[required]) || profiles[required].length === 0) {
      errors.push(`validation profile ${required} must be a non-empty array`);
    }
  }

  for (const [profileName, ids] of Object.entries(profiles)) {
    if (!Array.isArray(ids)) {
      errors.push(`validation profile ${profileName} must be an array`);
      continue;
    }
    for (const duplicate of duplicates(ids)) {
      errors.push(
        `validation profile ${profileName} repeats command ${duplicate}`,
      );
    }
    for (const commandId of ids) {
      if (!commands[commandId]) {
        errors.push(
          `validation profile ${profileName} references missing command ${commandId}`,
        );
      }
    }
  }

  const fast = new Set(Array.isArray(profiles.fast) ? profiles.fast : []);
  const full = new Set(Array.isArray(profiles.full) ? profiles.full : []);
  for (const commandId of REQUIRED_FAST_COMMANDS) {
    if (!fast.has(commandId)) {
      errors.push(
        `fast validation profile must include required command ${commandId}`,
      );
    }
  }
  for (const [commandId, expected] of REQUIRED_FULL_COMMANDS) {
    const command = commands[commandId];
    if (!command) {
      errors.push(
        `full validation contract is missing required command ${commandId}`,
      );
      continue;
    }
    if (JSON.stringify(command.argv) !== JSON.stringify(expected.argv)) {
      errors.push(
        `required command ${commandId} argv must be ${expected.argv.join(
          " ",
        )}, received ${command.argv?.join(" ") ?? "<missing>"}`,
      );
    }
    if (
      expected.packageScript !== undefined &&
      command.packageScript !== expected.packageScript
    ) {
      errors.push(
        `required command ${commandId} must own package script ${expected.packageScript}, received ${JSON.stringify(
          command.packageScript,
        )}`,
      );
    }
    if (
      expected.requiresBrowser !== undefined &&
      command.requiresBrowser !== expected.requiresBrowser
    ) {
      errors.push(
        `required command ${commandId} must declare requiresBrowser: ${expected.requiresBrowser}`,
      );
    }
    if (!full.has(commandId)) {
      errors.push(
        `full validation profile must include required command ${commandId}`,
      );
    }
  }
  for (const commandId of fast) {
    if (!full.has(commandId)) {
      errors.push(
        `full validation profile must include fast command ${commandId}`,
      );
    }
    if (commands[commandId]?.requiresBrowser) {
      errors.push(
        `fast validation profile must not require a browser (${commandId})`,
      );
    }
    if (commands[commandId]?.installsBrowser) {
      errors.push(
        `fast validation profile must not install a browser (${commandId})`,
      );
    }
  }
  for (const commandId of commandIds) {
    if (!full.has(commandId)) {
      errors.push(
        `full validation profile omits declared command ${commandId}`,
      );
    }
  }
  for (const scriptName of Object.keys(packageJson.scripts ?? {})
    .filter(isValidationPackageScript)
    .sort()) {
    const owners = packageScriptOwners.get(scriptName) ?? [];
    if (owners.length === 0) {
      if (validatedPackageScripts.has(scriptName)) continue;
      errors.push(
        `validation package script ${scriptName} is not owned by a command in validation/contract.json and included in the full profile`,
      );
      continue;
    }
    for (const commandId of owners) {
      if (!full.has(commandId)) {
        errors.push(
          `validation package script ${scriptName} is owned by ${commandId}, which the full profile omits`,
        );
      }
    }
  }
  const fullIds = Array.isArray(profiles.full) ? profiles.full : [];
  if (!fullIds.some((id) => commands[id]?.requiresBrowser)) {
    errors.push("full validation profile must include a browser command");
  }
  if (commands["browser-install"]?.installsBrowser !== true) {
    errors.push(
      "required command browser-install must declare installsBrowser: true",
    );
  }
  for (const [index, commandId] of fullIds.entries()) {
    if (
      commands[commandId]?.requiresBrowser &&
      !fullIds.slice(0, index).includes("browser-install")
    ) {
      errors.push(
        `browser command ${commandId} must follow required command browser-install in the full profile`,
      );
    }
  }
  const frontendBuildIndex = fullIds.indexOf("frontend-build");
  const bundleBudgetIndex = fullIds.indexOf("bundle-budget");
  if (
    frontendBuildIndex !== -1 &&
    bundleBudgetIndex !== -1 &&
    frontendBuildIndex > bundleBudgetIndex
  ) {
    errors.push(
      "full validation profile must run frontend-build before bundle-budget so bundle inspection uses current artifacts",
    );
  }

  const runnerAbsolute = resolveInside(
    root,
    RUNNER_SCRIPT,
    errors,
    "validation runner",
  );
  if (runnerAbsolute && !existsSync(runnerAbsolute)) {
    errors.push(`validation runner is missing at ${RUNNER_SCRIPT}`);
  } else if (runnerAbsolute) {
    const runnerSource = readFileSync(runnerAbsolute, "utf8").replace(
      /\r\n?/g,
      "\n",
    );
    if (runnerSource !== CANONICAL_RUNNER_SOURCE) {
      errors.push(
        `validation runner ${RUNNER_SCRIPT} must delegate to the tested canonical profile executor`,
      );
    }
  }

  for (const [entrypointName, entrypoint] of Object.entries(
    contract.entrypoints ?? {},
  )) {
    const packageScript = entrypoint?.packageScript;
    const profile = entrypoint?.profile;
    if (!profiles[profile]) {
      errors.push(
        `entrypoint ${entrypointName} references missing profile ${JSON.stringify(
          profile,
        )}`,
      );
      continue;
    }
    if (profile !== entrypointName) {
      errors.push(
        `entrypoint ${entrypointName} must target profile ${entrypointName}, received ${JSON.stringify(
          profile,
        )}`,
      );
    }
    const expected = `node ${RUNNER_SCRIPT} ${profile}`;
    const actual = packageJson.scripts?.[packageScript];
    if (actual !== expected) {
      errors.push(
        `package script ${packageScript ?? "<missing>"} must be ${JSON.stringify(
          expected,
        )}, received ${JSON.stringify(actual)}`,
      );
    }
  }
  for (const required of ["fast", "full"]) {
    if (!contract.entrypoints?.[required]) {
      errors.push(`validation contract is missing ${required} entrypoint`);
    }
  }
  const canonicalFastCommand = contract.entrypoints?.fast?.packageScript
    ? `pnpm ${contract.entrypoints.fast.packageScript}`
    : null;
  const canonicalFullCommand = contract.entrypoints?.full?.packageScript
    ? `pnpm ${contract.entrypoints.full.packageScript}`
    : null;

  const ci = contract.integrations?.ci;
  if (ci) {
    const ciCommand =
      typeof ci.command === "string" && ci.command.trim() !== ""
        ? ci.command
        : null;
    if (!ciCommand) {
      errors.push("CI integration command must be a non-empty string");
    }
    if (canonicalFullCommand && ciCommand !== canonicalFullCommand) {
      errors.push(
        `CI integration command must be canonical full entrypoint ${canonicalFullCommand}, received ${JSON.stringify(
          ciCommand,
        )}`,
      );
    }
    const ciAbsolute = resolveInside(root, ci.path, errors, "CI workflow");
    if (ciAbsolute && !existsSync(ciAbsolute)) {
      errors.push(`CI workflow is missing at ${ci.path}`);
    } else if (ciAbsolute) {
      const content = readFileSync(ciAbsolute, "utf8");
      validateCiTriggers(content, ci.path, errors);
      const matches = ciCommand
        ? [...content.matchAll(exactRunLine(ciCommand))]
        : [];
      if (matches.length !== 1) {
        errors.push(
          `CI workflow ${ci.path} must run canonical entrypoint ${JSON.stringify(
            ciCommand,
          )} exactly once; found ${matches.length}`,
        );
      }
      if (ciCommand && matches.length > 0) {
        validateCiRunStep(content, ciCommand, ci.path, errors);
      }
      for (const command of Object.values(commands)) {
        const direct = command.argv?.join(" ");
        if (!direct || direct === ciCommand) continue;
        if (exactRunLine(direct).test(content)) {
          errors.push(
            `CI workflow ${ci.path} duplicates canonical step ${JSON.stringify(
              direct,
            )}; keep validation behind ${ciCommand}`,
          );
        }
      }
    }
  } else {
    errors.push("validation contract is missing CI integration");
  }

  const contributing = contract.integrations?.contributing;
  if (contributing) {
    const contributingCommands = Array.isArray(contributing.commands)
      ? contributing.commands
      : [];
    if (!Array.isArray(contributing.commands)) {
      errors.push("contributor-guide integration commands must be an array");
    }
    for (const command of [canonicalFastCommand, canonicalFullCommand].filter(
      Boolean,
    )) {
      if (!contributingCommands.includes(command)) {
        errors.push(
          `contributor-guide integration must include canonical entrypoint ${command}`,
        );
      }
    }
    const path = resolveInside(
      root,
      contributing.path,
      errors,
      "contributor guide",
    );
    if (path && !existsSync(path)) {
      errors.push(`contributor guide is missing at ${contributing.path}`);
    } else if (path) {
      const content = readFileSync(path, "utf8");
      for (const command of contributingCommands) {
        if (!hasMarkdownCommandLine(content, command)) {
          errors.push(
            `contributor guide ${contributing.path} must show ${command} on a visible command line`,
          );
        }
      }
    }
  } else {
    errors.push("validation contract is missing contributor-guide integration");
  }

  if (canonicalFullCommand) {
    const path = resolveInside(
      root,
      DEVELOPMENT_GUIDE,
      errors,
      "development guide",
    );
    if (path && !existsSync(path)) {
      errors.push(`development guide is missing at ${DEVELOPMENT_GUIDE}`);
    } else if (
      path &&
      !hasMarkdownCommandLine(
        readFileSync(path, "utf8"),
        canonicalFullCommand,
      )
    ) {
      errors.push(
        `development guide ${DEVELOPMENT_GUIDE} must show canonical full entrypoint ${canonicalFullCommand} on a visible command line`,
      );
    }
  }

  const skills = contract.integrations?.skills;
  if (skills) {
    const skillPaths = Array.isArray(skills.paths) ? skills.paths : [];
    if (!Array.isArray(skills.paths)) {
      errors.push("adapted-skill integration paths must be an array");
    }
    if (canonicalFullCommand && skills.command !== canonicalFullCommand) {
      errors.push(
        `adapted-skill integration command must be canonical full entrypoint ${canonicalFullCommand}, received ${JSON.stringify(
          skills.command,
        )}`,
      );
    }
    for (const skillPath of skillPaths) {
      const path = resolveInside(root, skillPath, errors, "adapted skill");
      if (path && !existsSync(path)) {
        errors.push(`adapted skill is missing at ${skillPath}`);
      } else if (path) {
        const content = stripMarkdownHtmlComments(readFileSync(path, "utf8"));
        const count = content.split(skills.command).length - 1;
        if (count !== 1) {
          errors.push(
            `adapted skill ${skillPath} must reference canonical gate ${JSON.stringify(
              skills.command,
            )} exactly once; found ${count}`,
          );
        }
      }
    }
  } else {
    errors.push("validation contract is missing adapted-skill integration");
  }

  return errors;
}

function runCli() {
  const errors = validateValidationContract();
  if (errors.length > 0) {
    console.error("Validation contract check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("Validation contract passed.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
