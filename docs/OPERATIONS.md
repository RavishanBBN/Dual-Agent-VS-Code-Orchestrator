# Operations and troubleshooting

## Doctor checks

Expand the **Agents** view under the Dual Agent activity-bar icon, or run **Dual Agent: Check Agent Setup**. A healthy result shows a version and the sign-in for Claude Code and Codex, a version for Git, and both for Gemini CLI when the referee is enabled. Hover a row to see the absolute path each command resolved to, the account it is signed in with, or why Git does not accept the workspace. A CLI that is installed but signed out shows a warning; use **Sign In** on its row.

## Settings for Agent mode, the editor, and the referee

These settings are machine-scoped like every other Dual Agent setting, so only your user settings change them.

| Setting | Default | Effect |
|---|---:|---|
| `dualAgent.codex.agentNetwork` | `true` | In Agent mode Codex cannot ask before a command, so it works in its sandbox; this lets the sandbox reach the network to install packages. Claude always asks instead. |
| `dualAgent.claude.userMcpServers` | `false` | Lets Claude load MCP servers as Claude Code does in your terminal: those in your own Claude configuration, and a repository's `.mcp.json` servers only if you approved them in Claude Code. Off, Claude loads none. A server's tools still need a rule in `dualAgent.claude.allowedTools` to run without asking. |
| `dualAgent.chat.includeEditorContext` | `true` | Sends the active editor's file, selected lines, and problems with new messages, shown as a chip above the message box that turns it off. |
| `dualAgent.chat.sound` | `true` | Plays a short chime when a message that took longer than 15 seconds finishes. |
| `dualAgent.findings.showInEditor` | `true` | Shows reviewers' findings that name a file and line as problems in the editor and the Problems panel. |
| `dualAgent.usage.readLocalLogs` | `true` | Reads the CLIs' own logs for token counts, usage-limit messages, and Codex's rate limits, so the usage panel and the limits cover terminals and other editors too. |
| `dualAgent.gemini.enabled` | `false` | Lets Gemini CLI rule on the findings of a failed check before the revision. |
| `dualAgent.gemini.command` | `gemini` | Gemini CLI command name or absolute path, never resolved from the workspace. |
| `dualAgent.gemini.model` | empty | Gemini model, such as `pro` or `flash`; empty uses the CLI default. |

The referee uses `dualAgent.timeoutMinutes`, `dualAgent.billingMode`, and `dualAgent.environment.passthrough` like the agents.

### "Refusing to run … because it is inside the workspace"

The configured command, or the first match on `PATH`, is inside the open workspace. The extension never runs executables from the workspace, because a repository (or an agent that can write files) could otherwise replace the real CLI. Install the CLI globally, or set `dualAgent.<provider>.command` to an absolute path outside the workspace. A CLI installed only in the repository's own `node_modules/.bin` is refused for the same reason.

### "Relative executable path … is not allowed"

Commands such as `tools\codex` or `./claude` would be resolved against the workspace. Use a command name on `PATH` or an absolute path.

### Codex unavailable

Run:

```powershell
codex --version
codex login status
```

If the command works only from a specific path, set `dualAgent.codex.command` to that absolute path in user settings.

### Claude unavailable on Windows

PowerShell may block the `claude.ps1` shim while `claude.cmd` works:

```powershell
claude.cmd --version
```

Set `dualAgent.claude.command` to `claude.cmd` or its absolute path.

### An agent cannot find a tool, proxy, or credential it needs

