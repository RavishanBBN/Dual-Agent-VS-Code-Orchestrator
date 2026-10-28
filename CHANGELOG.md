# Changelog

All notable changes are documented here. This project follows semantic versioning.

## [2.0.0] - 2026-10-28

A native VS Code interface replaces the webview dashboard, and the improvement proposals from the 1.0 review are implemented. Implementation runs now edit an isolated Git worktree by default, and plan approval is on by default; set `dualAgent.isolation.mode` to `none` and `dualAgent.workflow.approvePlan` to `false` for 1.x behavior.

### Changed

- **Native interface.** The Dual Agent activity-bar container now holds a **Runs** tree view (runs, stages, check results, warnings, changed files) and an **Agents** view (Claude Code, Codex, and Git health), with a welcome view, title and context-menu actions, Command Palette commands, a status bar item, and a **Dual Agent** output channel. Stage outputs, check logs, and reports open as read-only documents, and changes open in the built-in diff editors. The webview, its HTML/CSS/JS assets, and its message protocol are removed.
- Objectives are typed in an input box or taken from the active editor's selection; in a multi-root workspace you choose the folder (previously the first folder was always used).
- The final Claude stage writes the completion report read-only. Fixes after the final verification happen only in fix rounds that are verified again.
- A run's status now reflects the final gate: `completed` only when the last verification passed, otherwise `completed-with-findings`.
- The manifest no longer lists `activationEvents`; VS Code derives them from the contributed views and commands.

### Added

- **Verification gate.** Review stages end with a machine-readable `verdict` block that is parsed into an outcome and findings by severity. A failing, missing, or unparseable verdict, or a failing verification command, fails the final gate. Claude then gets up to `dualAgent.workflow.maxFixRounds` fix rounds (default 1), each followed by a fresh Codex re-verification.
- **Extension-run checks.** `dualAgent.verification.commands` run after every editing stage, and `dualAgent.isolation.setupCommands` once in a new worktree. Each is an argument list run without a shell, resolved outside the workspace, with the allowlisted environment and a timeout (`dualAgent.verification.timeoutMinutes`). Exit codes are reported to reviewers as reliable evidence, and the output is fenced as untrusted.
- **Isolated worktrees.** `dualAgent.isolation.mode` (default `worktree`) runs implementation in a detached worktree. Its base includes your uncommitted and untracked work, and your branch, index, stash, and files are not touched. **Review Changes** opens every change in the multi-file diff editor. **Apply Changes** checks the whole patch for conflicts and writes the working tree only, and **Discard Changes** deletes the worktree.
- **Plan approval.** `dualAgent.workflow.approvePlan` (default on) pauses before the first editing stage. You can open the plan beside its review, approve, approve with guidance that later prompts include, or reject.
- **Session continuity.** `dualAgent.claude.resumeSessions` (default on) continues the previous Claude session in later Claude stages and leaves Claude's own earlier output out of the prompt. If the session is gone, the stage reruns in a new session automatically.
- **Resume Run.** Failed and cancelled runs continue from their first unfinished stage, keeping completed stages and an earlier approval. Runs interrupted by closing VS Code are marked cancelled on the next start.
- `npm run smoke`: an automated test inside a real VS Code. It completes a run against fake CLIs and reviews a worktree's changes in the diff editors.

### Security

- Every Git command the extension runs disables hooks (`core.hooksPath` set to the null device). Worktree checkout, staging, and ref updates would otherwise run repository hooks, which an agent with write access could plant.
- Executables for agents, Git, and configured commands exclude the workspace, the worktree, and the repository root.
- Untracked files whose names suggest secrets are never copied into a worktree, so they are not written into the repository's object database.
- Worktree deletion refuses any path outside the extension's storage, and runs whose changes have not been applied or discarded are never pruned from history.
- Agent text reaches tooltips only Markdown-escaped in untrusted `MarkdownString`s, so injected `command:` links cannot activate.
- Claude session IDs that could be read as command-line flags are rejected.

### Fixed

