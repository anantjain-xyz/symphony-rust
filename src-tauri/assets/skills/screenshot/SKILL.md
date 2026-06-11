---
name: screenshot
description: Capture Playwright screenshots of a user-facing change and embed them in the GitHub PR description via a temporary commit + force-push. Use whenever the workflow asks for proof-of-testing screenshots on a user-facing change.
---

# Screenshot

The PR description is the home for proof-of-testing screenshots. They are hosted as raw GitHub blobs at a commit SHA that is force-pushed away after the URL is captured — the blob keeps serving until GitHub GC.

## Preconditions

- Playwright MCP available (`mcp__plugin_playwright_playwright__browser_navigate`, `..._take_screenshot`).
- A PR exists for the current branch (use the `push` skill first if not).
- `gh auth status` succeeds against the repo's host.

## Steps

1. **Capture comprehensively.** Navigate to the URL with `browser_navigate`, then `browser_take_screenshot` with `fullPage: true` to capture the entire page — full-page is the default; only fall back to element-scoped (`target: "<ref-from-snapshot>"`) when the page is impractically tall (infinite scroll, very long forms) or when the visible diff is genuinely a single component. Save under the workspace at `.symphony/screenshots/<descriptive-name>.png`. The Playwright sandbox blocks `/tmp/...` and any path outside the workspace + `.playwright-mcp/` roots.

   **Capture every state that matters to a reviewer**, not just the happy path. For a typical user-facing change that means multiple files — e.g. `01-default.png`, `02-loading.png`, `03-error.png`, `04-mobile.png`, `05-hover.png`. Resize the viewport with `browser_resize` between shots when the change is responsive. Err on the side of more screenshots: the commit is force-pushed away so size doesn't matter, and a missing state is the most common reviewer ask. Number filenames so they sort and embed in a deterministic order.

2. **Stage and commit** all the screenshots together:
   ```sh
   git add .symphony/screenshots/
   git commit -m "chore: temporary screenshots for PR description (will be removed)" --no-verify
   ```
   `--no-verify` is allowed here because this commit is throwaway and lint/format hooks would reject the binary paths. This is the *only* skill that bypasses hooks.

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

8. **Cleanup workspace artifacts**: `rm -rf .symphony/screenshots .playwright-mcp` (those dirs should not appear in `git status` afterward).

## Caveats

- **Orphaned-blob TTL.** GitHub serves the URL by SHA until it garbage-collects unreachable objects — typically weeks, sometimes longer. Adequate for normal PR review windows, not for permanent documentation. If the change requires an enduring screenshot (e.g., a runbook), commit it to a real path on main via a separate PR.
- **Force-push scope.** This skill force-pushes the issue's PR branch. It will *not* run on `main` or any protected branch — `git push --force-with-lease` to a protected branch is rejected by the remote.

## Don't

- Don't `git push --force` without `--with-lease` — you'll silently overwrite a teammate's push.
- Don't commit screenshots to a path that survives — the commit must be the immediate `HEAD~1` so the reset is a single hop.
- Don't skip step 6 (visual verification). A broken URL in the PR body is harder to fix than re-capturing.
- Don't ship a single happy-path screenshot when the change has multiple states. If the diff touches loading / error / empty / mobile, capture each — reviewers will ask for them anyway.
- Don't crop or element-scope when `fullPage` works. Tight crops hide regressions in the surrounding chrome that a full-page shot would reveal.
- Don't reuse this skill for screenshots that need to live longer than the PR — see "Caveats".
- Don't carry the `--no-verify` exception into other skills; it's specific to this throwaway commit.