Agents receive an allowlisted environment (see the README's billing section). If a CLI or a command it runs needs another variable, such as a corporate CA bundle under a custom name or `GH_TOKEN` for a deliberate GitHub step, add its name to `dualAgent.environment.passthrough` in user settings. Pass only what the workflow needs: agents and the commands they run can read every variable they receive. Billing variables are never passed in `subscription` mode, even when listed.

### Claude reports that it could not run tests

To let Claude run any command, asking you first, use Agent mode (`/agent`). Otherwise, editing stages may run your `dualAgent.verification.commands` themselves, with extra arguments, so setting those is usually enough; a command with an argument that needs quoting gets no rule. Otherwise, Claude stages have no shell unless a rule in `dualAgent.claude.allowedTools` names one, for example `Bash(npm test:*)` or `Bash(npm run lint)`. A rule makes its tool available to write stages and pre-approves the matching commands. Print mode cannot ask for approval, so Claude Code denies other commands unless it judges them read-only. Read-only stages never get a shell. Each rule lets agents run that command against files they wrote, so prefer narrow rules. Rules in your own `~/.claude/settings.json` still apply, but only to tools a stage already has, so they cannot add a shell; rules in the repository's `.claude/settings.json` deliberately do not apply.

Codex review stages run in a read-only sandbox, so test runners and builds that write files (caches, coverage, build output) usually fail there. Reviewers are instructed to report such checks as not run rather than passed. For results reviewers can rely on, configure `dualAgent.verification.commands`: the extension runs them itself after every editing stage and reports their exit codes to the next reviewer.

### MCP servers or project hooks do not run during workflows

This is intentional. Claude stages use `--setting-sources user --strict-mcp-config`, so repository settings, hooks, and all MCP servers are skipped. Claude Code's print mode does not show its folder-trust prompt, so loading them would run repository-provided commands without consent.

To use the MCP servers in your own Claude configuration, turn on `dualAgent.claude.userMcpServers`. Print mode cannot ask, so a server's tool runs only with a matching rule in `dualAgent.claude.allowedTools`, which applies to editing and Agent-mode stages; in Agent mode, other calls ask you through the permission card. Repository servers and hooks still do not load.

### Unexpected API billing

1. Confirm `dualAgent.billingMode` is `subscription`.
2. Run the provider's status/login command outside the extension.
3. Verify the intended subscription account is selected.
4. Review provider billing dashboards. The extension's ledger is not authoritative billing data.

### "Git refused this workspace … dubious ownership"

Git refuses repositories owned by a different user account. On Windows this happens when a folder was created by another account, for example a sandbox account used by an agent. Until it is resolved agents receive no diff, so implementation workflows refuse to start and brainstorming continues with a warning. After verifying the folder is yours, either take ownership of it or run the command shown in the warning:

```powershell
git config --global --add safe.directory "F:/path/to/repository"
```

### The chat says it cannot run here

The chat needs a trusted workspace with a local folder. In a multi-root workspace, a new conversation uses the folder of the active editor, or the first folder; the conversation keeps that folder.

### "Agent mode needs the permission bridge, which is not running"

When the extension activates it starts the permission bridge: a local named pipe (Windows) or Unix socket, and an MCP configuration file in its private global storage. If that fails, the output log shows "Agent mode cannot ask before commands, so it is unavailable", with the reason, and Claude's Agent-mode stages fail with this error. Common causes are a global storage folder that cannot be written, or a missing `dist/permissionServer.js` in a hand-built package. Reload the window after fixing the cause. Meanwhile, **Codex + Claude** lets Codex do Agent-mode work in its sandbox.

### Agent mode asks before every command

That is the design: Claude Code runs by itself only what it judges read-only and what your allow rules match, and asks about everything else. **Allow *tool* for this message** stops asking about that tool until the message finishes. To pre-approve a command you trust in every run, add a rule to `dualAgent.claude.allowedTools`, such as `Bash(npm install:*)`. While the chat is hidden, the request appears as a modal dialog; **Stop** denies it.

### Codex cannot install packages in Agent mode

Codex works in its `workspace-write` sandbox, which writes only in the folder. Installing into the folder (for example `npm install` without `-g`) needs `dualAgent.codex.agentNetwork` on, the default. Global installs and system changes are outside the sandbox; use **Claude + Codex**, so Claude asks you for them.

### Run says the command uses shell syntax

**Run** executes one command without a shell, so pipes, redirection, `&&`, `;`, substitution, and variables are refused rather than run differently than they read. Use **Terminal** to paste the command into a terminal, read it, and press Enter yourself. Run is offered only on one-line shell blocks, and its executable must be on `PATH` outside the folder, as for verification commands.

### The Gemini referee does not rule

With `dualAgent.gemini.enabled` on, the Agents view shows a **Gemini CLI (referee)** row. If it says "not available", install Gemini CLI with `npm install -g @google/gemini-cli`, run `gemini` once in a terminal to sign in, or set `dualAgent.gemini.command` to its absolute path. A ruling that fails or times out adds a run warning, "Gemini could not rule on the check", and the revision continues without it. The referee runs only when a check fails and a revision follows.

### Signing in

Run **Dual Agent: Sign In**, use the sign-in icon in the Agents view, or the **Sign in** button the chat shows for a signed-out agent. Pick the CLI and the way to sign in. A terminal named **Sign in to …** runs the CLI's own sign-in: follow the link or device code it prints, then close the terminal if the CLI leaves it open. The Agents view and the chat update as soon as the CLI reports the sign-in, or when the terminal closes.

- **Claude Code:** a Claude subscription (`claude auth login --claudeai`), the Anthropic Console (`--console`, billed per token), or SSO.
- **Codex:** a ChatGPT account (`codex login`), a device code when the browser cannot reach this machine (`--device-auth`), or an OpenAI API key, typed into a password box and passed to `codex login --with-api-key` on standard input.
- **Gemini CLI:** the terminal starts `gemini`; choose **Login with Google**, then type `/quit`.

The sign-in uses the same environment as the agents, so a `CLAUDE_CONFIG_DIR` or `CODEX_HOME` you set applies to it too. In subscription billing mode, API-key variables are removed from that environment, as they are for the agents. **Dual Agent: Sign Out** runs `claude auth logout` or `codex logout` after a confirmation; it signs the CLI out for your terminal too.

### The limits meter is empty or out of date

**Refresh** in the meter, or **Dual Agent: Refresh Subscription Limits**, asks each agent for its current windows with one tiny call (Claude on Haiku, Codex at low effort). It runs only when you ask, because it uses a little of each subscription: on this machine about 7,000 input tokens for Claude and 13,000 for Codex, mostly the CLIs' own instructions. A window whose reset time has passed shows as empty.

The meter otherwise shows what the CLIs last reported. Claude reports its windows during a call; Codex records them in its session log under `CODEX_HOME` (or `~/.codex`), which the extension reads after each Codex stage and, with `dualAgent.usage.readLocalLogs` on, whenever any Codex session writes. A CLI version that reports no windows leaves its rows empty. A window at 98% or more makes the other agent take over until it resets, as for a reported limit.

### "On this machine" differs from "In Dual Agent"

**In Dual Agent** counts what each CLI reported after every stage the extension ran, including failed attempts. **On this machine** comes from the CLIs' own logs, so it also counts terminals, other editors, and subagents, for today and the last 7 days. The logs are read 10 seconds after start, a few seconds after either CLI writes, and every 2 minutes; the section shows when it was last updated. If it is missing, check that `dualAgent.usage.readLocalLogs` is on and that the logs are where `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point, or in `~/.claude/projects` and `~/.codex/sessions`. A log over 512 MB is skipped. A Claude limit reported in a terminal session also makes Codex take over in Dual Agent until the stated reset.

### Waiting for the network

Claude Code retries a lost connection by itself for about three minutes before it reports it, so the chat shows **Waiting for the network** only after that.

When an agent reports a connection error, the extension checks whether the machine is online by opening a connection to the providers' hosts, or to your proxy, and closing it.

- **Offline.** The message stops where it was, and a **Waiting for the network** card appears; a hidden chat, or a run from the Runs view, gets a notification. With `dualAgent.limits.autoContinue` on, the message continues by itself within about 15 seconds of the connection coming back, and the queued messages follow. **Do not continue** cancels that; **Continue now** tries at once. With automatic continuation off, the card offers **Continue when online**.
- **Online.** The error came from one provider, so the other agent does the stage, marked as standing in.

Behind a proxy, set `HTTPS_PROXY` (or `ALL_PROXY` or `HTTP_PROXY`) where VS Code can see it, so the check probes the proxy rather than the providers directly. An edit run continues by itself only with unchanged setup and verification commands.

### Findings appear as problems in the editor

When a message finishes, reviewers' findings that name a file and line inside the folder are shown as problems: blocker and high as errors, medium as warnings, and low as information. They are replaced when the next message finishes. **Dual Agent: Clear Findings in the Editor**, in the chat's **…** menu, removes them, and `dualAgent.findings.showInEditor` turns them off.

### Research or the Web toggle finds nothing

Research mode always gives both agents the web; in other modes, turn on **Web** in the composer. If searches fail, check that each CLI can reach the internet (proxy variables may need `dualAgent.environment.passthrough`) and that your Codex plan includes web search. The agents' web steps appear on the timeline as WebSearch, WebFetch, Web search, or Web page.

### An attachment is refused

The chat shows why above the composer. Files over 25 MB, more than 20 files or 100 MB per message, and binary files other than images (PNG, JPEG, GIF, WebP), PDFs, ZIP archives, and Word, Excel, or PowerPoint files are refused. Convert other formats first: for example, export a drawing as PNG. A file whose name suggests secrets asks for confirmation. Hover over an attachment chip to see notes, such as archive entries that were skipped for safety.

### Codex cannot read a PDF

Codex reads the text the extension extracts. A scanned PDF has no text layer, so the chip notes that no text was found; Claude still reads the pages as images. A PDF that takes more than 60 seconds to parse is skipped, and the chip says so.

### The model list shows only "Default" for Codex

The list comes from `codex debug models`. If that command fails or prints something unexpected, only **Default** and **Custom model…** are offered. Check `codex --version` in a terminal, update Codex, or type the model name with **Custom model…**. Changing `dualAgent.codex.*` settings reloads the list.

### A model or effort is rejected

The CLI reports the error in the message's stage, and nothing falls back for an invalid request. Choose another model or effort, or **Default**. Not every Codex model accepts every effort; the picker offers the levels the model catalog lists for each model.

### "Editing files needs a working Git repository"

Runs that edit files need Git to describe every change, so reviewers see it and it can be reverted. With the default `dualAgent.isolation.mode` of `worktree`, a folder without Git, or without a commit, is snapshotted instead, so this error means Git itself failed: it is missing, or it refused the folder (see the warning shown with the error). With `dualAgent.isolation.mode` set to `none`, Edit, Test first, and Implement need a real Git repository; open one, or run `git init` and commit a baseline.

### "This folder is edited directly, not in an isolated copy"

The folder is not a Git repository, has no commit, or the message is in Agent mode. Dual Agent took a snapshot of the folder in its private storage, and the agents edit the folder itself. When the message finishes, the changes card lists the changed files:

- **Review all** opens every change in the diff editor, against the snapshot.
- **Keep…** leaves the files as they are and deletes the snapshot. After that, Dual Agent cannot undo them; use your own backups or version control.
- **Undo all…** puts back every changed or deleted file and deletes files the agents created. Folders the snapshot skips, such as `node_modules`, `.venv`, and build output, are left as they are, so remove an installed package yourself if you no longer want it.
- **Undo** on a file restores only that file.

For an isolated copy instead, make the folder a Git repository with a commit (`git init`, `git add -A`, `git commit`). Agent mode always edits the folder itself.

### "This folder has more than 20,000 files … too many to snapshot"

The snapshot counts files outside dependency and build folders and outside what the folder's `.gitignore` files exclude. Open a Git repository instead, which gets an isolated worktree, or a smaller folder. Adding a `.gitignore` for large generated folders also lowers the count.

### "This subfolder is a Git repository of its own"

A snapshot records a nested repository as a link, not as its files, so Undo cannot put back changes inside it. Open that subfolder as the workspace to edit it in an isolated copy.

### Tests fail in the worktree because dependencies are missing

A worktree contains tracked files and your uncommitted and untracked changes, but no ignored files: no `node_modules`, virtual environments, build output, or `.env`. Install what your checks need with `dualAgent.isolation.setupCommands`, for example `[["npm", "ci"]]`. They run once when the worktree is created; a failure stops the run before any agent starts, and **Resume Run** retries them. If a check needs a value from `.env`, pass the variable name through `dualAgent.environment.passthrough` instead of copying the file.

### "… was not found on PATH" for a verification command

Commands are argument lists run without a shell, and their executables are never taken from the workspace or worktree. Use a command on `PATH` such as `npm`, `npx`, `pnpm`, or `python`, for example `[["npx", "vitest", "run"]]`, not `node_modules/.bin/vitest` or a single string like `"npm test"`. Make sure the command does not wait for input or watch files: it gets no terminal and is stopped after `dualAgent.verification.timeoutMinutes`.

### The plan is waiting for approval

Implementation runs pause before the first editing stage while `dualAgent.workflow.approvePlan` is on. In the chat, the message shows an approval card. Otherwise the status bar shows **Dual Agent: approve plan**; click it, or use the buttons on the run in the **Runs** view. **Review Plan** opens Claude's plan beside Codex's review. Cancelling the run also ends the wait.

### "Completed with unresolved findings"

The final gate did not pass after the allowed fix rounds: the reviewer returned `fail` or no readable verdict, or a verification command failed. The reason is on the run's tooltip and in the report, and the verification stage shows each finding. You can still review and apply the changes; the apply dialog repeats the warning. Raise `dualAgent.workflow.maxFixRounds` (up to 3) for more automatic attempts.

### "The changes do not apply cleanly"

Applying checks the whole patch against your working tree first. It fails when you edited the same lines after the run started, and nothing is written. **Show Details** prints Git's explanation to the output channel. Either revert or commit your edits and apply again, or use **Open Worktree in New Window** and copy the changes you want. The worktree is kept until you apply or discard it.

### Run warnings

Warnings in the Runs view (expand the run) and the exported report mark conditions that weakened a run without stopping it. Examples: Git unavailable or its diff truncated, untracked files not listed or not copied into the worktree, repository agent configuration (`.codex`), or run history that could not be saved. Read them before trusting a review.

### An agent is at its usage limit

When Claude or Codex reports a usage limit or exhausted credits, a banner above the composer says until when. Meanwhile the other agent does that agent's stages too, marked **standing in** on the timeline. A stand-in's check of its own answer is weaker than an independent one, so read those answers with more care. The limit is read from the provider's message. If the message names no reset time, the agent is tried again after 15 minutes, then 30, 60, and 120. After the reset the agent rejoins, and a continued Claude session is given the messages it missed. To keep the limited agent's role empty instead, turn off `dualAgent.fallbackOnQuota`: the work then pauses until that agent resets.

### Paused at the usage limits

When both agents are out, the message stops with a **Paused at the usage limits** card, or a notification for runs started from the Runs view. With `dualAgent.limits.autoContinue` on (the default), the message continues by itself a minute after the first limit resets, from the stage where it stopped, and then the queued messages run. This continuation is kept across restarts of VS Code.

- **Continue now** tries at once.
- **Do not continue** cancels the automatic continuation; **Resume** is still available later.
- A message that edits files continues by itself only while the setup and verification commands are the ones you allowed. If they changed, you are asked to resume it yourself, which shows the consent card again.

### Queued messages

A message sent while another runs waits in the queue above the composer, numbered in order. A message sent while both agents are at their limits, or while a paused message waits to continue, waits there too. Remove one with its ✕. Queued messages run one after another, each in its own conversation. An Edit message still shows its consent card unless you chose **Allow for this conversation**. The queue holds at most 20 messages and is kept across restarts.

### Retrying or editing an earlier message

**Retry** under a message runs it again with the models and efforts now selected. **Edit** puts its text in the composer; sending replaces the message. Either way:

- The messages after it are removed from the conversation. Their runs stay in the Runs view.
- File changes made in the isolated copy from that message on are undone. The copy is put back to the checkpoint taken before the first Edit message being replaced, or discarded if that message created it.
- Changes that were already applied to your workspace are not undone; the confirmation says so. Revert them in Source Control if needed.
- Claude and Codex start new sessions, so nothing from the removed messages carries over.

Retrying the last message needs no confirmation. Retrying an earlier one asks first.

### Workflow stops at a review stage

Open the stage from the Runs view, or the run report, and read the error. Authentication, invalid request, and policy failures intentionally do not fall back. Correct the underlying provider configuration, then use **Resume Run** to continue from that stage.

### Context truncation

Increase `dualAgent.context.maxCharacters` cautiously. Large diffs and repeated full outputs consume both subscriptions. Prefer smaller objectives and clean checkpoints. Each section is trimmed separately, newest stage outputs first; older outputs that no longer fit are omitted with a note.

### Cancellation

Cancellation and timeouts terminate the agent's whole process tree, including commands it launched. On Windows the tree is force-terminated with `taskkill /T /F` immediately; elsewhere the process group receives `SIGTERM` and then `SIGKILL` after two seconds. If a descendant escaped the tree and keeps the output open, the stage still settles within about seven seconds; check for and stop such stray processes manually.

The run records why it stopped: "Stopped by you." or "VS Code closed while the message was running." Clicks on **Stop** within one second of sending are ignored, so a double click on **Send** does not stop the new message.

### Run history cannot be read

If `runs.json` in the extension's workspace storage is corrupted or written by a newer version, it is renamed to `runs.json.unreadable-<timestamp>` next to the original and a new history starts. The old file is kept for inspection.

### Claude starts a new session instead of continuing

With `dualAgent.claude.resumeSessions` on, a Claude stage continues the previous Claude stage's session, including the session of the conversation's previous message. If Claude reports that the session no longer exists, the stage runs again in a new session with the full prompt, and the output channel says so. Turn the setting off to always start fresh.

## Recovery

Completed, failed, and cancelled runs remain in private workspace storage. A failed or cancelled run can be continued with **Resume Run** (inline on the run, in its context menu, or in the Command Palette). Completed stages and an earlier plan approval are kept, and every unfinished stage runs again; implementation runs ask for consent again. A run that was active when VS Code closed is marked cancelled at the next start, and the output channel reports how many were interrupted.

A worktree run can be resumed only while its worktree exists and its changes have not been applied or discarded. Worktrees live in the `worktrees` folder of the extension's workspace storage, conversations in `conversations`, and attachments in `attachments`; deleting a conversation from the chat's history deletes its attachments. Remove one you no longer need with **Discard Changes** rather than deleting the folder, so Git's worktree registration is removed too. If a folder was deleted by hand, run `git worktree prune` in the repository.

Snapshots of folders edited directly are bare repositories named `direct-<id>.git` in the same `worktrees` folder. Use **Keep** or **Undo** rather than deleting one by hand: without it, the changes since the snapshot can no longer be undone from Dual Agent. The project brief is `brief.md` in the extension's workspace storage, and the permission bridge's configuration is `permission-mcp.json` in its global storage, deleted when the extension stops.

**Dual Agent: Delete All History** (in the Runs view's menu and the Command Palette) deletes every conversation, attachment, queued message, and run record for the workspace. It refuses while a run is active or while a worktree still holds changes: apply or discard them first. Files in your workspace are not touched.

Checkpoints for retries are Git tree objects in the repository's object database, written from the worktree's own index. Nothing refers to them, so `git gc` eventually removes old ones. Retrying from a message whose checkpoint is gone reports that the file changes could not be undone, and nothing is retried.

## Logs

**Dual Agent: Show Output** opens the **Dual Agent** output channel: stage transitions, approvals, fallbacks, check output, and excerpts of agent messages and diagnostics. Set the channel's log level to Debug to also see tool and lifecycle events. Errors from the chat page itself, including content its security policy blocked, appear there as "Chat view error". Credentials in agent messages are masked in the log while `dualAgent.privacy.redactSecrets` is on. Full stage outputs are in the stage documents opened from the Runs view. Nothing is written to the repository. Use VS Code's Extension Host log for extension failures.
