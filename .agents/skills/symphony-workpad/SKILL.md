---
name: symphony-workpad
description: Manage the single Symphony Workpad comment on a Linear issue — find or bootstrap, update in place, or reset (Rework). Use whenever the workflow needs to read or write the workpad. Includes the GraphQL `commentUpdate` workaround for the known Linear MCP `save_comment` duplication bug.
---

# Workpad

The workpad is the single source of truth for an issue's plan, acceptance criteria, validation, and notes. **One `## Symphony Workpad` comment per issue, ever** — never open a second one, never delete it.

## Find or bootstrap

1. List comments on the issue with the configured Linear MCP comment-listing tool, normally `mcp__linear__list_comments` in Codex.
2. Find the comment whose body starts with `## Symphony Workpad`. If found: persist its `id` for in-place updates and reuse it.
3. If not found, create one with the configured Linear MCP comment-save tool, normally `mcp__linear__save_comment` in Codex, using the template at the bottom of this skill. Persist the returned `id`.

## Update in place (the trap)

The Linear MCP `save_comment` tool with a `commentId` **creates a new comment** instead of editing the original — this is what produces duplicate workpads. Always update via raw GraphQL:

```sh
curl -fsS \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  https://api.linear.app/graphql \
  -d @- <<'JSON'
{"query":"mutation($id:String!,$body:String!){commentUpdate(id:$id,input:{body:$body}){success}}",
 "variables":{"id":"<comment-id>","body":"<new body>"}}
JSON
```

If duplicates were already created by a buggy save, edit the *canonical* (oldest) workpad in place via the GraphQL workaround and replace the duplicate's body with `Superseded — see canonical Symphony Workpad above.`. **Do not delete the duplicate** — the workpad comment, even a duplicate one, is never test data.

## Reset (Rework)

When the issue moves to `Rework`, overwrite the existing workpad's body in place with a fresh scaffold via the same `commentUpdate` mutation. **Do not delete the comment.** Keep the same comment ID for the lifetime of the issue.

## Acceptance criteria & validation

- Capture every checkbox the workflow requires (env stamp, plan, acceptance, validation, notes).
- If the issue body has `Validation`, `Test Plan`, or `Testing` sections, copy them verbatim into Acceptance / Validation as required checkboxes — no optional downgrade.
- For user-facing changes, add a UI walkthrough criterion. Screenshots themselves go in the PR description via the `symphony-screenshot` skill, not in the workpad.

## Linking artifacts

- PR URL → attach to the issue (Linear attachment), not the workpad body. The auto-link from `git push` usually creates the attachment automatically; otherwise use GraphQL:
  ```graphql
  mutation AttachGitHubPR($issueId: String!, $url: String!, $title: String) {
    attachmentLinkGitHubPR(issueId: $issueId, url: $url, title: $title, linkKind: links) {
      success
      attachment { id title url }
    }
  }
  ```
- Screenshots → use the `symphony-screenshot` skill to embed in the PR description; do not paste them into the workpad.

## Don't

- Don't post separate "done"/summary comments outside the workpad.
- Don't edit the issue body/description for planning or progress.
- Don't put the PR URL in the workpad body.
- Don't delete the workpad — even if it duplicated.

## Template

````md
## Symphony Workpad

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
- [ ] 2\. Parent task

### Acceptance Criteria

- [ ] Criterion 1

### Validation

- [ ] targeted tests: `<command>`

### Notes

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>
````
