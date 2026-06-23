---
name: symphony-screenshot
description: Capture Playwright screenshots of a user-facing change and embed them in the GitHub PR description via a temporary commit + force-push. Use whenever the workflow asks for proof-of-testing screenshots on a user-facing change.
---

# Screenshot

The PR description is the home for proof-of-testing screenshots. They are hosted as raw GitHub blobs at a commit SHA that is force-pushed away after the URL is captured — the blob keeps serving until GitHub GC.

Capture runs through a small Node script (`capture.mjs`) driven from the shell, **not** the Playwright MCP. The MCP's `browser_run_code_unsafe` runs in a sandbox with no `process`, `require`, or `context`, so it cannot read an environment variable or inject a session cookie — authenticated dev captures are impossible there. A plain Node script gets a normal `process.env`, so a session cookie can be injected while the secret stays in the environment and never appears in a tool call / transcript. The script also bypasses self-signed dev certs and handles SPAs that never reach network-idle.

## Preconditions

- A PR exists for the current branch (use the `symphony-push` skill first if not).
- `gh auth status` succeeds against the repo's host.
- **Node + Playwright are resolvable from the repo.** `capture.mjs` does `import { chromium } from 'playwright'`; run it from inside the repo tree so Node resolves a `playwright` install in the repo's `node_modules` (or make one available via `npx playwright`). If the repo has no Playwright, surface that as a blocker rather than guessing.
- **For authenticated targets only** (anything behind a login wall, e.g. a dev server): the session cookie *value* must be present in an environment variable (do not hardcode it). You pass the env var's *name* and the cookie's name/domain in the spec — never the value. If the var is unset, stop and surface a blocker; do not capture the auth wall.

## Capture script

Write this verbatim to `.symphony/capture.mjs` before capturing (inside the repo so `playwright` resolves). It is teardown plumbing — it is **not** committed (removed in the cleanup step).

```js
// Bash-driven Playwright capture. Run from inside the repo so `playwright`
// resolves from node_modules. The session cookie (if any) is read from an env
// var named in the spec, so the secret stays in the environment and never
// lands in a tool call / transcript.
//
// Usage: node .symphony/capture.mjs <spec.json>
// spec.json:
//   {
//     "outDir": ".symphony/screenshots",
//     "cookie": { "env": "SESSION_COOKIE", "name": "session", "domain": "localhost" },  // optional
//     "shots": [
//       { "name": "01-default", "url": "https://localhost:3000/path" },
//       { "name": "04-mobile",  "url": "https://localhost:3000/path", "width": 390, "height": 844 }
//     ]
//   }
// Prints a JSON report (name, requested, landed, http, path) per shot.
// Exit 0 = all ok, 2 = a shot failed, 1 = bad invocation/env.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node capture.mjs <spec.json>');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const outDir = spec.outDir ?? '.symphony/screenshots';
const shots = Array.isArray(spec.shots) ? spec.shots : [];
if (shots.length === 0) {
  console.error('spec has no shots');
  process.exit(1);
}

let cookie = null;
if (spec.cookie) {
  const value = process.env[spec.cookie.env];
  if (!value) {
    console.error(`${spec.cookie.env} not set — cannot capture authenticated screenshots`);
    process.exit(1);
  }
  cookie = {
    name: spec.cookie.name,
    value,
    domain: spec.cookie.domain ?? 'localhost',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  };
}

const browser = await chromium.launch();
// ignoreHTTPSErrors handles dev servers behind a self-signed cert.
const context = await browser.newContext({ ignoreHTTPSErrors: true });
if (cookie) await context.addCookies([cookie]);

const results = [];
let failed = 0;
for (const shot of shots) {
  const page = await context.newPage();
  if (shot.width && shot.height) {
    await page.setViewportSize({ width: shot.width, height: shot.height });
  }
  try {
    // 'domcontentloaded', not 'networkidle': many SPAs hold persistent
    // connections and never go idle, so networkidle would always time out.
    const resp = await page.goto(shot.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const outPath = isAbsolute(shot.name) ? shot.name : join(outDir, `${shot.name}.png`);
    mkdirSync(dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, fullPage: shot.fullPage !== false });
    results.push({
      name: shot.name,
      requested: shot.url,
      landed: page.url(),
      http: resp ? resp.status() : null,
      path: outPath,
    });
  } catch (e) {
    failed += 1;
    results.push({ name: shot.name, requested: shot.url, error: e.message });
  }
  await page.close();
}
await browser.close();
console.log(JSON.stringify({ results }, null, 2));
process.exit(failed ? 2 : 0);
```

## Steps

