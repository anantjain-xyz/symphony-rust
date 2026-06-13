---
name: symphony-commit
description: Create a well-formed git commit from the current changes. Use when finalizing staged work, preparing a commit message, or splitting in-progress work into reviewable history.
---

# Commit

## Goals

- Produce a commit whose subject and body match the actual staged diff and the session's intent.
- Follow the repo's existing convention (run `git log --oneline -20` first; conventional-commit prefixes are common but the leading-identifier style — `SYM-31:` etc. — also appears).
- Never `--no-verify`. If a hook fails, fix the underlying problem and create a new commit.

## Inputs

- `git status`, `git diff`, `git diff --staged` for actual changes.
- Recent commit messages on the branch and in `origin/main` for style.
- The Symphony Workpad on the current Linear issue for scope/intent.

## Steps

1. Inspect: `git status`, `git diff`, `git diff --staged`.
2. Stage intended changes by name (`git add <paths>`). Avoid `git add -A` / `git add .` — they sweep in `.env`, credentials, large binaries, or artifacts you didn't mean to ship.
3. Sanity-check newly staged files. Build artifacts, logs, screenshots, and `.symphony-workspace-ready` must stay unstaged. Exception: `.symphony/screenshots/<name>.png` is intentionally staged by the `symphony-screenshot` skill's throwaway commit (which also `--no-verify`s, the only place that's allowed) and is removed by the same skill's force-push step.
4. Pick a subject (≤ 72 chars, imperative mood, no trailing period). Match the dominant style on the branch — usually `<TYPE>(<scope>): <summary>` or `<IDENTIFIER>: <summary>`.
5. Write the body via heredoc so newlines are literal:
   - One short paragraph (the *why*, plus tradeoffs if non-obvious).
   - Optional bullets summarizing what changed across multiple files.
6. Verify the message describes only what's staged. If the message and the diff disagree, fix the index — not the message.
7. Run `git commit -F <file>` (or the heredoc form) so newlines are real, not literal `\n`.

## Template

```
<type>(<scope>): <short imperative summary>

<one-paragraph rationale: why this change, what it unblocks, any tradeoff>

- <key change 1>
- <key change 2>
```

## Don't

- Don't use `git commit -m "$(printf 'a\nb')"` — it's brittle. Use a heredoc.
- Don't amend a published commit unless explicitly asked.
- Don't bypass hooks (`--no-verify`, `--no-gpg-sign`). If a hook fails, fix the cause.
