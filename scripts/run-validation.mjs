import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const COMMANDS = {
  "agent-assets": ["pnpm", "check:harness"],
  "agent-asset-tests": ["pnpm", "test:harness"],
  lint: ["pnpm", "lint"],
  format: ["pnpm", "format:check"],
  workflows: ["pnpm", "check:workflows"],
  shell: ["pnpm", "check:shell"],
  links: ["pnpm", "check:links"],
  "hygiene-tests": ["pnpm", "test:hygiene"],
  boundaries: ["pnpm", "check:boundaries"],
  "boundary-tests": ["pnpm", "test:boundaries"],
  "rust-format": ["cargo", "fmt", "--all", "--", "--check"],
  "rust-clippy": [
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
  "rust-tests": ["cargo", "test", "--workspace", "--exclude", "symphony-desktop"],
  "static-contracts": ["pnpm", "check:static"],
  "static-tests": ["pnpm", "test:static"],
  typecheck: ["pnpm", "typecheck"],
  "frontend-tests": ["pnpm", "test"],
  build: ["pnpm", "build"],
  bundle: ["pnpm", "check:bundle"],
  "bundle-tests": ["pnpm", "test:bundle"],
  browser: ["pnpm", "exec", "playwright", "test"],
};

const FAST_PROFILE = [
  "lint",
  "format",
  "rust-format",
  "rust-clippy",
  "rust-tests",
  "typecheck",
  "frontend-tests",
];

const PROFILES = {
  fast: FAST_PROFILE,
  full: [
    "agent-assets",
    "agent-asset-tests",
    ...FAST_PROFILE,
    "workflows",
    "shell",
    "links",
    "hygiene-tests",
    "boundaries",
    "boundary-tests",
    "static-contracts",
    "static-tests",
    "build",
    "bundle",
    "bundle-tests",
    "browser",
  ],
};

function seconds(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function printSummary(timings, totalElapsed) {
  console.log("\nSlowest validation commands:");
  for (const timing of [...timings].sort((a, b) => b.elapsed - a.elapsed).slice(0, 5)) {
    console.log(`  ${seconds(timing.elapsed).padStart(7)}  ${timing.name}`);
  }
  console.log(`Total validation time: ${seconds(totalElapsed)}`);
}

function run(profileName) {
  const profile = PROFILES[profileName];
  if (!profile) {
    console.error(`Usage: node scripts/run-validation.mjs <${Object.keys(PROFILES).join("|")}>`);
    return 2;
  }

  const totalStarted = performance.now();
  const timings = [];
  for (const [index, name] of profile.entries()) {
    const argv = COMMANDS[name];
    const [command, ...args] = argv;
    const usesWindowsPnpm = process.platform === "win32" && command === "pnpm";
    const started = performance.now();
    console.log(`\n[${index + 1}/${profile.length}] ${name}: ${argv.join(" ")}`);
    const result = spawnSync(
      usesWindowsPnpm ? "cmd.exe" : command,
      usesWindowsPnpm ? ["/d", "/s", "/c", "pnpm.cmd", ...args] : args,
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      },
    );
    const elapsed = performance.now() - started;
    timings.push({ name, elapsed });
    console.log(`[${name}] finished in ${seconds(elapsed)}`);

    if (result.error) {
      console.error(`[${name}] could not start: ${result.error.message}`);
      printSummary(timings, performance.now() - totalStarted);
      return 1;
    }
    if (result.status !== 0) {
      console.error(`[${name}] failed with status ${result.status ?? "unknown"}`);
      printSummary(timings, performance.now() - totalStarted);
      return result.status ?? 1;
    }
  }

  printSummary(timings, performance.now() - totalStarted);
  return 0;
}

process.exitCode = run(process.argv[2]);
