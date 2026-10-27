# Changelog

All notable changes are documented here. This project follows semantic versioning.

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