1. **Build a spec and capture comprehensively.** Write a spec JSON (e.g. to `/tmp/symphony-shots.json`) listing every state worth a reviewer's eye, then run the script.

   **Capture every state that matters to a reviewer**, not just the happy path — e.g. `01-default`, `02-loading`, `03-error`, `04-mobile`, `05-hover`. Set `width`/`height` on a shot for responsive/mobile states. Err on the side of more screenshots: the commit is force-pushed away so size doesn't matter, and a missing state is the most common reviewer ask. Number `name`s so they sort and embed in a deterministic order. Shots default to `fullPage`; set `"fullPage": false` only when the page is impractically tall (infinite scroll, very long forms).

   Spec example (no auth):

   ```json
   {
     "outDir": ".symphony/screenshots",
     "shots": [
       { "name": "01-default", "url": "https://localhost:3000/path" },
       { "name": "04-mobile", "url": "https://localhost:3000/path", "width": 390, "height": 844 }
     ]
   }
   ```

   For an **authenticated** target, add a `cookie` block (env var name + cookie name/domain) and ensure the env var holds the session value — never put the value in the spec, in `argv`, or in any `echo`:

   ```json
   "cookie": { "env": "SESSION_COOKIE", "name": "session", "domain": "localhost" }
   ```

   Then run it:

   ```sh
   node .symphony/capture.mjs /tmp/symphony-shots.json
   ```

   The script prints a JSON report. **Check `landed`**: if it differs from the requested URL (redirected to a login wall or elsewhere), the cookie is stale or the account lacks access — surface that as a blocker rather than embedding a wrong-page shot. The PNGs land under `.symphony/screenshots/` (the spec's `outDir`, repo-relative); the spec JSON itself may live in `/tmp`.

2. **Stage and commit** all the screenshots together:
   ```sh
   git add .symphony/screenshots/
   git commit -m "chore: temporary screenshots for PR description (will be removed)" --no-verify
   ```
   `--no-verify` is allowed here because this commit is throwaway and lint/format hooks would reject the binary paths. This is the *only* skill that bypasses hooks. Do **not** stage `.symphony/capture.mjs` — it's teardown plumbing, removed in the cleanup step.

3. **Push.** If the remote is ahead, rebase the screenshot commit onto it first (`git fetch && git rebase origin/<branch>`); a merge commit pollutes the throwaway history.
   ```sh
   git push origin "$(git branch --show-current)"
   ```

4. **Build the raw URLs** at the new commit SHA — one base, one URL per file.
   ```sh
   sha=$(git log -1 --format=%H)
   repo_url=$(gh repo view --json url -q .url)
   for f in .symphony/screenshots/*.png; do
     name=$(basename "$f")
     echo "${repo_url}/raw/${sha}/.symphony/screenshots/${name}"
   done
   ```

5. **Update PR body.** Read the current body, append (or replace) a `## Screenshots` section, write back. Never clobber existing sections. Embed every captured screenshot — one image per state — with a short caption derived from the filename so reviewers can scan them.
   ```sh
   pr=$(gh pr view --json number -q .number)
   body=$(gh pr view --json body -q .body)
   block=$(printf '\n\n## Screenshots\n\n')
   for f in .symphony/screenshots/*.png; do
     name=$(basename "$f" .png)
     url="${repo_url}/raw/${sha}/.symphony/screenshots/${name}.png"
     block+=$(printf '**%s**\n\n![%s](%s)\n\n' "$name" "$name" "$url")
   done
   gh pr edit "$pr" --body "${body}${block}"
   ```
   Use a heredoc or a built-up shell variable for the `--body` arg so newlines stay literal. Group related captures (e.g. mobile vs desktop) under sub-headings if it makes the PR easier to scan.

6. **Verify the images render** in the PR (visual confirmation by the operator, or a `curl -I "$raw_url"` returning 200 if running unattended). Do not proceed to step 7 without confirmation — once the commit is force-pushed away, the URLs still work but you can no longer regenerate them from history.

7. **Reset and force-push** to drop the screenshot commit from branch history:
   ```sh
   git reset --hard HEAD~1
   git push --force-with-lease origin "$(git branch --show-current)"
   ```
   Always `--force-with-lease`, never `--force`. If the lease check fails, someone pushed in the meantime — fetch, re-rebase, and retry from step 3 (the new SHA invalidates the URLs captured in step 4, so re-do the PR-body update too).

8. **Cleanup workspace artifacts**: `rm -rf .symphony/screenshots .symphony/capture.mjs .playwright-mcp` and `rm -f /tmp/symphony-shots.json` (those should not appear in `git status` afterward). If the skill started a dev server, stop it.

## Caveats

- **Orphaned-blob TTL.** GitHub serves the URL by SHA until it garbage-collects unreachable objects — typically weeks, sometimes longer. Adequate for normal PR review windows, not for permanent documentation. If the change requires an enduring screenshot (e.g., a runbook), commit it to a real path on main via a separate PR.
- **Force-push scope.** This skill force-pushes the issue's PR branch. It will *not* run on `main` or any protected branch — `git push --force-with-lease` to a protected branch is rejected by the remote.

## Don't

- Don't put the cookie value in the spec JSON, in `argv`, or in any `echo`/log. It must come from the env var named in `spec.cookie.env` — that's the whole reason for the Bash-driven script.
- Don't use the Playwright MCP for authenticated dev captures. Its sandbox can't read env vars or inject cookies; `capture.mjs` is the contract.
- Don't `git push --force` without `--with-lease` — you'll silently overwrite a teammate's push.
- Don't commit screenshots to a path that survives — the commit must be the immediate `HEAD~1` so the reset is a single hop. Don't stage `.symphony/capture.mjs`.
- Don't skip step 6 (visual verification). A broken URL in the PR body is harder to fix than re-capturing.
- Don't ship a single happy-path screenshot when the change has multiple states. If the diff touches loading / error / empty / mobile, capture each — reviewers will ask for them anyway.
- Don't crop or element-scope when full-page works. `capture.mjs` shoots `fullPage: true` by default; set `"fullPage": false` only when the page is impractically tall. Tight crops hide regressions in the surrounding chrome.
- Don't reuse this skill for screenshots that need to live longer than the PR — see "Caveats".
- Don't carry the `--no-verify` exception into other skills; it's specific to this throwaway commit.
