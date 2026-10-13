import type { AppSettings } from "../../bindings";
export function anyRepoConfigured(settings: AppSettings): boolean {
  return settings.repos.some((repo) => repo.url.trim() !== "");
}

export function configuredRepoUrls(settings: AppSettings): string[] {
  return Array.from(
    new Set(settings.repos.map((repo) => repo.url.trim()).filter((url) => url !== "")),
  );
}

export function stableSessionEnvKey(env: AppSettings["session_env"]): string {
  return JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right)));
}

export function skillsCheckContextKey(
  repoUrl: string,
  sessionEnv: AppSettings["session_env"],
): string {
  return `${repoUrl}\n${stableSessionEnvKey(sessionEnv)}`;
}
