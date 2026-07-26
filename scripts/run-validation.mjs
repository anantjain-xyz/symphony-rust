import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateValidationContract } from "./check-validation-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "validation/contract.json");

function fail(message) {
  console.error(`Validation runner: ${message}`);
  process.exit(2);
}

let contract;
try {
  contract = JSON.parse(readFileSync(contractPath, "utf8"));
} catch (error) {
  fail(`cannot read validation/contract.json: ${error.message}`);
}
const contractErrors = validateValidationContract(root);
if (contractErrors.length > 0) {
  console.error("Validation runner refused an invalid contract:");
  for (const error of contractErrors) console.error(`- ${error}`);
  process.exit(2);
}

const profileName = process.argv[2];
const commandIds = contract.profiles?.[profileName];
if (!Array.isArray(commandIds)) {
  fail(
    `unknown profile ${JSON.stringify(profileName)}; choose one of ${Object.keys(
      contract.profiles ?? {},
    ).join(", ")}`,
  );
}

for (const [index, commandId] of commandIds.entries()) {
  const command = contract.commands?.[commandId];
  if (!command || !Array.isArray(command.argv) || command.argv.length === 0) {
    fail(`profile ${profileName} references invalid command ${commandId}`);
  }

  const [executable, ...args] = command.argv;
  const platformExecutable =
    process.platform === "win32" && executable === "pnpm"
      ? "pnpm.cmd"
      : executable;
  console.log(
    `\n==> [${index + 1}/${commandIds.length}] ${command.label ?? commandId}`,
  );
  console.log(`$ ${command.argv.join(" ")}`);

  const result = spawnSync(platformExecutable, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      `Validation command ${commandId} could not start: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.signal) {
    console.error(
      `Validation command ${commandId} terminated by signal ${result.signal}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `Validation command ${commandId} failed with exit ${result.status}`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log(
  `\nValidation profile ${profileName} passed (${commandIds.length} commands).`,
);