- A Claude error result reported only in `errors` (for example an unknown session) now surfaces that message instead of a generic subtype.
- Path containment checks resolved Windows short names (such as `C:\Users\RUNNER~1`) and linked directories only for paths that already existed. A path that does not exist yet is now resolved through its deepest existing parent. Previously untracked files were not copied into a worktree under such a folder, and a new file under a linked directory that points elsewhere counted as inside.

## [1.1.0] - 2026-10-28

Security hardening release. Upgrade from 1.0.0 and rebuild any distributed VSIX: the first and fourth items under Security can be exploited by a malicious repository.

### Security

- Agent CLIs and Git are resolved to absolute paths that never come from the workspace. On Windows a `codex.cmd`, `claude.cmd`, or `git.exe` planted in the repository root previously ran instead of the real tool, outside any sandbox, and an agent that could write files could plant one for the next stage.
- Cancellation and timeouts terminate the agent's whole process tree. On Windows, killing an npm `.cmd` shim previously left the real agent running and editing files, and the stage waited for it.
- A cancellation that arrives while a Git snapshot is being taken now stops the stage; previously the agent ran to completion with its full permissions.
- Claude stages pass `--setting-sources user` and `--strict-mcp-config`, so repository hooks, permission rules, and MCP servers no longer apply in print mode, which skips Claude Code's folder-trust prompt.
- The extension declares that it does not support untrusted or virtual workspaces, and checks workspace trust before running.
- Agents receive an allowlisted environment instead of the full extension-host environment. Subscription mode also removes `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_BASE_URL`, and `AZURE_OPENAI_API_KEY`, ignoring case on Windows.
- Failures are classified from provider error reports and stderr only, with word-boundary patterns. Previously the whole output stream, including repository text, decided whether a failed write stage fell back to the other provider.
- Untrusted prompt content is fenced with a random per-prompt boundary, and forged closing tags are escaped. The stage contract is restated after the evidence, as the threat model already claimed.
- All settings are machine-scoped and read only from user settings; numeric settings are clamped and model names and tool rules validated.
- Git snapshots disable filesystem monitors, external diff and textconv drivers, and optional index locks.
- The webview receives only the fields it renders, validates incoming messages, and uses a cryptographic CSP nonce.
- Reports are exported to the home folder by default instead of the repository.

### Fixed

- The orchestrator could be left permanently "already running" when saving the run failed, and a corrupted `runs.json` broke every save; unreadable history is now set aside.
- Git failures such as "dubious ownership" produced an empty diff silently. They are now run warnings, and implementation workflows require a working Git repository.
- Staged changes and new untracked files were missing from the review diff.
- A fallback attempt reused the snapshot taken before the failed attempt.
- Process output was buffered without limit, and every activity event sent the complete run record to the webview.
- A process that exited before reading its prompt could raise an unhandled `EPIPE` error.
- Settings changed during a run were never applied; `history.maxRuns` changes required a reload.
- Usage reported by failed attempts was discarded.
- Claude error results (`is_error`) and Codex `turn.failed` events could be accepted as stage output.
- Prompt truncation could cut through a block boundary or drop the newest stage output.
- The write-consent checkbox did not hide for brainstorming.

### Added

- `dualAgent.claude.allowedTools`: Claude permission rules for write stages, so Claude can run approved commands such as tests in print mode.
- `dualAgent.environment.passthrough`: extra environment variables for agents.
- Run warnings in the dashboard and exported report.
- Regression tests for each vulnerability above, fake-CLI adapter tests, and Git snapshot tests. Coverage now includes the process runner, adapters, and Git snapshot.

## [1.0.0] - 2026-10-27

### Added

- Claude-led seven-stage implementation workflow.
- Claude-led five-stage reciprocal brainstorming workflow.
- Codex JSONL and Claude stream-JSON adapters.
- Read-only and workspace-write permission mapping.
- Explicit implementation write consent.
- Subscription-only child-process environment mode.
- Git-aware bounded checkpoint context.
- Quota, timeout, and unavailable-provider fallback.
- Durable private run history and Markdown report export.
- VS Code activity-bar dashboard and command-palette actions.
- Strict TypeScript, ESLint, Vitest coverage, esbuild, VSIX packaging, and CI.
- Architecture, workflow, security, operations, development, status, and ADR documentation.
