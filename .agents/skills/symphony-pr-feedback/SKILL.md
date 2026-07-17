---
name: symphony-pr-feedback
description: Sweep the PR for actionable reviewer feedback (top-level comments, inline review comments, review states) and resolve every item before moving to In Review. Use after every push that might have triggered review, and as the gate before transitioning the issue to In Review.
---

# PR feedback sweep

## When to run

- Before transitioning the issue to `In Review` for the first time.
- After every change prompted by review (push → reviewer reacts → repeat).
- When a `Todo` redispatch lands on a PR that already has comments — sweep before doing new work.

## Channels

Reviewer feedback arrives across three channels — gather all three:

1. **Top-level PR comments** (issue thread):
   ```sh
   pr=$(gh pr view --json number -q .number)
   repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   gh api --paginate "repos/${repo}/issues/${pr}/comments"
   ```
2. **Inline review comments** (line-anchored):
   ```sh
   gh api --paginate "repos/${repo}/pulls/${pr}/comments"
   ```
3. **Review states** (approved / changes requested / commented):
   ```sh
   gh api --paginate "repos/${repo}/pulls/${pr}/reviews"
   ```

`--paginate` is mandatory: GitHub REST list endpoints page at 30 by default, so a busy PR can silently hide later comments and trick the sweep into declaring "no actionable feedback" when there is.

The `Manual QA Plan` comment, when present, sharpens UI/runtime coverage — read it before transitioning.

## Resolution rules

Treat every actionable comment (human or bot, top-level or inline) as **blocking** until one of these is true:

- Code/tests/docs updated to address it. Push the fix, then reply where the comment lives (inline reply for inline comments; top-level for top-level) noting the commit SHA.
- Explicit, justified pushback. Reply on the same thread with: acknowledge → rationale → offer alternative or follow-up. Keep it concrete; don't dismiss with "won't do".

Mirror each item and its resolution in the workpad's plan so the trail is auditable.

## Replying to inline comments

The endpoint for an inline reply is the *pulls* endpoint (not *issues*) and `in_reply_to` must be the numeric review-comment id, not a GraphQL node id:

```sh
gh api -X POST "repos/${repo}/pulls/${pr}/comments" \
  -f body='<reply text>' \
  -F in_reply_to=<numeric-comment-id>
```

A 404 here usually means the wrong endpoint (you used `issues`) or insufficient scope.

## Classifying feedback

Per comment, pick one mode and state it in your reply before changing code:

- **accept** — fix it, then reply with the commit SHA.
- **clarify** — ask a focused question; don't change code yet.
- **push back** — disagree; reply with rationale + alternative; only proceed without changes if the rationale is solid.

Correctness concerns must be addressed (or validated as inapplicable, with proof). Style/scope concerns can be deferred with a clear reason.

## Loop

Repeat sweep → fix → reply → re-run validation → push, until **zero outstanding actionable comments** *and* PR checks are green on the latest commit. Only then move the issue to `In Review`.
