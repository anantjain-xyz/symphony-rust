---
name: symphony-screenshot
description: Capture Playwright screenshots of a user-facing change and embed them in the GitHub PR description via a temporary commit + force-push. Use whenever the workflow asks for proof-of-testing screenshots on a user-facing change.
---

# Screenshot

The PR description is the home for proof-of-testing screenshots. They are hosted as raw GitHub blobs at a commit SHA that is force-pushed away after the URL is captured — the blob keeps serving until GitHub GC.

Capture runs through a small Node script (`capture.mjs`) driven from the shell, **not** the Playwright MCP. The MCP's `browser_run_code_unsafe` runs in a sandbox with no `process`, `require`, or `context`, so it cannot read an environment variable or inject a session cookie — authenticated dev captures are impossible there. A plain Node script gets a normal `process.env`, so a session cookie can be injected while the secret stays in the environment and never appears in a tool call / transcript. The script also bypasses self-signed dev certs, handles SPAs that never reach network-idle, fails on unexpected HTTP statuses, and can run interactions (hover/click/…) to reach states that aren't a bare URL.

## Preconditions

- A PR exists for the current branch (use the `symphony-push` skill first if not).
- `gh auth status` succeeds against the repo's host, or `GITHUB_TOKEN`/`GH_TOKEN` is available for that host.
- **Playwright is installed in the repo's `node_modules`.** `capture.mjs` does `import { chromium } from 'playwright'`, resolved from the repo tree. If the repo doesn't already depend on Playwright, install it first (`npm install --no-save playwright`, or the repo's package manager) — `npx playwright` does **not** make the bare `import` resolvable for a plain `node .symphony/capture.mjs`. If it can't be installed, surface a blocker rather than guessing.
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
//     // optional auth cookie. Only `value` comes from the env var named in
//     // `env`; every other field is passed through to Playwright unchanged so
//     // the real session cookie is replayed faithfully. Provide `url` OR
//     // `domain`(+`path`). Omit secure/httpOnly/sameSite to use Playwright
//     // defaults; set them to match the real cookie when it matters.
//     "cookie": { "env": "SESSION_COOKIE", "name": "session", "domain": "localhost",
//                 "path": "/", "secure": true, "sameSite": "Lax" },
//     "shots": [
//       { "name": "01-default", "url": "https://localhost:3000/path" },
//       { "name": "04-mobile",  "url": "https://localhost:3000/path", "width": 390, "height": 844 },
//       // interactions before the shot (states that aren't a bare URL):
//       { "name": "05-menu", "url": "https://localhost:3000/path",
//         "actions": [{ "hover": "nav .menu" }, { "waitFor": ".menu-popover" }] },
//       // intentionally capturing a non-2xx page: opt in via expectStatus
//       { "name": "06-not-found", "url": "https://localhost:3000/missing", "expectStatus": 404 }
//     ]
//   }
// Per-shot knobs: width/height (viewport), fullPage (default true), settleMs
// (default 2500), expectStatus (number | number[]; default: any < 400),
// actions (run after settle, before the shot).
// Prints a JSON report (name, requested, landed, http, path | error) per shot.
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

// Optional auth cookie: only the value comes from the env; all attributes are
// passthrough so the real session cookie is replayed faithfully.
let cookie = null;
if (spec.cookie) {
  const c = spec.cookie;
  const value = process.env[c.env];
  if (!value) {
    console.error(`${c.env} not set — cannot capture authenticated screenshots`);
    process.exit(1);
  }
  cookie = { name: c.name, value };
  if (c.url) cookie.url = c.url;
  else {
    cookie.domain = c.domain ?? 'localhost';
    cookie.path = c.path ?? '/';
  }
  // Pass through only attributes the spec sets — don't force defaults that
  // change which cookie is replayed (httpOnly hides it from document.cookie;
  // secure/sameSite affect when it's sent).
  for (const k of ['secure', 'httpOnly', 'sameSite', 'expires']) {
    if (c[k] !== undefined) cookie[k] = c[k];
  }
}

const browser = await chromium.launch();
// ignoreHTTPSErrors handles dev servers behind a self-signed cert.
const context = await browser.newContext({ ignoreHTTPSErrors: true });
if (cookie) await context.addCookies([cookie]);

// Pre-screenshot interactions so states only reachable via interaction (menus,
// dialogs, loading/error UI) can be captured. A failing action fails the shot.
async function runActions(page, actions) {
  for (const a of actions ?? []) {
    if (a.click) await page.click(a.click);
    else if (a.hover) await page.hover(a.hover);
    else if (a.fill) await page.fill(a.fill, a.value ?? '');
    else if (a.press) await (a.selector ? page.locator(a.selector).press(a.press) : page.keyboard.press(a.press));
    else if (a.waitFor) await page.waitForSelector(a.waitFor);
    else if (a.wait) await page.waitForTimeout(a.wait);
    else throw new Error(`unknown action: ${JSON.stringify(a)}`);
  }
}

function statusOk(status, expect) {
  if (expect === undefined) return status > 0 && status < 400; // default: 2xx/3xx
  return Array.isArray(expect) ? expect.includes(status) : status === expect;
}

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
    const status = resp ? resp.status() : 0;
    // A stale cookie / typoed URL often returns a 4xx/5xx page at the same URL;
    // goto resolves anyway, so fail unless the shot opts into the status.
    if (!statusOk(status, shot.expectStatus)) {
      throw new Error(`unexpected HTTP ${status} (set "expectStatus" to allow)`);
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(shot.settleMs ?? 2500);
    await runActions(page, shot.actions);
    const outPath = isAbsolute(shot.name) ? shot.name : join(outDir, `${shot.name}.png`);
    mkdirSync(dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, fullPage: shot.fullPage !== false });
    results.push({ name: shot.name, requested: shot.url, landed: page.url(), http: status, path: outPath });
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

   **Capture every state that matters to a reviewer**, not just the happy path — e.g. `01-default`, `02-loading`, `03-error`, `04-mobile`, `05-hover`. Set `width`/`height` for responsive/mobile states. For states that aren't a bare URL (hover menus, opened dialogs, click-triggered loading/error UI), drive them with a shot `actions` list. Err on the side of more screenshots: the commit is force-pushed away so size doesn't matter, and a missing state is the most common reviewer ask. Number `name`s so they sort deterministically. Shots default to `fullPage`; set `"fullPage": false` only when the page is impractically tall.

   Spec example (no auth):

   ```json
   {
     "outDir": ".symphony/screenshots",
     "shots": [
       { "name": "01-default", "url": "https://localhost:3000/path" },
       { "name": "04-mobile", "url": "https://localhost:3000/path", "width": 390, "height": 844 },
       { "name": "05-menu", "url": "https://localhost:3000/path", "actions": [{ "hover": "nav .menu" }, { "waitFor": ".menu-popover" }] }
     ]
   }
   ```

   For an **authenticated** target, add a `cookie` block. Only `value` comes from the env var named in `env`; every other field is passed through to Playwright so the real session cookie is replayed faithfully (provide `url` or `domain`+`path`; set `secure`/`httpOnly`/`sameSite` to match the real cookie when it matters). Never put the value in the spec, in `argv`, or in any `echo`:

   ```json
   "cookie": { "env": "SESSION_COOKIE", "name": "session", "domain": "localhost", "path": "/", "secure": true, "sameSite": "Lax" }
   ```

   Then run it:

   ```sh
   node .symphony/capture.mjs /tmp/symphony-shots.json
   ```

   The script exits non-zero if any shot fails (navigation error, failed action, or an unexpected HTTP status — by default anything ≥ 400; opt a shot into a known status with `expectStatus`). It prints a JSON report per shot; also **check `landed`**: if it differs from the requested URL (redirected to a login wall or elsewhere), the cookie is stale or the account lacks access — fix that rather than embedding a wrong-page shot. PNGs land under `.symphony/screenshots/` (the spec's `outDir`, repo-relative); the spec JSON itself may live in `/tmp`.

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
- Don't embed a wrong-page or error shot. A redirect (`landed` ≠ requested) or an unexpected status fails the run for a reason — fix the cause or opt in with `expectStatus`; don't force it through.
- Don't reuse this skill for screenshots that need to live longer than the PR — see "Caveats".
- Don't carry the `--no-verify` exception into other skills; it's specific to this throwaway commit.
