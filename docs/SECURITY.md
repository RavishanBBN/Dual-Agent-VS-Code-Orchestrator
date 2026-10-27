# Security and threat model

## Protected assets

- source code and uncommitted user changes;
- agent subscription credentials and API keys;
- other secrets in the extension host's environment and on disk;
- command execution authority;
- private prompts, diffs, and run history;
- billing choice and usage limits;
- integrity of review and approval records.

## Threats and controls

### Repository-planted executables

Windows looks in the current directory before `PATH` when it resolves a bare command name, and every agent and Git command runs with the workspace as its current directory. Before 1.1.0, a repository containing `codex.cmd`, `claude.cmd`, or `git.exe` at its root had that file run instead of the real tool, outside any agent sandbox, before any model call. An agent allowed to write files could also create `codex.cmd`, and the next stage ran it unsandboxed.

Controls:

- `resolveExecutable` turns every command into an absolute path. It never consults the current directory, skips relative `PATH` entries such as `.`, and refuses any candidate (or `PATH` entry) inside the workspace, including through symbolic links.
- A configured absolute path inside the workspace is refused, as is a relative path such as `tools\codex`.
- The process runner refuses to start anything that is not an absolute path, and refuses batch shims when `COMSPEC` is not absolute.
- Child processes receive `NoDefaultCurrentDirectoryInExePath=1` on Windows, so command lookups made by agent tools also skip the current directory.
- Git is resolved the same way before every snapshot.

Regression tests plant a same-named launcher, and on Windows a `git.exe`, in a temporary workspace and assert they never run.

### Credential theft

The extension never reads provider credential files. Official CLIs own sign-in and renewal. Every setting is machine-scoped and read from user settings only, so repository configuration cannot replace a binary, switch billing, or raise limits.

Agents receive an allowlisted environment: `PATH`, home, profile, and temp locations, locale, proxy and TLS settings, and the CLIs' configuration directories. Tokens such as `GITHUB_TOKEN`, cloud credentials, and `SSH_AUTH_SOCK` are withheld unless the user lists them in `dualAgent.environment.passthrough`. This matters because agents run tools, and a prompt-injected tool call could otherwise read and send those values.

Untracked files whose names suggest secrets (`.env*`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, names containing `secret`, `credential`, or `password`, and similar) are listed in prompts without their content. Symbolic links and files resolving outside the workspace are never read.

Residual risk: an agent with read access can still open any file the CLI's own sandbox allows. A malicious binary already selected by the user has the authority of the extension host process. Install CLIs from official sources.

### Repository-controlled agent configuration

Claude Code skips its folder-trust prompt in print mode (`-p`), so a repository's `.claude/settings.json` hooks, permission rules, and MCP server approvals would apply without consent. Hooks are shell commands and run even in plan mode. Claude stages therefore pass `--setting-sources user` and `--strict-mcp-config`: only the user's own Claude settings load, and no MCP servers start.

The extension declares `untrustedWorkspaces: false`, so VS Code disables it in Restricted Mode, and it checks `workspace.isTrusted` before starting a run.

Residual risk: Codex applies project configuration according to its own trust settings. The extension records a warning when a workspace contains a `.codex` directory but does not disable it. User-level Claude hooks and managed policies still apply.

### Prompt injection from repository or agent output

Repository status, diffs, untracked file contents, and prior model responses are enclosed in blocks whose tags carry a random 16-hex-character boundary generated for each prompt. Untrusted text cannot know the boundary. Any occurrence of it is removed, and any opening or closing tag for these block names inside untrusted text is escaped (`&lt;/workspace-diff`), so content cannot close its block early and pose as orchestrator text. The stage contract appears before the evidence and is restated after it, and permissions remain outside model control.

Prompts are budgeted per section. The objective share, both copies of the stage contract, and the output requirements are always kept, so truncation never cuts through a block or drops the restated contract.

Residual risk: models can still follow adversarial content. Sandbox boundaries, human review, and deterministic validation are required.

### Conflicting writes

