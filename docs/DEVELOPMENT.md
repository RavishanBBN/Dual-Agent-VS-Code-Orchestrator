# Development and testing

## Toolchain

- Node.js 20+
- TypeScript with strict and exact-optional-property checking
- esbuild for a deterministic CommonJS extension bundle
- ESLint flat configuration with type-aware rules
- Vitest and V8 coverage
- `@vscode/vsce` for packaging
- Preact and markdown-it for the chat page; fflate for archives and Office files; unpdf (pdf.js) for PDF text

`npm run build` produces three bundles: `dist/extension.js` for the extension host, `dist/pdfWorker.js` (pdf.js, loaded in a worker thread only when a PDF is attached), and `dist/webview/chat.js` and `chat.css` for the chat page, built for the browser with no Node.js access.

## Commands

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check
npm.cmd run smoke
npm.cmd run package
```

No test command invokes a live provider. Fake adapters verify stage order, permission flow, the gate and fix rounds, the chat check and revision, plan approval, session continuity within a run and across conversation turns, models and efforts, attachments in prompts, resume, worktree routing and reuse, usage aggregation, durable updates, and fallback behavior without spending subscription quota.

Attachment tests (`attachments.test.ts`) build images, PDFs, ZIP archives, and Word, Excel, and PowerPoint files in memory, and read PDFs with the real pdf.js. Chat tests (`chat.test.ts`) cover message validation, the link policy, the Markdown renderer, and the transcript. Conversation tests cover the store, history, and the Codex model catalog read from a fake CLI.

Process-level behavior is tested with fake CLIs: `test/helpers.ts` writes a small Node.js script plus a launcher, a `.cmd` shim on Windows (the same shape npm installs for the real CLIs) or an executable shell script elsewhere. The adapter and check-runner tests run these through the real process runner, which covers argument escaping, stdin prompts, the environment allowlist, `--resume` and its fresh-session retry, and provider failure reports. Git snapshot and worktree tests create temporary repositories, so Git must be on `PATH`.

### Smoke test in VS Code

`npm run smoke` builds the extension and launches an installed VS Code (`Code.exe` from the default install location, or the path in `DUAL_AGENT_VSCODE`). It uses a temporary profile and workspace, other extensions disabled, and fake Claude and Codex CLIs configured in user settings. Inside the extension host, `test/smoke/suite.ts`:

- activates the extension and checks that every contributed command is registered;
- opens the Runs and Agents views and runs the agent check;
- starts a brainstorming run from an editor selection through the real QuickPick;
- checks that the stored run completed, that the verdict was parsed and Claude's session continued, and that the report and stage documents open;
- records an implementation run with a real worktree, opens its changes in the multi-file diff editor and one file in the diff editor, and checks the base and modified contents and that the workspace is unchanged;
- opens the chat and waits until its page has loaded its script under the Content-Security-Policy, and until the Codex model list arrives from the fake CLI;
- through the extension's test API, sets models and efforts, attaches a file, and sends a Chat message; it checks the stages, Codex's verdict, the attachment, the reported model, and the arguments each fake CLI received (model, effort, attachment folder, streaming, read-only tools, and Codex's model, effort, and Git check);
- sends a follow-up and checks that Claude's session continued;
- sends an Edit message, answers the consent card, and checks that the change appears in the changes card, was made in the worktree, and left the workspace untouched;
- opens the chat in an editor tab.

Apply and discard ask for confirmation in a modal dialog, which a test cannot answer, so their Git behavior is covered by `worktree.test.ts`. The page's Preact components are not unit-tested; their logic lives in the tested protocol, transcript, and Markdown modules.

A VS Code window appears for a few seconds. The script exits with VS Code's exit code and removes its temporary files. It needs a desktop session, so CI does not run it.

Several tests reproduce specific vulnerabilities and must keep passing:

- a same-named launcher planted in the workspace, first on `PATH`, never runs (`cliAdapters.test.ts`, `executables.test.ts`);
- a path that does not exist yet is compared through its resolved parent, so Windows short names match and a linked directory cannot lead outside (`executables.test.ts`);
- on Windows, a `git.exe` planted in the workspace never runs, with `NoDefaultCurrentDirectoryInExePath` removed to match a normal desktop session (`gitSnapshot.test.ts`);
- cancelling an agent started through a `.cmd` shim stops the agent itself, not only `cmd.exe` (`processRunner.test.ts`, Windows); the process-group equivalent runs everywhere;
- an abort signal raised before a process starts prevents it from starting;
- failures are classified from provider errors, not from repository text in tool output;
- untrusted text, including check output, cannot close its prompt block or forge the boundary (`context.test.ts`);
- repository hooks never run during the worktree lifecycle, while a control shows plain Git runs them (`worktree.test.ts`);
- applying a worktree that conflicts with workspace edits writes nothing, and removal refuses paths outside the extension's storage (`worktree.test.ts`);
- a missing verdict never passes the gate, and a failing verification command fails it even with a "pass" verdict (`orchestrator.test.ts`);
- a session ID that looks like a flag is never passed to Claude (`cliAdapters.test.ts`);
- read-only Claude stages get only Read, Grep, and Glob, and write stages get a shell only through a configured rule (`cliAdapters.test.ts`);
- a stored model or effort that could read as a flag, or that the agent does not accept, never reaches the CLI (`cliAdapters.test.ts`, `orchestrator.test.ts`);
- archives cannot write outside their folder, decompression bombs and oversized entries are skipped, and entry counts are capped (`attachments.test.ts`);
- a PDF that hangs is stopped by the worker timeout (`attachments.test.ts`);
- malformed webview messages are dropped, agent HTML is escaped, images never load, and only web, mail, and file links open (`chat.test.ts`);
- agent text in tooltips is Markdown-escaped, so `command:` links cannot be injected (`presentation.test.ts`).

Some tests run only on Windows or only on POSIX; CI covers both. Coverage is measured for every module that does not import `vscode`: `src/core`, `src/adapters`, and `src/ui/presentation.ts`. The view classes, `extension.ts`, and `config.ts` are covered by the smoke test instead.

## Local extension debugging

1. Open the project in VS Code.
2. Press `F5` or run **Run Dual Agent Extension**. The build task runs first, and an Extension Development Host window opens.
3. In that window, open a disposable Git repository with at least one commit.
4. Select the **Dual Agent** activity-bar icon and expand **Agents**, or run **Dual Agent: Check Agent Setup**.
5. Test a Chat message first because it is read-only; try an attachment and a follow-up.
6. Test an Edit message next: allow edits, review the changes card in the diff editor, and apply or discard them. Then try Implement mode, which asks you to approve the plan.
7. Check the chat in a light and a dark theme, and moved to the right-hand side bar.
8. Use `npm run watch` to rebuild on save, then **Developer: Reload Window** in the host. **Developer: Open Webview Developer Tools** inspects the chat page.

## Adding a workflow stage

1. Add the stage to `src/core/workflows.ts`.
2. Give it one provider, one permission, one purpose, and a narrow instruction. Mark review stages `review: true` so they return a verdict, and only a final verification `gate: true`.
3. Keep every stage after the last gate read-only, so files cannot change after verification.
4. Update `docs/WORKFLOWS.md` and the README diagram.
5. Update workflow-order and permission tests.
6. Consider quota impact and whether the stage materially improves quality.

## Adding a provider

Implement `AgentAdapter`, normalize output into `StageResult`, classify operational failures, and keep authentication outside the extension. Provider-specific events must not leak directly into core workflow logic.

## Compatibility policy

- Unknown provider stream events are tolerated.
- Missing final text is a stage failure.
- Parser fixtures should be added for every provider schema regression.
- Every setting remains machine-scoped and is read through `inspect().globalValue`, never from workspace settings.
- Executables, including configured commands, are started only by absolute path from `resolveExecutable`, never by bare name.
- Every Git command goes through `runGit` in `src/core/git.ts`, which disables hooks and other repository-configured programs.
- State schema changes require a migration or backward-compatible reader; new run fields are optional.
- The chat panel is the only webview. Its page loads nothing from the network, keeps its Content-Security-Policy, renders agent Markdown only through `src/webview/markdown.ts`, and every message from it goes through `parseWebviewMessage`. Everything else uses native VS Code components, and agent text reaches tooltips only through `escapeMarkdown`.
- Dependencies are pinned to exact versions, and `npm audit` must report no vulnerabilities.

## Release procedure

1. Update version and `CHANGELOG.md`.
2. Update `PROJECT_STATUS.md` verification results.
3. Run `npm.cmd audit` and review transitive build-only vulnerabilities.
4. Run `npm.cmd run check`.
5. Run `npm.cmd run smoke`.
6. Run `npm.cmd run package`.
7. Install the VSIX in an isolated profile.
8. With signed-in CLIs, test doctor, a Chat message with attachments and a follow-up, an Edit message with apply, a brainstorming run, cancellation, resume, export, and an implementation run in a disposable repository: approve the plan, review the diff, and apply it.
9. Tag the verified commit.

The package currently overrides `@azure/msal-node` to `7.1.0` because the VSIX packager's permitted dependency range otherwise resolves to a version covered by GHSA-xcx6-jx8p-x3h5. Re-evaluate and remove the override when `@vscode/vsce` declares a fixed compatible dependency directly.
