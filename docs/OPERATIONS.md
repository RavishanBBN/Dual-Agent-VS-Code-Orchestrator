# Operations and troubleshooting

## Doctor checks

Expand the **Agents** view under the Dual Agent activity-bar icon, or run **Dual Agent: Check Agent Setup**. A healthy result shows a version for Claude Code, Codex, and Git. Hover a row to see the absolute path each command resolved to, or why Git does not accept the workspace.

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

Claude stages have no shell unless a rule in `dualAgent.claude.allowedTools` names one, for example `Bash(npm test:*)` or `Bash(npm run lint)`. A rule makes its tool available to write stages and pre-approves the matching commands. Print mode cannot ask for approval, so Claude Code denies other commands unless it judges them read-only. Read-only stages never get a shell. Each rule lets agents run that command against files they wrote, so prefer narrow rules. Rules in your own `~/.claude/settings.json` still apply, but only to tools a stage already has, so they cannot add a shell; rules in the repository's `.claude/settings.json` deliberately do not apply.

Codex review stages run in a read-only sandbox, so test runners and builds that write files (caches, coverage, build output) usually fail there. Reviewers are instructed to report such checks as not run rather than passed. For results reviewers can rely on, configure `dualAgent.verification.commands`: the extension runs them itself after every editing stage and reports their exit codes to the next reviewer.

### MCP servers or project hooks do not run during workflows

This is intentional. Claude stages use `--setting-sources user --strict-mcp-config`, so repository settings, hooks, and all MCP servers are skipped. Claude Code's print mode does not show its folder-trust prompt, so loading them would run repository-provided commands without consent.

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

### An attachment is refused

The chat shows why above the composer. Files over 25 MB, more than 20 files or 100 MB per message, and binary files other than images (PNG, JPEG, GIF, WebP), PDFs, ZIP archives, and Word, Excel, or PowerPoint files are refused. Convert other formats first: for example, export a drawing as PNG. A file whose name suggests secrets asks for confirmation. Hover over an attachment chip to see notes, such as archive entries that were skipped for safety.

### Codex cannot read a PDF

Codex reads the text the extension extracts. A scanned PDF has no text layer, so the chip notes that no text was found; Claude still reads the pages as images. A PDF that takes more than 60 seconds to parse is skipped, and the chip says so.

### The model list shows only "Default" for Codex

The list comes from `codex debug models`. If that command fails or prints something unexpected, only **Default** and **Custom model…** are offered. Check `codex --version` in a terminal, update Codex, or type the model name with **Custom model…**. Changing `dualAgent.codex.*` settings reloads the list.

### A model or effort is rejected

The CLI reports the error in the message's stage, and nothing falls back for an invalid request. Choose another model or effort, or **Default**. Not every Codex model accepts every effort; the picker offers the levels the model catalog lists for each model.

### "Editing files needs a working Git repository"

Edit and Implement runs require Git so reviewers see every change and the result can be reverted. Open a Git repository (or run `git init` and commit a baseline) and resolve any warning shown with the error.

### "An isolated worktree needs a repository with at least one commit"

Worktree isolation checks out a commit. Commit a baseline, or set `dualAgent.isolation.mode` to `none` to let agents edit the workspace directly.

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

### Workflow stops at a review stage

Open the stage from the Runs view, or the run report, and read the error. Authentication, invalid request, and policy failures intentionally do not fall back. Correct the underlying provider configuration, then use **Resume Run** to continue from that stage.

### Context truncation

Increase `dualAgent.context.maxCharacters` cautiously. Large diffs and repeated full outputs consume both subscriptions. Prefer smaller objectives and clean checkpoints. Each section is trimmed separately, newest stage outputs first; older outputs that no longer fit are omitted with a note.

### Cancellation

Cancellation and timeouts terminate the agent's whole process tree, including commands it launched. On Windows the tree is force-terminated with `taskkill /T /F` immediately; elsewhere the process group receives `SIGTERM` and then `SIGKILL` after two seconds. If a descendant escaped the tree and keeps the output open, the stage still settles within about seven seconds; check for and stop such stray processes manually.

### Run history cannot be read

If `runs.json` in the extension's workspace storage is corrupted or written by a newer version, it is renamed to `runs.json.unreadable-<timestamp>` next to the original and a new history starts. The old file is kept for inspection.

### Claude starts a new session instead of continuing

With `dualAgent.claude.resumeSessions` on, a Claude stage continues the previous Claude stage's session, including the session of the conversation's previous message. If Claude reports that the session no longer exists, the stage runs again in a new session with the full prompt, and the output channel says so. Turn the setting off to always start fresh.

## Recovery

Completed, failed, and cancelled runs remain in private workspace storage. A failed or cancelled run can be continued with **Resume Run** (inline on the run, in its context menu, or in the Command Palette). Completed stages and an earlier plan approval are kept, and every unfinished stage runs again; implementation runs ask for consent again. A run that was active when VS Code closed is marked cancelled at the next start, and the output channel reports how many were interrupted.

A worktree run can be resumed only while its worktree exists and its changes have not been applied or discarded. Worktrees live in the `worktrees` folder of the extension's workspace storage, conversations in `conversations`, and attachments in `attachments`; deleting a conversation from the chat's history deletes its attachments. Remove one you no longer need with **Discard Changes** rather than deleting the folder, so Git's worktree registration is removed too. If a folder was deleted by hand, run `git worktree prune` in the repository.

## Logs

**Dual Agent: Show Output** opens the **Dual Agent** output channel: stage transitions, approvals, fallbacks, check output, and excerpts of agent messages and diagnostics. Set the channel's log level to Debug to also see tool and lifecycle events. Full stage outputs are in the stage documents opened from the Runs view. Nothing is written to the repository. Use VS Code's Extension Host log for extension failures.
