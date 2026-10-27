# Operations and troubleshooting

## Doctor checks

Use **Dual Agent: Check Agent Setup**. A healthy result shows a version for both providers. Hover the version in the dashboard to see the absolute path each command resolved to.

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

Claude Code's print mode cannot ask for approval, so shell commands are denied unless a permission rule allows them. Add rules to `dualAgent.claude.allowedTools`, for example `Bash(npm test:*)` or `Bash(npm run lint)`. They apply to write stages only. Each rule lets agents run that command against files they wrote, so prefer narrow rules. Rules in the user's own `~/.claude/settings.json` also apply; rules in the repository's `.claude/settings.json` deliberately do not.

Codex review stages run in a read-only sandbox, so test runners and builds that write files (caches, coverage, build output) usually fail there. Reviewers are instructed to report such checks as not run rather than passed.

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

### "Implementation workflows need a working Git repository"

Implementation runs require Git so reviewers see every change and the result can be reverted. Open a Git repository (or run `git init` and commit a baseline) and resolve any warning shown with the error.

### Run warnings

Warnings in the dashboard and exported report mark conditions that weakened a run without stopping it: Git unavailable or its diff truncated, untracked files not listed, repository agent configuration (`.codex`), or run history that could not be saved. Read them before trusting a review.

### Workflow stops at a review stage

Export the run report and inspect the stage error. Authentication, invalid request, and policy failures intentionally do not fall back. Correct the underlying provider configuration and start a new workflow.

### Context truncation

Increase `dualAgent.context.maxCharacters` cautiously. Large diffs and repeated full outputs consume both subscriptions. Prefer smaller objectives and clean checkpoints. Each section is trimmed separately, newest stage outputs first; older outputs that no longer fit are omitted with a note.

### Cancellation

Cancellation and timeouts terminate the agent's whole process tree, including commands it launched. On Windows the tree is force-terminated with `taskkill /T /F` immediately; elsewhere the process group receives `SIGTERM` and then `SIGKILL` after two seconds. If a descendant escaped the tree and keeps the output open, the stage still settles within about seven seconds; check for and stop such stray processes manually.

### Run history cannot be read

If `runs.json` in the extension's workspace storage is corrupted or written by a newer version, it is renamed to `runs.json.unreadable-<timestamp>` next to the original and a new history starts. The old file is kept for inspection.

## Recovery

Completed and failed records remain in private workspace storage. The current release does not resume a partially completed run automatically. Export the failed report and start a new objective such as:

```text
Continue the previous Dual Agent run using the attached report. Preserve the existing working-tree changes and begin by validating their current state.
```

## Logs

User-visible normalized events appear in the dashboard. Provider stderr is treated as diagnostics and is not automatically persisted in the repository. Use VS Code's Extension Host log and Developer Tools for extension failures.
