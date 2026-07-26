import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const baselineRelativePath = "scripts/biome-format-baseline.json";

function readBaselineAtRevision(projectRoot, revision) {
  const result = spawnSync("git", ["show", `${revision}:${baselineRelativePath}`], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

function mergeBase(projectRoot, reference) {
  const result = spawnSync("git", ["merge-base", "HEAD", reference], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function baselineIntroduction(projectRoot) {
  const result = spawnSync(
    "git",
    ["log", "--diff-filter=A", "-1", "--format=%H", "HEAD", "--", baselineRelativePath],
    { cwd: projectRoot, encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function mainPushBase(environment) {
  const eventPath = environment.GITHUB_EVENT_PATH?.trim();
  if (eventPath) {
    try {
      const before = JSON.parse(readFileSync(eventPath, "utf8")).before;
      if (typeof before === "string" && /^[a-f0-9]{40}$/i.test(before) && !/^0{40}$/.test(before)) {
        return before;
      }
    } catch {
      // Fall back to the immediately preceding revision when the event payload
      // is unavailable or malformed (for example in a local CI reproduction).
    }
  }
  return "HEAD^";
}

export function loadTrustedBiomeBaseline(projectRoot, environment = process.env) {
  const configuredBase = environment.BIOME_FORMAT_BASE_REF?.trim();
  const mainPush =
    environment.GITHUB_EVENT_NAME === "push" && environment.GITHUB_REF === "refs/heads/main";
  const baseReference =
    configuredBase ||
    (environment.GITHUB_BASE_REF
      ? `origin/${environment.GITHUB_BASE_REF}`
      : mainPush
        ? mainPushBase(environment)
        : "origin/main");
  const baseRevision = mergeBase(projectRoot, baseReference);
  if (baseRevision) {
    const baseline = readBaselineAtRevision(projectRoot, baseRevision);
    if (baseline) return { baseline, revision: baseRevision };
  }

  // The baseline was introduced by this branch, so the commit that first added
  // it is the immutable source for later commits on the same branch.
  const introduction = baselineIntroduction(projectRoot);
  if (!introduction) return null;
  const baseline = readBaselineAtRevision(projectRoot, introduction);
  return baseline ? { baseline, revision: introduction } : null;
}

export function biomeBaselinePolicyProblems(current, trusted, revision) {
  const problems = [];
  for (const [file, digest] of Object.entries(current)) {
    if (!Object.hasOwn(trusted, file)) {
      problems.push(
        `${baselineRelativePath}: ${file} was added after the trusted baseline at ${revision}; format the file instead`,
      );
    } else if (trusted[file] !== digest) {
      problems.push(
        `${baselineRelativePath}: ${file} was re-pinned after the trusted baseline at ${revision}; format the file instead`,
      );
    }
  }
  return problems;
}
