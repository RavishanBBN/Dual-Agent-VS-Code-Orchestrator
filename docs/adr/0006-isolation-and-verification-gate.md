# ADR-0006: Isolated worktrees and a verification gate

**Status:** accepted

**Date:** 2026-10-28

## Context

In 1.x a run edited the user's working tree directly, nothing read Codex's final verdict, and checks reported by agents were only claims: Claude in print mode runs only shell commands that a rule allows or that Claude Code judges read-only, and Codex's read-only sandbox blocks most test runners. A run was therefore marked completed even when the final review failed it. Its last stage could also still edit files after that review, and a cancelled run left partial edits in the workspace.

Running verification commands from the extension was deferred in 1.1 because those commands execute code the agents wrote, outside every sandbox.

## Decision

- **Worktree isolation (default).** An implementation run creates a detached worktree in private storage. Its base commit captures `HEAD` plus uncommitted and untracked work, made with `git stash create` and plumbing commands so the user's branch, index, stash, and files are untouched. Agents, snapshots, and checks run there. The user reviews the diff and applies it with a whole-patch `git apply --check` first, or discards it.
- **Hooks disabled.** Every Git command the extension runs sets `core.hooksPath` to the null device, because the worktree lifecycle would otherwise run repository hooks that an agent could plant.
- **Extension-run commands.** Optional setup commands run once in the worktree, and verification commands after every editing stage. They are argument vectors from machine-scoped user settings, resolved outside the workspace, given the allowlisted environment, and listed in the consent dialog for each run. Their exit codes are presented to reviewers as reliable; their output is fenced as untrusted.
- **Verdicts and gate.** Review stages end with a fenced `verdict` JSON block. The final gate passes only with a `pass` verdict and passing verification. A failed gate adds a Claude fix stage and a fresh gated Codex verification, up to `dualAgent.workflow.maxFixRounds` (default 1, maximum 3); after that the run ends as `completed-with-findings`. The completion stage is read-only.
- **Plan approval.** Implementation pauses before the first editing stage until the user approves (optionally with guidance) or rejects.
- **Continuity.** Claude stages continue the run's previous Claude session; failed and cancelled runs can be resumed from the first unfinished stage.

## Consequences

- Changes reach the workspace only by a deliberate, conflict-checked apply; the agents' diff excludes the user's own uncommitted work.
- Worktrees lack ignored files (`node_modules`, `.env`), so checks may need a setup command.
- Configured commands are a deliberate, consented exception to "nothing runs outside a sandbox"; the threat model documents it.
- A failing gate can cost one to three extra pairs of stages; fix rounds are bounded and can be disabled.
- The verdict is model output: it selects fix rounds and the run's label, never permissions.
- Codex stages still start fresh sessions, because Codex's resume flags could not be verified and independence is useful in review.
