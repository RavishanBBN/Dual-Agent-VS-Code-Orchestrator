# Security and threat model

## Protected assets

- source code and uncommitted user changes;
- agent subscription credentials and API keys;
- other secrets in the extension host's environment and on disk;
- command execution authority, including the user's decisions on Agent-mode permission requests;
- the user's machine outside the folder, which Agent mode can change;
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

### Signing in from VS Code

**Dual Agent: Sign In** and **Sign Out**, and the sign-in status in the Agents view and the chat, use only each CLI's own commands (`src/adapters/accounts.ts`):

- **The CLI's own flow.** A browser or device-code sign-in runs in a VS Code terminal that starts the CLI directly, resolved outside the workspace by `resolveExecutable`, with no shell; a Windows batch shim starts through the absolute `COMSPEC`, as agent processes do. The terminal gets the agents' allowlisted environment (`strictEnv`), so the sign-in lands in the configuration folders the agents read and no other variables reach it.
- **Status without credentials.** Claude's status comes from `claude auth status --json` and Codex's from `codex login status`. Gemini CLI has no status command, so only the sign-in type in `~/.gemini/settings.json` and the presence of `GEMINI_API_KEY` or `GOOGLE_API_KEY` are checked; its credential file is never opened. The account's email is shown only in the Agents view and its tooltips, on this machine.
- **API keys.** A Codex API key is typed into a password box and written to `codex login --with-api-key` on standard input. It is not logged, stored, or passed as an argument, where other processes could read it.
- **Sign-out asks first,** because it signs the CLI out everywhere on the machine that uses the same configuration.

**Refresh** in the limits meter makes one model call to each agent, in an empty folder in private storage, with a fixed prompt and read-only permissions, only when the user asks.

### Repository-controlled agent configuration

Claude Code skips its folder-trust prompt in print mode (`-p`), so a repository's `.claude/settings.json` hooks, permission rules, and MCP server approvals would apply without consent. Hooks are shell commands and run even in plan mode. Claude stages therefore pass `--setting-sources user` and `--strict-mcp-config`: only the user's own Claude settings load, and no MCP servers start. In Agent mode `--mcp-config` adds exactly one server, the extension's permission bridge.

With `dualAgent.claude.userMcpServers` on (off by default), Claude stages leave out `--strict-mcp-config`, so the MCP servers in the user's own Claude configuration can start. A server can read and send data, so this is the user's choice, made in user settings only. Settings still load from the user's configuration only, and calling a server's tool without a prompt still needs a rule in `dualAgent.claude.allowedTools`.

The extension declares `untrustedWorkspaces: false`, so VS Code disables it in Restricted Mode, and it checks `workspace.isTrusted` before starting a run.

Residual risk: Codex applies project configuration according to its own trust settings. The extension records a warning when a workspace contains a `.codex` directory but does not disable it. User-level Claude hooks and managed policies still apply. With `dualAgent.claude.userMcpServers` on, which servers start is decided by Claude Code, as in the user's terminal: those in the user's configuration, and possibly a repository's `.mcp.json` servers that the user approved in Claude Code.

### Claude tool access

Plan mode alone does not make a Claude stage read-only. In the first live 2.0.0 brainstorming run, Claude ran nine shell commands during plan-mode stages, including `node -e` scripts, and wrote its plan to `~/.claude/plans`. The session also offered Bash, PowerShell, WebFetch, and tools that publish or send content. In print mode Claude Code runs commands it judges read-only without asking, and that judgment is not a boundary: a `node -e` script can write any file.