Stages are sequential. Only implementation/fix stage contracts receive workspace-write permission, and only when the run has explicit write consent. Without consent every stage is downgraded to read-only. Claude owns write stages normally; if bounded fallback is enabled, Codex can inherit the same explicit stage permission after an eligible quota, availability, or timeout failure, and that reassignment is persisted. Normal Codex review stages use read-only sandboxing.

Implementation workflows refuse to start unless Git can describe the workspace, so every change remains reviewable and revertible.

Residual risk: provider tools, hooks, or external processes may behave outside the extension's assumptions. Review local CLI configuration and managed policies.

### Runaway processes

Cancellation and timeouts terminate the agent's whole process tree: `taskkill /T /F` on Windows, and on other platforms a signal to the process group the agent was started in. Killing only the direct child is not enough, because an npm `.cmd` shim runs the real CLI as a grandchild of `cmd.exe`. The runner never waits indefinitely: if an escaped descendant keeps the output pipes open, the stage settles after a short grace period. A signal that was cancelled before the process started is honored, and the extension cancels any active run when it is deactivated.

### Fallback steered by repository content

Failures are classified from the provider's structured error (Claude `result` events with `is_error`, Codex `turn.failed` and `error` events) or the process's stderr, using word-boundary patterns. The agent's output stream is never classified, because it contains repository text: before 1.1.0, a file containing `AbortController` or `timeoutMs` could decide whether a failed write stage was retried by the other provider. An error result is never accepted as stage output. Error details are capped at 2,000 characters before they are persisted or displayed.

### Command injection

Commands and arguments are passed as arrays with `shell: false`; prompts are sent through stdin. The extension does not interpolate user prompts into a shell command. Model names must match a conservative pattern, and Claude tool rules may not start with `-`, so neither can be read as an extra CLI flag.

### Git configuration

Snapshots run Git with `core.fsmonitor=false`, `--no-optional-locks`, `--no-ext-diff`, and `--no-textconv`, so repository-local configuration cannot run a filesystem monitor or diff driver, and snapshots do not take index locks that would contend with an agent's own Git commands.

### Accidental API charges

Subscription mode removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, and `AZURE_OPENAI_API_KEY`, ignoring case on Windows. The passthrough setting cannot add them back. Environment billing is an explicit machine-level choice.

Residual risk: provider-specific credential configuration outside these variables, such as a Claude `apiKeyHelper` in user settings, can affect billing. Confirm account status in each official CLI.

### Data leakage

There is no extension-owned server. Run records remain in private VS Code storage. The dashboard webview receives stage titles, status, usage, and warnings, but never stage outputs or raw provider events. Export requires an explicit save action and defaults to the home folder rather than the repository, so a report containing prompts and agent output is not committed by accident.

Residual risk: each provider receives the context sent to its CLI according to that provider's account and data policies. Do not use repositories or accounts that are not authorized for the data involved.

### Denial of service and runaway usage

Stages have timeouts; Claude has a maximum turn count; workflows have finite stage lists; cancellation terminates the process tree; fallback is attempted once. Captured process output is bounded (the last 64 KB per stream), as are Git output (4 MB, with a visible truncation warning) and untracked file content. A corrupted run-history file is set aside rather than blocking every save.

## Security review checklist

- [ ] CLI binaries come from official distributions.
- [ ] `billingMode` matches the intended account/billing source.
- [ ] Workspace is trusted and local.
- [ ] No secrets are visible in the diff or prompt.
- [ ] Write consent is appropriate for the objective.
- [ ] `dualAgent.claude.allowedTools` grants only the commands this repository needs.
- [ ] Git working tree has been reviewed before and after the run.
- [ ] User-level hooks, skills, agent configuration, and any `.codex` project configuration are understood.
- [ ] Run warnings in the dashboard or report have been read.
- [ ] Exported reports are stored in an approved location.

## Reporting vulnerabilities

See the repository-level [SECURITY.md](../SECURITY.md). Do not include tokens, credentials, private prompts, or proprietary repository content in a report.
