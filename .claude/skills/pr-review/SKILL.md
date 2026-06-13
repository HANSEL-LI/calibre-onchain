---
name: pr-review
description: Run the calibre-onchain PR_REVIEW agent against a pasted PR URL or number. Use when the user pastes a GitHub PR link for this repo and asks for a review, or invokes /pr-review <url>.
argument-hint: <pr-url-or-number>
disable-model-invocation: false
allowed-tools: Bash(gh *) Bash(git *) Bash(forge *) Read Grep Glob Skill
---

# PR Review on pasted URL — calibre-onchain

Target PR: `$ARGUMENTS`

Run the `PR_REVIEW.md` procedure (co-located in this skill dir) against the target PR above instead of the current branch.

## Bootstrap (do this before anything else)

1. Parse `$ARGUMENTS`. Accept any of: full GitHub URL (`https://github.com/<owner>/<repo>/pull/<n>`), `<owner>/<repo>#<n>`, or a bare PR number (assume the current repo, `HANSEL-LI/calibre-onchain`).
2. If `$ARGUMENTS` is empty, stop and ask the user for a PR URL or number.
3. Load PR metadata using the parsed ref — do **not** rely on `git branch --show-current`:
   - `gh pr view <ref> --json number,title,body,baseRefName,headRefName,headRepository,headRepositoryOwner,state,url`
   - `gh pr diff <ref>`
   - `gh pr diff <ref> --name-only`
   - commit list: `gh pr view <ref> --json commits --jq '.commits[] | "\(.oid[0:7]) \(.messageHeadline)"'`
4. Do **not** `gh pr checkout` and do **not** mutate the working tree. Review from diff + file reads against the base branch on disk; if a file in the diff differs from `main`, read the PR version via `gh pr diff <ref>` hunks rather than switching branches. If you need to run `forge test` or a package suite to discharge a correctness concern, add an **isolated git worktree** off the PR branch (`git worktree add /tmp/prr-<n> <headRefName>`), run there, and remove it (`git worktree remove /tmp/prr-<n> --force`) when done — never build in the shared checkout, and never leave the worktree behind.

## Then follow `PR_REVIEW.md`

Read `PR_REVIEW.md` (in this skill dir) in full and execute its procedure:

- the required reading order (PR_REVIEW.md → `README.md` — especially the **Public / private boundary contract** + **Package map** → `docs/ARCHITECTURE.md` → the touched package + its tests → diff → changed files → tests)
- the 9-question checklist under "What to review for" — work through it explicitly
- the review-discipline labels (OBSERVED / INFERENCE / UNVERIFIED)
- the exact output format at the bottom of PR_REVIEW.md
- post the review as a PR comment per that file's instructions, using the PR number parsed from `$ARGUMENTS`

The `PR_REVIEW.md` path is co-located in this skill directory.

Everywhere PR_REVIEW.md says "the current branch" or "this PR", substitute the PR identified by `$ARGUMENTS`.

## After the review is posted

Post the review comment and stop. This repo has no review-executor routine and no `cn` skill — auto-applicable concerns are surfaced in the review for a human (or a follow-up build session) to apply; do not attempt to fix and push from this review pass unless the user explicitly asks.
