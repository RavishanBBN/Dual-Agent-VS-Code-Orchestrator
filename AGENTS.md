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
- Take setup and verification commands only from user settings, as argument vectors without a shell, and list them in the consent dialog.
- Keep every stage after the final gate read-only, and never let a verdict grant permissions.
- The chat panel is the only webview: keep its Content-Security-Policy and resource roots, load nothing from the network, validate every message with `parseWebviewMessage`, render agent Markdown only through `src/webview/markdown.ts`, and route its actions through the same commands, consent, and run lock. Use native VS Code UI for everything else, and pass agent or repository text to tooltips only through `escapeMarkdown`.
- Store attachments only in private storage through `src/core/attachments.ts`, keep its size, path, and archive limits, and parse PDFs only in the worker.
- Validate models and efforts with `src/core/agentOptions.ts` wherever they enter: settings, the chat, and stored runs.
- Keep provider-specific schemas inside `src/adapters/`.
- Update tests, `CHANGELOG.md`, and `PROJECT_STATUS.md` with behavior changes.
- Run `npm.cmd run check` before declaring completion, and `npm.cmd run smoke` after UI, manifest, or activation changes.

## Architecture

Core orchestration must remain testable without VS Code or live model calls; inject its dependencies (snapshots, worktrees, checks, approval) rather than importing UI or adapters. UI code belongs under `src/ui`, with logic that does not need `vscode` in `src/ui/presentation.ts` and `src/ui/chat/{protocol,transcript}.ts`; the chat page belongs under `src/webview` and must not import Node.js modules; provider and process integration belongs under `src/adapters`; pure workflow policy belongs under `src/core`.
