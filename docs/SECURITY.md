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
- Git and configured setup and verification commands are resolved the same way. In worktree runs the worktree, the workspace, and the repository root are all excluded.

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

### Conflicting writes and unreviewed changes

Stages are sequential. Only implementation and fix stage contracts receive workspace-write permission, and only when the run has explicit write consent. Without consent every stage is downgraded to read-only. Claude owns write stages normally; if bounded fallback is enabled, Codex can inherit the same explicit stage permission after an eligible quota, availability, or timeout failure, and that reassignment is persisted. Normal Codex review stages use read-only sandboxing.

In the default `worktree` isolation mode, agents run in a detached Git worktree in the extension's private storage, so their edits never touch the user's working tree during the run. The changes reach the workspace only when the user applies them, after reviewing them in the diff editor. Applying writes the working tree only, never the index or a commit. The whole patch is checked with `git apply --check` first, so a conflict with the user's own edits writes nothing. The apply confirmation lists every file and calls out symbolic links and runs that did not pass the gate. Deleting a worktree is refused for any path outside the extension's worktree directory, whatever the run history says, and runs with unapplied changes are never pruned from history.

Plan approval (on by default) stops the run before the first editing stage until the user approves Claude's plan and Codex's review of it. The final completion stage is read-only, so nothing changes after the last verification.

Implementation workflows refuse to start unless Git can describe the workspace, so every change remains reviewable and revertible.

Residual risk: Claude's accept-edits mode limits edits to its working directory, but is not an operating-system sandbox. Provider tools, user-level hooks, or external processes may behave outside the extension's assumptions. In `none` isolation mode agents edit the workspace directly. Review local CLI configuration and managed policies.

### Extension-run commands

Setup and verification commands (`dualAgent.isolation.setupCommands`, `dualAgent.verification.commands`) give reviewers deterministic evidence, but they run repository code: `npm ci` runs dependency install scripts, and `npm test` runs whatever test and source files the agents last wrote. They run with the user's permissions and outside every agent sandbox, so an agent able to write files could turn a verification run into arbitrary code execution. The controls are:

- commands exist only in machine-scoped user settings, so a repository cannot add one;
- every run that will execute them lists them in the consent dialog, and every resume asks again;
- each command is an argument vector run without a shell; its executable is resolved like an agent CLI and is refused inside the workspace or worktree, so a planted `npm.cmd` or `node_modules/.bin` entry never runs;
- commands receive the same allowlisted environment as agents, with billing variables removed in subscription mode;
- each command has a timeout, process-tree termination on cancel, and bounded captured output;
- their output is fenced as untrusted evidence; only the exit code is presented as reliable.

Residual risk: a configured command is exactly as trustworthy as the code it runs. Use them only in repositories where you would run that command yourself after an agent edit, and prefer worktree isolation so the commands run against the isolated copy.

### Git hooks and configuration

Every Git command the extension runs sets `core.hooksPath` to the null device, so no repository hook runs. This matters because the extension's own worktree commands (checkout, staging, ref updates) would otherwise run `post-checkout`, `reference-transaction`, and similar hooks from `.git/hooks`, where an agent with write access could plant them. Commands also set `core.fsmonitor=false` and `--no-optional-locks`, and diffs use `--no-ext-diff` and `--no-textconv`, so repository-local configuration cannot run a filesystem monitor or diff driver. A test plants hooks in a repository, confirms that plain Git runs them, and confirms that the extension's worktree lifecycle never does.

Clean and smudge filters configured by the user (Git LFS, for example) still run during worktree checkout and staging, because they come from the user's own configuration and are needed for correct content.

### Runaway processes

Cancellation and timeouts terminate the agent's whole process tree: `taskkill /T /F` on Windows, and on other platforms a signal to the process group the agent was started in. Killing only the direct child is not enough, because an npm `.cmd` shim runs the real CLI as a grandchild of `cmd.exe`. The runner never waits indefinitely: if an escaped descendant keeps the output pipes open, the stage settles after a short grace period. A signal that was cancelled before the process started is honored, and the extension cancels any active run when it is deactivated.

### Fallback steered by repository content

Failures are classified from the provider's structured error (Claude `result` events with `is_error`, Codex `turn.failed` and `error` events) or the process's stderr, using word-boundary patterns. The agent's output stream is never classified, because it contains repository text: before 1.1.0, a file containing `AbortController` or `timeoutMs` could decide whether a failed write stage was retried by the other provider. An error result is never accepted as stage output. Error details are capped at 2,000 characters before they are persisted or displayed.

### Command injection

Commands and arguments are passed as arrays with `shell: false`; prompts are sent through stdin. The extension does not interpolate user prompts into a shell command. Model names must match a conservative pattern, and Claude tool rules may not start with `-`, so neither can be read as an extra CLI flag.

### Verdicts and session continuity

Verdicts are parsed from model output, which repository content can influence. A verdict therefore only decides whether a fix round runs and how the run is labelled; it never grants a permission, skips consent, or applies changes. The last verdict block is used so that quoted repository text earlier in the output is not taken as the verdict, and an unparseable verdict counts as a failure, never a pass.

Continuing a Claude session (`--resume`) carries the session's earlier turns, including repository content already read, into the next stage. That content was already in Claude's context; each new prompt still fences new evidence with a fresh boundary and restates the stage contract. Session IDs that could read as command-line flags are rejected.

### Accidental API charges

Subscription mode removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, and `AZURE_OPENAI_API_KEY`, ignoring case on Windows. The passthrough setting cannot add them back. Environment billing is an explicit machine-level choice.

Residual risk: provider-specific credential configuration outside these variables, such as a Claude `apiKeyHelper` in user settings, can affect billing. Confirm account status in each official CLI.

### Data leakage

There is no extension-owned server and no web view. Run records and worktrees remain in private VS Code storage. Agent output is shown only as tree-item text, as tooltips built from untrusted `MarkdownString`s with the text Markdown-escaped (so links, including `command:` links, never activate and no HTML renders), and in read-only text documents served by the extension. Untracked files whose names suggest secrets are never copied into a worktree, which would otherwise write them into the repository's object database through the base commit. Export requires an explicit save action and defaults to the home folder rather than the repository, so a report containing prompts and agent output is not committed by accident.

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
- [ ] Setup and verification commands are ones you would run yourself after an agent edit.
- [ ] `dualAgent.isolation.mode` is `worktree` unless there is a specific reason to edit the workspace directly.
- [ ] The plan was read before approval, and the diff was reviewed before applying it.
- [ ] Unresolved findings and failing checks were read before applying a run that did not pass its gate.
- [ ] User-level hooks, skills, agent configuration, and any `.codex` project configuration are understood.
- [ ] Run warnings in the Runs view or report have been read.
- [ ] Exported reports are stored in an approved location.

## Reporting vulnerabilities

See the repository-level [SECURITY.md](../SECURITY.md). Do not include tokens, credentials, private prompts, or proprietary repository content in a report.
