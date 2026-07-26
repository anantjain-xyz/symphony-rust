import { spawnSync } from "node:child_process";

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

export function loadTrustedBiomeBaseline(projectRoot, environment = process.env) {
  const baseReference =
    environment.BIOME_FORMAT_BASE_REF ??
    (environment.GITHUB_BASE_REF ? `origin/${environment.GITHUB_BASE_REF}` : "origin/main");
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
