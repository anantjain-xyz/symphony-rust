import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SCRIPT = "scripts/run-validation.mjs";
const REQUIRED_FULL_COMMANDS = new Map([
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
    "frontend-build",
    {
      argv: ["pnpm", "build"],
      packageScript: "build",
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

  const runnerAbsolute = resolveInside(
    root,
    RUNNER_SCRIPT,
    errors,
    "validation runner",
  );
  if (runnerAbsolute && !existsSync(runnerAbsolute)) {
    errors.push(`validation runner is missing at ${RUNNER_SCRIPT}`);
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
        if (!content.includes(command)) {
          errors.push(
            `contributor guide ${contributing.path} must reference ${command}`,
          );
        }
      }
    }
  } else {
    errors.push("validation contract is missing contributor-guide integration");
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
        const content = readFileSync(path, "utf8");
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
