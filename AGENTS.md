# Agent contribution instructions

Read `README.md`, `PROJECT_STATUS.md`, and the relevant document under `docs/` before changing behavior.

## Required boundaries

- Preserve existing user changes and never reset the working tree.
- Do not read or expose Claude/Codex credential files.
- Keep subscription mode free of API-key, auth-token, endpoint, and cloud-routing environment variables.
- Pass agents an allowlisted environment only (`src/adapters/environment.ts`); do not spread `process.env` into agent processes.
- Do not add shell interpolation for prompts, paths, models, or executable settings.
- Start every child process by an absolute path from `resolveExecutable`, which excludes the workspace; never spawn a bare command name.
- Terminate child processes with `terminateProcessTree`, not `child.kill()` alone.
- Classify failures from provider error reports or stderr, never from agent output.
- Keep every setting machine-scoped and read it from user settings only.
- Fence untrusted prompt content with the per-prompt boundary in `src/core/context.ts`.
- Keep Codex review stages read-only and require explicit consent before write stages.
- Run every Git command through `runGit` in `src/core/git.ts`, which disables hooks and other repository-configured programs.
- Never write a worktree's changes to the user's working tree without the user's apply action and a `git apply --check` first; never delete a path outside the extension's worktree storage.
- Let agents edit the user's folder directly only in Agent mode or for a folder without Git (or without a commit), only after the user's consent and after `createFolderSnapshot` has recorded the folder in a snapshot repository inside the extension's worktree storage. Undo such edits only through `restoreWorktree` or `revertWorktreeFiles`, which may delete only files the agents created inside that folder since the snapshot; never delete the folder or any path outside it, and remove only the snapshot repository on Keep or Undo.
- Take setup and verification commands only from user settings, as argument vectors without a shell, and list them in the consent dialog.
- Keep every stage after the final gate read-only, and never let a verdict grant permissions.
- The chat panel is the only webview: keep its Content-Security-Policy and resource roots, load nothing from the network, validate every message with `parseWebviewMessage`, render agent Markdown only through `src/webview/markdown.ts`, and route its actions through the same commands, consent, and run lock. Use native VS Code UI for everything else, and pass agent or repository text to tooltips only through `escapeMarkdown`.
- Store attachments only in private storage through `src/core/attachments.ts`, keep its size, path, and archive limits, and parse PDFs only in the worker.
- Validate models and efforts with `src/core/agentOptions.ts` wherever they enter: settings, the chat, and stored runs.
- Give agents web access only through a stage's `web` flag (Research), the user's per-message Web toggle, or Agent mode's working stages, never by default in other modes.
- Outside Agent mode, let an editing stage run only the user's configured verification commands, as prefix rules built by `commandRules` from arguments that need no quoting.
- In Agent mode, let Claude run commands and edits only through the permission bridge (`src/adapters/permissionBroker.ts`, `src/permission/`), with every decision made by the user in the chat card or the modal dialog. Never allow a call automatically beyond Claude Code's own read-only judgement, the user's own allow rules, and the per-message tool allowance, which ends with the run. Keep the bridge's random token, its `timingSafeEqual` check, and its configuration file in private storage with mode 0600; deny whenever the user cannot be asked. Without the bridge, a Claude Agent-mode stage must fail, never run without prompts.
- Keep Codex in its `workspace-write` sandbox in Agent mode, with network access only while `dualAgent.codex.agentNetwork` allows it.
- Run a command from agent output only from the chat's Run button: through `splitCommandLine`, which refuses shell syntax, then a modal confirmation that names the folder, then `runChecks`. Never through a shell, and never from the Terminal button, which only pastes without Enter.
- Mask credentials with `redactSecrets` (`src/core/redact.ts`) in everything the extension quotes into prompts, logs, or exported reports, unless the user turned `dualAgent.privacy.redactSecrets` off. Add new credential formats there, with a test that builds the sample at run time.
- Keep the chat page's Trusted Types policy (`trusted-types dual-agent-markdown`): HTML reaches the page only through `trustedMarkdown` in `src/webview/markdown.ts`.
- Record usage limits only through `AgentLimits` (`src/core/limits.ts`), from quota errors classified by `classifyFailure` or from the providers' structured rate-limit reports through `AgentLimits.observe`, never from agent output; a limit only reroutes or pauses stages, never changes permissions.
- Read the CLIs' logs only through `readCodexQuota` (the stage's own Codex thread, its ID checked to be a UUID) and `LocalUsageScanner` in `src/adapters/localUsage.ts` (only while `dualAgent.usage.readLocalLogs` is on), and only their token counts, times, usage-limit messages, and rate-limit fields. Never keep, log, send, or put into a prompt the conversations in those logs, never follow links there, and never open credential files.
- Pause a run for the network only through `ConnectionLostError` after `isOnline` (`src/adapters/connectivity.ts`) reports the machine offline; the check may only open and close a TCP connection to a provider host or the configured proxy, sending nothing. Continue such a run only through `ContinuationScheduler`, under the same rule for edit runs as after a usage limit.
- Keep the referee (`src/adapters/gemini.ts`) read-only, in Gemini's plan mode, resolved and run like an agent CLI; its ruling is fenced evidence for the revision and never decides a verdict, gate, or permission.
- Continue a paused run automatically only through `ContinuationScheduler`, and for a run that edits files only when its setup and verification commands are unchanged since the user allowed it.
- Undo a retried message's file changes only by restoring its checkpoint with `restoreWorktree`, or by discarding the worktree the message created, both inside the extension's worktree storage; never touch the user's working tree. For a folder edited directly, the same restore applies to that folder, under the direct-edit rule above.
- Update `ABOUT_DUAL_AGENT` in `src/core/about.ts` whenever a mode, feature, or limit changes, so agents never describe abilities the extension lacks. Keep `isSmallTalk` narrow: a message that names a task, file, or code must run its full workflow.
- Keep `--strict-mcp-config` on every Claude stage unless the user turned on `dualAgent.claude.userMcpServers`; in Agent mode add only the permission bridge's server, and never load a repository's settings. With the opt-in on, Claude loads MCP servers as it does in the user's terminal, which the setting's description must keep saying.
- Export tables as CSV only through `rowsToCsv`, which keeps formula-like cells as text, and keep the project brief in private storage, never in the repository.
- Sign in, sign out, and check sign-in status only through the CLIs' own commands in `src/adapters/accounts.ts`, with the agents' allowlisted environment, executables from `resolveExecutable`, and no shell. Never open a CLI's credential file, never store a key, and pass an API key only on the CLI's standard input.
- Ask an agent for its limits with a model call only when the user asks (`Refresh`), never on a timer.
- Keep provider-specific schemas inside `src/adapters/`.
- Update tests, `CHANGELOG.md`, and `PROJECT_STATUS.md` with behavior changes.
- Run `npm.cmd run check` before declaring completion, and `npm.cmd run smoke` after UI, manifest, or activation changes.

## Architecture

Core orchestration must remain testable without VS Code or live model calls; inject its dependencies (snapshots, worktrees, checks, approval) rather than importing UI or adapters. UI code belongs under `src/ui`, with logic that does not need `vscode` in `src/ui/presentation.ts` and `src/ui/chat/{protocol,transcript,permissions,slash,textDiff}.ts`; the chat page belongs under `src/webview` and must not import Node.js modules; provider and process integration belongs under `src/adapters`; the permission bridge process belongs under `src/permission` and must not import `vscode`; pure workflow policy belongs under `src/core`.
