---
name: ai-code-tracker
description: Use when preparing to modify code in this opencode project, or when the user wants to install, enable, repair, or inspect AI code contribution tracking in this git repository.
---

# AI Code Tracker

Run this skill before modifying code in this repository.

## Preflight

Check whether tracking is installed and healthy:

```bash
node .opencode/skills/ai-code-tracker/scripts/install.js --check
```

If preflight reports missing or broken tracking, ask the user whether to install or repair it before modifying code.

If the user confirms, run:

```bash
node .opencode/skills/ai-code-tracker/scripts/install.js
```

For broken installs, run:

```bash
node .opencode/skills/ai-code-tracker/scripts/install.js --repair
```

After install or repair, rerun preflight. Continue with the original code task only after preflight passes.

If install or repair changed `.opencode/plugins/ai-code-tracker.js`, tell the user to restart the current opencode session before expecting edit tracking to work. opencode loads project plugins at startup, so a session that was already running before installation may not generate `.ai-tracking/pending-lines.json`.

If this skill directory has just been copied into a project, this is enough. The install script self-registers the project plugin, git hooks, Claude Code hooks, `.ai-tracking/` files, and `AGENTS.md` rule from inside `.opencode/skills/ai-code-tracker/`.

## View Stats

```bash
node .opencode/skills/ai-code-tracker/scripts/ai-code-stats.js --last 10
```

## Cherry-pick

When cherry-picking commits, always use `git cherry-pick -x` to preserve the source commit reference. This allows ai-code-tracker to copy the original AI line statistics into the cherry-picked commit's tracking record. Without `-x`, the cherry-picked commit will be recorded with `ai_lines=0`.

## Recovery

If tracking fails because a temporary file or `.lock` file is blocked, read:

```bash
cat .ai-tracking/errors.log
```

Tell the user which file is blocking tracking. After the user releases the file lock or deletes a stale `.ai-tracking/*.lock` / `*.tmp` file that no tracker process is using, retry the same opencode edit, `git commit`, or `git push` action. The tracker regenerates the pending data, CSV record, or push archive on the next successful retry.

## Notes

- This is project-local only. Do not write to global opencode config or global command directories.
- To use in another project, copy this directory to `.opencode/skills/ai-code-tracker/`, then ask opencode to use `ai-code-tracker`.
- `is_ai_commit` means the commit was created by an AI agent (opencode, Claude Code, or codeagent), detected via process tree inspection.
- `ai_tool` records the first agent that edited the AI-tracked lines for a commit; it is independent of who ran `git commit`.
- CSV files are pruned on tracker runs so records for commits no longer reachable from `HEAD` after reset are removed.
- Cherry-picked commits with `-x` inherit AI line statistics from the source commit.
- Before `git push`, pending tracking files are archived under `.ai-tracking/archive/` and removed from active tracking so old AI lines do not affect the next editing session.
- Temporary file and lock failures are logged to `.ai-tracking/errors.log`; the log is ignored by git and the failed operation can be retried after the lock is cleared.
- Never include `[ai-tracking]` in commit messages manually. The tracker appends this suffix automatically via `git commit --amend` after recording the commit to CSV. If the suffix is already present, the post-commit hook skips the commit entirely, causing it to never be tracked in the CSV.
- The OpenCode project plugin in `.opencode/plugins/ai-code-tracker.js` tracks edits made by OpenCode tools.
- See `references/design.md` for details.
