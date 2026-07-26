import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function bindingsDifference(checkedIn, generated) {
  if (Buffer.compare(checkedIn, generated) === 0) return null;

  const limit = Math.min(checkedIn.length, generated.length);
  let byte = 0;
  while (byte < limit && checkedIn[byte] === generated[byte]) byte += 1;
  const before = checkedIn.subarray(0, byte).toString("utf8");
  const line = before.split("\n").length;
  const checkedLine = checkedIn.toString("utf8").split("\n")[line - 1] ?? "<eof>";
  const generatedLine = generated.toString("utf8").split("\n")[line - 1] ?? "<eof>";
  return [
    `src/bindings.ts is stale at byte ${byte} (line ${line}).`,
    `checked in: ${JSON.stringify(checkedLine)}`,
    `generated:  ${JSON.stringify(generatedLine)}`,
    "Regenerate with: cargo run -p symphony-contracts --bin export-bindings -- src/bindings.ts",
  ].join("\n");
}

export function checkBindings(root = ROOT) {
  const directory = mkdtempSync(join(tmpdir(), "symphony-bindings-"));
  const generatedPath = join(directory, "bindings.ts");
  try {
    const result = spawnSync(
      "cargo",
      [
        "run",
        "--quiet",
        "--locked",
        "-p",
        "symphony-contracts",
        "--bin",
        "export-bindings",
        "--",
        generatedPath,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        [
          "headless Specta export failed",
          result.stdout.trim(),
          result.stderr.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    const difference = bindingsDifference(
      readFileSync(join(root, "src/bindings.ts")),
      readFileSync(generatedPath),
    );
    if (difference) throw new Error(difference);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkBindings();
    console.log("bindings contract is current");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