Claude stages therefore pass an explicit `--tools` list. Read-only stages get Read, Grep, Glob, and TodoWrite (Claude's own task list, which does not touch the workspace), and nothing else. Write stages add Edit, Write, and NotebookEdit, plus the tool each `dualAgent.claude.allowedTools` rule names (`Bash` for `Bash(npm test:*)`). Agent-mode stages get the full list described in [Agent mode and the permission bridge](#agent-mode-and-the-permission-bridge). Tested live with Claude Code 2.1.312: a read-only stage could read files but had no Bash, and its Write attempts failed ("disabled for this session, in subagents as well as here"); a write stage without rules had no Bash; a `Bash(node:*)` rule made that command run. A Claude Code version without `--tools` stops with an unknown-option error, so the stage fails rather than running unrestricted.

Residual risk: once a rule adds Bash, Claude Code also runs other commands it judges read-only. These restrictions are enforced by Claude Code, not by an operating-system sandbox.

### Agent mode and the permission bridge

Agent mode deliberately gives the lead agent the authority Claude Code has in a terminal: it runs commands, installs packages, and edits files in the user's folder, on the user's machine. The controls bound how that authority is granted, not what an allowed command can do.

- **Consent first.** Every Agent message needs the consent card, which says that the agent works in the folder itself, that Claude asks before commands and edits, how Codex is sandboxed, and that installs and other effects outside the folder cannot be undone.
- **Claude's tools.** Read, Grep, Glob, TodoWrite, Edit, Write, NotebookEdit, Bash, WebSearch, and WebFetch, plus tools named by `dualAgent.claude.allowedTools` rules. Claude Code runs with `--permission-mode default` and `--permission-prompt-tool mcp__dualagent__approve`. It runs by itself what it judges read-only and what the user's own allow rules match (`dualAgent.claude.allowedTools` and the user's Claude settings); it sends everything else to that tool.
- **The bridge.** The tool belongs to a small MCP server, `dist/permissionServer.js`, which Claude Code starts on VS Code's own runtime (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), an absolute path. The server has no access to VS Code. For each call it connects to the extension's broker, sends the tool name and input, and returns the decision; if it cannot reach the broker, or the reply is unreadable, it denies.
- **A private channel.** The broker listens on a named pipe on Windows, or a Unix socket in the temporary folder elsewhere, each with a random name. It answers only requests that carry a 32-byte random token, compared with `timingSafeEqual`, and refuses requests over 2 MB. The MCP configuration that holds the pipe name and the token is written to the extension's private global storage with mode 0600, and deleted when the extension stops. A local process that finds the pipe cannot get an answer without the token.
- **Decisions only from the user.** The broker asks the chat, which shows a card with a plain summary, the exact command or edit, and warnings for deletions, administrator rights, scripts piped from the internet, changes to the system, and paths outside the folder (`src/ui/chat/permissions.ts`). While the chat is hidden, a modal dialog asks instead. A new request replaces an unanswered one, which is denied; **Stop** and closing VS Code deny a pending request.
- **"For this message" ends with the run.** **Allow *tool* for this message** stops asking about that tool, by name, for the rest of the run, and the allowance is dropped when the run finishes. Nothing is ever allowed for a conversation or a workspace.
- **Codex cannot ask.** `codex exec` has no prompt, so Codex in Agent mode, leading or standing in, runs in its `workspace-write` sandbox: it writes only in the folder. With `dualAgent.codex.agentNetwork` on, the default, the sandbox can reach the network so that Codex can install packages; turning it off keeps Codex offline.
- **Same environment.** Agent processes, and the commands they run, still get the allowlisted environment, so tokens such as `GITHUB_TOKEN` and cloud credentials stay out of reach unless the user passes them through.
- **No bridge, no Agent mode for Claude.** If the broker cannot start, the output log says so, and a Claude Agent stage fails with an invalid-request error, which never falls back. Claude never runs Agent mode without the prompt.

What can be undone: file changes inside the folder, from the snapshot taken before the first stage (see [Direct edits and folder snapshots](#direct-edits-and-folder-snapshots)). What cannot: installed software, global configuration, changes to other folders, data sent over the network, and anything else outside the folder.

Residual risk: Claude Code's read-only judgement and the user's allow rules decide what runs without a prompt, as in a terminal session, and that judgement is not a boundary. An allowed command runs with the user's permissions, outside any sandbox, and can do anything the user can. Allowing Bash for a message allows every later command in that run. The warnings on the card are pattern matches, not an analysis. A prompt-injected Codex with network access can send data out from its sandbox. Use Agent mode only in folders and for tasks where you would run the agent in a terminal yourself, and read each command before allowing it.

### Prompt injection from repository or agent output

Repository status, diffs, untracked file contents, attachments, earlier conversation turns, the editor's file, selection, and problems, a referee's ruling, and prior model responses are enclosed in blocks whose tags carry a random 16-hex-character boundary generated for each prompt. Untrusted text cannot know the boundary. Any occurrence of it is removed, and any opening or closing tag for these block names inside untrusted text is escaped (`&lt;/workspace-diff`), so content cannot close its block early and pose as orchestrator text. The stage contract appears before the evidence and is restated after it, and permissions remain outside model control.

Prompts are budgeted per section. The objective share, both copies of the stage contract, and the output requirements are always kept, so truncation never cuts through a block or drops the restated contract.

The project brief is the user's own text, so it appears outside the untrusted blocks, as approval guidance does. It is stored in the extension's private workspace storage, never in the repository, so a repository cannot supply it.

Residual risk: models can still follow adversarial content. Sandbox boundaries, human review, and deterministic validation are required.

### Chat webview

The chat is the only webview. Its page is built into the extension package and receives agent output, repository text, and attachment names, so it is treated as an untrusted surface in both directions:

- **Content-Security-Policy.** `default-src 'none'`; scripts only with a per-load nonce, which only the bundled `chat.js` carries; styles and fonts only from the extension; images only from the webview's resource roots (the bundle and the attachment folder) or `data:` and `blob:` URIs. Nothing is fetched from the network.
- **Trusted Types.** The policy also requires Trusted Types (`require-trusted-types-for 'script'`) and allows only one policy, `dual-agent-markdown`, which only the Markdown renderer can use. Any other code that tried to assign HTML or create a script would be blocked even if an injection bug existed elsewhere. `base-uri 'none'` and `form-action 'none'` close the remaining navigation paths. Script errors and CSP violations are reported to the output log, and the smoke test asserts there are none.
- **No HTML from agents.** Agent Markdown is rendered with `html: false`, so raw HTML is escaped, and images are disabled, so a reply cannot load a tracking pixel. Links get `href="#"` with the target in a data attribute. Clicking one sends the target to the extension, which opens only `http`, `https`, and `mailto` links after a confirmation, and only files inside the conversation's folder or worktree. Every other target, such as `command:`, `vscode:`, `file:`, or `javascript:`, is refused. Command URIs are disabled for the webview.
- **Validated messages.** Every message from the page is checked for its type, field types, lengths, ID formats, and base64 before the extension acts on it, and anything malformed is dropped.
- **Same authority as the commands.** A message from the page can only ask for what the commands already do. Editing still needs the consent card, the single-run lock still applies, and apply and discard still use their modal confirmations.
- **No repository control.** The composer's models and efforts are stored in the extension's `globalState`, not in settings, and are validated again before each run, so a repository cannot change them.

Residual risk: a webview shares VS Code's renderer. A flaw in VS Code's webview isolation is outside this extension's control.

### Web access

Research stages, and any stage of a message for which the user turned on the **Web** toggle, may search and read the web. Claude gets its WebSearch and WebFetch tools; Codex runs with `--search`. This changes the boundary:

- **Data leaves the machine.** Search terms, page requests, and anything an agent puts into a URL reach search engines and web sites. A page or a repository file could try to steer an agent into putting workspace content into a URL. Web access is therefore off by default outside Research, shown on the composer, and chosen per message.
- **Untrusted pages.** Page content reaches the agents' context as evidence, like repository text. Agent output that quotes it is fenced in later prompts.
- **No other permission.** A stage with web access can still only read and search the workspace when it is read-only.
- **Agent mode.** The lead agent has the web, as in a terminal session: Claude through WebSearch and WebFetch, which go through the permission bridge unless Claude Code allows them by itself or the user's rules match, and Codex through `--search` and, with `dualAgent.codex.agentNetwork` on, its sandbox's network access.

Residual risk: a model can be misled by a page, or include sensitive context in a search. Do not turn on the web for workspaces whose content must not leave the machine.

### Editing stages that run your checks

Editing stages may run the user's verification commands themselves, through Claude Code prefix rules built only from arguments that need no quoting. These are the commands the user already configured and consented to for the extension to run after each edit, so no new command source is introduced. Once Bash is available, Claude Code also runs commands it judges read-only, as for configured tool rules.

### Attachments

Attachments are files the user chooses to send to both providers. The extension limits what it does with them:

- **Private storage.** Copies are stored in the extension's private workspace storage under a random ID and a platform-safe name, never in the repository, and are deleted with their conversation.
- **Limits.** At most 25 MB per file, and 20 files and 100 MB per message.
- **Detection by content.** A file is classified by its signature, not its name. Binary files other than images, PDFs, archives, and Office files are refused.
- **Safe unpacking.** Archives are unpacked as regular files only, never as links. Absolute, drive-letter, and `..` paths are refused, names are sanitized (including Windows device names and `:`), and limits apply: 5,000 entries, 200 MB unpacked, 50 MB per entry, and a compression ratio of 200. Nested archives are not unpacked.
- **Isolated PDF parsing.** PDFs are parsed in a worker thread with a memory limit and a 60-second timeout, so a hostile PDF cannot stall the extension host. Office files are read as XML text without executing anything.
- **Secret check.** Files whose names suggest secrets (`.env`, keys, credentials) need an extra confirmation before they are attached.
- **Untrusted contents.** Attachment contents reach prompts fenced as untrusted evidence. Claude reads the attachment folder through `--add-dir` with the same read-only tools; Codex reads it within its sandbox.

Residual risk: whatever you attach is sent to both providers under their data policies. Prompt injection inside an attachment is fenced, but a model can still be misled by it.

### Conflicting writes and unreviewed changes

Stages are sequential. Only editing stage contracts (implementation, Edit and Test first messages, repairs, and fix rounds) receive workspace-write permission, and only Agent-mode working stages the `agent` permission, in both cases only when the run has explicit write consent. Without consent every stage is downgraded to read-only. Claude owns write stages normally; if bounded fallback is enabled, Codex can inherit the same explicit stage permission after an eligible quota, availability, or timeout failure, and that reassignment is persisted. Normal Codex review stages use read-only sandboxing.

In the default `worktree` isolation mode, agents run in a detached Git worktree in the extension's private storage, so their edits never touch the user's working tree during the run. The changes reach the workspace only when the user applies them, after reviewing them in the diff editor. Applying writes the working tree only, never the index or a commit. The whole patch is checked with `git apply --check` first, so a conflict with the user's own edits writes nothing. The apply confirmation lists every file and calls out symbolic links and runs that did not pass the gate. Deleting a worktree is refused for any path outside the extension's worktree directory, whatever the run history says, and runs with unapplied changes are never pruned from history.

Plan approval (on by default) stops the run before the first editing stage until the user approves Claude's plan and Codex's review of it. The final completion stage is read-only, so nothing changes after the last verification.

Workflows that edit files refuse to start unless Git can describe the workspace, either as a repository or through the extension's snapshot of the folder, so every change remains reviewable and revertible.

Applying one file from the changes card uses the same `git apply --check` for that file. Undoing single changes in the diff editor's margin edits the isolated copy only.

Residual risk: Claude's accept-edits mode limits edits to its working directory, but is not an operating-system sandbox. Provider tools, user-level hooks, or external processes may behave outside the extension's assumptions. In `none` isolation mode agents edit the workspace directly. Review local CLI configuration and managed policies.

### Direct edits and folder snapshots

Agent mode, and Edit, Test first, and Implement in a folder without Git or without a commit, let the agents edit the user's folder itself rather than an isolated copy. The controls make those edits reviewable and reversible inside the folder:

- **Only after consent and a snapshot.** The agents start only after the user's consent and after `createFolderSnapshot` has recorded the folder's files as a commit. If the snapshot fails, nothing runs.
- **A bare repository in private storage.** The snapshot repository, `direct-<id>.git`, lives in the extension's worktree storage. Git reaches it through `GIT_DIR` and `GIT_WORK_TREE`, every command goes through `runGit` with hooks disabled, and nothing is written to the folder. Line-ending conversion and clean, smudge, and ident filters are off, so no configured program runs and undo restores the exact bytes.
- **No secrets in storage.** Files whose names suggest secrets (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`) are excluded, along with dependency and build folders and the folder's own ignored files. A folder of more than 20,000 remaining files is refused.
- **Undo touches only what the agents changed.** **Undo** restores the snapshot with `restoreWorktree`, and one file with `revertWorktreeFiles`, which refuses any path outside the folder. Files the agents created since the snapshot are deleted; excluded files and folders are never touched.
- **Removal stays in storage.** **Keep** and **Undo** delete only the snapshot repository, and `removeWorktree` refuses a snapshot path outside the extension's worktree storage. The folder itself is never deleted.

Residual risk: during the run the agents' edits are in the user's files at once, and setup and verification commands run there. Excluded files, including `.env` files and `node_modules`, are not restored by undo, and neither are changes inside a subfolder that is a Git repository of its own; the run warns about such subfolders. Once the user keeps the changes, Dual Agent can no longer undo them. A Git repository with a commit still gets an isolated worktree for Edit, Test first, and Implement.

### Extension-run commands

Setup and verification commands (`dualAgent.isolation.setupCommands`, `dualAgent.verification.commands`) give reviewers deterministic evidence, but they run repository code: `npm ci` runs dependency install scripts, and `npm test` runs whatever test and source files the agents last wrote. They run with the user's permissions and outside every agent sandbox, so an agent able to write files could turn a verification run into arbitrary code execution. The controls are:

- commands exist only in machine-scoped user settings, so a repository cannot add one;
- every run that will execute them lists them in the consent dialog, and every resume asks again;
- each command is an argument vector run without a shell; its executable is resolved like an agent CLI and is refused inside the workspace or worktree, so a planted `npm.cmd` or `node_modules/.bin` entry never runs;
- commands receive the same allowlisted environment as agents, with billing variables removed in subscription mode;
- each command has a timeout, process-tree termination on cancel, and bounded captured output;
- their output is fenced as untrusted evidence; only the exit code is presented as reliable.

Residual risk: a configured command is exactly as trustworthy as the code it runs. Use them only in repositories where you would run that command yourself after an agent edit, and prefer worktree isolation so the commands run against the isolated copy.

### Run and Terminal buttons

Shell code blocks in agent answers get **Run** and **Terminal** buttons. The command comes from agent output, which a repository or web page can influence, so neither button runs anything without the user:

- **No shell.** **Run** appears only on one-line blocks. `splitCommandLine` (`src/core/commandLine.ts`) splits the line into arguments, honoring quotes, and refuses anything only a shell understands: pipes, redirection, `;` and `&` chaining, backticks and `$(…)` substitution, and `$VAR`, `${…}`, and `%VAR%` variables. A refused command can still be pasted into a terminal, where the user runs it.
- **A confirmation.** A modal dialog shows the exact command and the folder, says it runs with the user's permissions, outside any agent sandbox, and without a shell, and asks the user to read it first.
- **The check runner.** The command runs through `runChecks`, like a verification command: its executable is resolved outside the folder (so a planted launcher or `node_modules/.bin` entry never runs), with the allowlisted environment, the verification timeout, process-tree termination, and bounded output. The output is attached to the user's next message as a file, where it is fenced and masked like any attachment.
- **Terminal only pastes, and only one line.** **Terminal** puts the command into a terminal named **Dual Agent** without adding Enter, after removing a leading `$ ` or `> ` prompt. It appears only on one-line blocks, and the extension refuses text with a line break, because a pasted line break would make the shell run what precedes it. A block of several lines can only be copied.

Residual risk: a command the user confirms, or runs after pasting, can do anything the user can.

### Git hooks and configuration

Every Git command the extension runs sets `core.hooksPath` to the null device, so no repository hook runs. This matters because the extension's own worktree commands (checkout, staging, ref updates) would otherwise run `post-checkout`, `reference-transaction`, and similar hooks from `.git/hooks`, where an agent with write access could plant them. Commands also set `core.fsmonitor=false` and `--no-optional-locks`, and diffs use `--no-ext-diff` and `--no-textconv`, so repository-local configuration cannot run a filesystem monitor or diff driver. A test plants hooks in a repository, confirms that plain Git runs them, and confirms that the extension's worktree lifecycle never does.

Clean and smudge filters configured by the user (Git LFS, for example) still run during worktree checkout and staging, because they come from the user's own configuration and are needed for correct content.

### Runaway processes

Cancellation and timeouts terminate the agent's whole process tree: `taskkill /T /F` on Windows, and on other platforms a signal to the process group the agent was started in. Killing only the direct child is not enough, because an npm `.cmd` shim runs the real CLI as a grandchild of `cmd.exe`. The runner never waits indefinitely: if an escaped descendant keeps the output pipes open, the stage settles after a short grace period. A signal that was cancelled before the process started is honored, and the extension cancels any active run when it is deactivated.

### Fallback steered by repository content

Failures are classified from the provider's structured error (Claude `result` events with `is_error`, Codex `turn.failed` and `error` events) or the process's stderr, using word-boundary patterns. The agent's output stream is never classified, because it contains repository text: before 1.1.0, a file containing `AbortController` or `timeoutMs` could decide whether a failed write stage was retried by the other provider. An error result is never accepted as stage output. Error details are capped at 2,000 characters before they are persisted or displayed. The `network` kind is classified the same way; whether it pauses the run or falls back depends only on the connectivity check, never on agent output.

### Command injection

Commands and arguments are passed as arrays with `shell: false`; prompts are sent through stdin. The extension does not interpolate user prompts into a shell command. Model names must match a conservative pattern, and Claude tool rules may not start with `-`, so neither can be read as an extra CLI flag.

### Verdicts and session continuity

Verdicts are parsed from model output, which repository content can influence. A verdict therefore only decides whether a fix round runs and how the run is labelled; it never grants a permission, skips consent, or applies changes. The last verdict block is used so that quoted repository text earlier in the output is not taken as the verdict, and an unparseable verdict counts as a failure, never a pass.

Continuing a Claude session (`--resume`) carries the session's earlier turns, including repository content already read, into the next stage. That content was already in Claude's context; each new prompt still fences new evidence with a fresh boundary and restates the stage contract. Session IDs that could read as command-line flags are rejected.

### Gemini referee

With `dualAgent.gemini.enabled` on (off by default), Gemini CLI rules on the findings of a failed check before the revision:

- **Read-only.** It always runs with `--approval-mode plan`, Gemini's read-only mode, with the prompt on standard input and `--output-format json`.
- **Same process boundary.** Its command comes from user settings and is resolved like an agent CLI, never from the workspace or worktree; it gets the allowlisted environment, the stage timeout, process-tree termination, and output capped at 2 MB. The model name is validated before it reaches the command line.
- **Advisory only.** The ruling is fenced as untrusted evidence in the revision's prompt. It decides no verdict, gate, fix round, or permission, and a failed referee only adds a run warning.
- **Another provider.** The referee's prompt contains the answer, the check, and the lean workspace context, which go to Google under the user's Gemini account terms.

Residual risk: the extension passes no option that disables Gemini CLI's own user or project configuration, and plan mode is enforced by Gemini CLI, not by an operating-system sandbox. Gemini's API-key variables are not on the allowlist, so they are withheld, but subscription mode does not remove them if the user lists them in `dualAgent.environment.passthrough`.

### Accidental API charges

Subscription mode removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, and `AZURE_OPENAI_API_KEY`, ignoring case on Windows. The passthrough setting cannot add them back. Environment billing is an explicit machine-level choice.

Residual risk: provider-specific credential configuration outside these variables, such as a Claude `apiKeyHelper` in user settings, can affect billing. Confirm account status in each official CLI.

### Credentials in what prompts quote

Diffs, untracked files, attachments, conversation history, and check output can contain keys that a developer pasted or a test printed. With `dualAgent.privacy.redactSecrets` on (the default), everything the extension quotes into a prompt is scanned before fencing. Recognizable credentials are replaced with `[redacted <kind>]`:

- AWS access keys;
- GitHub, Anthropic, OpenAI, Google, Slack, Stripe live, and npm tokens;
- Azure storage keys;
- JSON Web Tokens;
- PEM private keys.

The output log and exported reports are masked the same way.

Residual risk: masking matches known formats only, so a password or an unusual token passes through. Agents can still open files with their own tools, and what they read goes to their provider. Keep secrets out of the repository and the attachments.

### Usage limits and automatic continuation

When an agent reports a usage limit, the extension records the reset time read from that provider error. Until then, the agent's stages go to the other agent, as a fallback already could. The record only reroutes or pauses stages; it never grants permissions. Only provider errors, stderr, and the providers' structured rate-limit reports are read, never agent output, so a repository cannot fake a limit to steer work away from the independent reviewer. A stand-in reviewing its own work is labelled on the timeline. Turn off `dualAgent.fallbackOnQuota` to never let one agent review its own work.

The limits meter, and the handover before a window is used up, read those structured reports:

- **Claude.** `rate_limit_event` events in Claude Code's stream-JSON output, which Claude Code serializes itself, so text an agent writes cannot pose as one.
- **Codex.** Codex writes its rate limits only to its own session log. After each stage, `readCodexQuota` (`src/adapters/cliAdapters.ts`) opens the log of that stage's thread: the thread ID comes from Codex's `thread.started` event and must be a UUID before it is used in a path, and the file is looked up under `CODEX_HOME` (or `~/.codex`) in the folders for today and yesterday. Only JSON lines with a `rate_limits` field are parsed, and only that field is used; the conversation in the log is not read into the extension's state or any prompt.
- **The CLIs' logs.** With `dualAgent.usage.readLocalLogs` on, readings from sessions outside Dual Agent also count; see [Reading the CLIs' logs](#reading-the-clis-logs).

The readings are kept in global state for the meter. A limit read from any of these sources goes through `AgentLimits.observe`, which only reroutes or pauses stages.

### Reading the CLIs' logs

With `dualAgent.usage.readLocalLogs` on (the default), `LocalUsageScanner` (`src/adapters/localUsage.ts`) reads the logs both CLIs keep on this machine, so the usage panel and the limits cover terminals and other editors too. Those logs hold full conversations, including repository content, so the reader is narrow:

- **Where.** Only `.jsonl` files under Claude Code's `projects` folder (`CLAUDE_CONFIG_DIR` or `~/.claude`, at most three folders deep, including subagent files) and under Codex's `sessions/<year>/<month>/<day>` folders for the last 8 days (`CODEX_HOME` or `~/.codex`). Links are not followed, and credential files are never opened.
- **What.** A line is decoded only when it contains a usage marker (Claude's `"usage"` or API-error flag, Codex's `"token_count"`). From those lines it keeps token counts per local day, Claude's usage-limit messages (at most 500 characters, used only when `classifyFailure` calls them quota errors), and Codex's rate-limit percentages. Conversation text is never kept, logged, put into a prompt, or sent anywhere.
- **Bounds.** Reading is incremental by byte offset, at most 5,000 files, skipping files over 512 MB and yielding to the extension host between files. It runs 10 seconds after start, 3 seconds after a change seen by a file watcher on the two folders, and every 2 minutes.
- **Effect.** The counts fill the usage panel's **On this machine** section. A Codex reading or a recent Claude limit message goes through `AgentLimits.observe`, so it can only reroute or pause stages.

Residual risk: a session another program wrote into those folders, including one an agent started, can influence the counts and, through a limit message, send work to the other agent until the stated reset. That changes cost and which agent works, never permissions. Turn off `dualAgent.usage.readLocalLogs` to read nothing but the run's own Codex thread.

### Connectivity check

After a connection error, the orchestrator asks whether the machine is online, to tell a lost connection from one provider's outage. `isOnline` (`src/adapters/connectivity.ts`) opens a TCP connection to `api.anthropic.com`, `chatgpt.com`, or `api.openai.com` on port 443, or to the proxy named by `HTTPS_PROXY`, `ALL_PROXY`, or `HTTP_PROXY`, and closes it as soon as it connects, within 4 seconds. No data is sent, and the hosts are the ones the CLIs already use. While a message waits for the network, the check repeats every 15 seconds.

The answer only decides between pausing the run (offline) and letting the other agent cover the stage (online). A paused edit run continues by itself only with the setup and verification commands it was allowed, as after a usage limit.

When both agents are out, or the machine is offline, the run stops and, with `dualAgent.limits.autoContinue` on, continues by itself after the reset or once the connection is back. Resuming a run normally asks for edit consent again. The automatic continuation does not, so it is bounded:

- It continues the same run, with its recorded objective and `allowWrites` decision.
- It continues only in a trusted workspace.
- For a run that edits files, it continues only while the isolation mode, setup commands, and verification commands match the ones in force when the run stopped. Those are what the consent covered. If they changed, the user must resume by hand and sees the consent card again.

Queued messages that edit files still show their consent card, unless the user allowed edits for that conversation.

### Retrying and undoing edits

Retrying or editing an earlier message removes the later messages and undoes their file changes in the isolated worktree:

- **Checkpoints.** Before each Edit-mode message, `git write-tree` records the worktree's files from the worktree's own index.
- **Restoring.** `git read-tree --reset -u <tree>` puts the files back. The tree ID is checked to be a hexadecimal object ID first. Both commands run through `runGit`, with hooks disabled, and only inside the extension's worktree storage.
- **No new worktree.** A worktree created by a message being replaced is discarded through the same path as **Discard Changes**.
- **Your workspace is never touched.** Changes already applied stay applied, and the confirmation says so.
- **Fresh sessions.** Retried runs start new agent sessions, so instructions from removed messages cannot persist in a continued session.

### Supply chain and releases

- **Dependencies.** Runtime dependencies are pinned to exact versions and bundled into the VSIX, which ships no `node_modules`.
- **CI checks.** CI runs `npm audit` and `npm audit signatures`, which verifies the registry signatures of installed packages. CodeQL scans the TypeScript and the workflows weekly and on every change.
- **Updates.** Dependabot proposes updates after a seven-day cooldown, so a compromised release is usually withdrawn before it is proposed.
- **Workflow hardening.** Every GitHub Action is pinned to a commit SHA, checkouts do not keep credentials, and workflows default to read-only permissions.
- **Releases.** Releases are built from the tag without a dependency cache, checked against the version, and given a SHA-256 checksum and a GitHub build-provenance attestation. The exact attested file is published.
- **No stored publishing tokens.** Publishing uses OpenID Connect trusted publishing, so no repository secret exists that could publish a malicious version. Until a registry accepts it, the release VSIX is uploaded by hand with a token that never enters the repository. The publish job installs only the publishing tools, with install scripts disabled.

### Exported tables and sources

Tables, sources, and conversations exported from the chat contain agent output, which a repository or web page can influence:

- **CSV formulas.** `rowsToCsv` (`src/webview/markdown.ts`) writes a cell that starts with `=`, `+`, `-`, or `@` with a leading `'`, unless it is a number such as `-3` or `+5%`, so a spreadsheet shows it as text instead of running it as a formula.
- **Sources.** The `sources` block is parsed as JSON with every field checked and trimmed, at most 200 sources, before it becomes BibTeX or RIS.
- **Saving.** Every export asks where to save it, defaults to the home folder rather than the repository, and masks credentials while `dualAgent.privacy.redactSecrets` is on.

### Data leakage

There is no extension-owned server, and the chat webview loads nothing from the network (see Chat webview). The extension's own network activity is the connectivity check, which sends no data. Conversations, attachments, run records, and worktrees remain in private VS Code storage. Outside the chat, agent output is shown only as tree-item text, as tooltips built from untrusted `MarkdownString`s with the text Markdown-escaped (so links, including `command:` links, never activate and no HTML renders), and in read-only text documents served by the extension. Untracked files whose names suggest secrets are never copied into a worktree, which would otherwise write them into the repository's object database through the base commit. Export requires an explicit save action and defaults to the home folder rather than the repository, so a report containing prompts and agent output is not committed by accident; credentials in it are masked. The extension sends no telemetry. **Dual Agent: Delete All History** removes the workspace's conversations, attachments, queued messages, and run records.

The project brief, the limits readings, the permission bridge's configuration, and folder snapshots are also kept in private storage. The editor's file, selection, and problems go to both providers with the next message while the composer's editor chip is on; the chip shows which file and lines, and `dualAgent.chat.includeEditorContext` turns it off by default. Reviewers' findings shown in the editor stay local.

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
- [ ] Attachments contain nothing that should not go to both providers.
- [ ] `dualAgent.privacy.redactSecrets` is on, and secrets are not in the repository in the first place.
- [ ] Answers marked "standing in" were read knowing one agent checked its own work.
- [ ] Automatic continuation (`dualAgent.limits.autoContinue`) is acceptable for this repository's edit runs.
- [ ] Each Agent-mode command was read before it was allowed, and **Allow for this message** was used only for tools you would let run unattended.
- [ ] `dualAgent.codex.agentNetwork` is off where Codex must not reach the network in Agent mode.
- [ ] Changes made directly in a folder were reviewed before **Keep**, and installs outside the folder are acceptable.
- [ ] Commands from **Run** were read in the confirmation before running.
- [ ] Sign-in, sign-out, and status run only the CLIs' own commands, with the allowlisted environment and no shell, and no credential file is opened.
- [ ] `dualAgent.claude.userMcpServers` is off unless every server in your Claude configuration is trusted with this workspace.
- [ ] The Gemini referee is enabled only where sending the answer and its check to Google is acceptable.
- [ ] Reading the CLIs' logs (`dualAgent.usage.readLocalLogs`) is acceptable on this machine.

## Reporting vulnerabilities

See the repository-level [SECURITY.md](../SECURITY.md). Do not include tokens, credentials, private prompts, or proprietary repository content in a report.
