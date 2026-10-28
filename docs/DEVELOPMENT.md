# Development and testing

## Toolchain

- Node.js 20+
- TypeScript with strict and exact-optional-property checking
- esbuild for a deterministic CommonJS extension bundle
- ESLint flat configuration with type-aware rules
- Vitest and V8 coverage
- `@vscode/vsce` for packaging
- Preact and markdown-it for the chat page; fflate for archives and Office files; unpdf (pdf.js) for PDF text

`npm run build` produces four bundles: `dist/extension.js` for the extension host, `dist/pdfWorker.js` (pdf.js, loaded in a worker thread only when a PDF is attached), `dist/permissionServer.js` (Agent mode's permission bridge, which Claude Code starts as its own process), and `dist/webview/chat.js` and `chat.css` for the chat page, built for the browser with no Node.js access.

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

Attachment tests (`attachments.test.ts`) build images, PDFs, ZIP archives, and Word, Excel, and PowerPoint files in memory, and read PDFs with the real pdf.js. Chat tests (`chat.test.ts`) cover message validation, the link policy, the Markdown renderer (including the Run, Terminal, and CSV buttons), and the transcript. Conversation tests cover the store, history, and the Codex model catalog read from a fake CLI.

- **Permission bridge** (`permissions.test.ts`): the MCP handshake, allowed and denied calls in the format Claude Code reads, a real broker on a private pipe that refuses callers without the token, and the permission card's summaries and warnings.
- **Quota readings** (`quota.test.ts`): Claude's `rate_limit_event`, Codex's five-hour and weekly windows, and finding the run's own Codex session log and nothing else.
- **Sign-in** (`accounts.test.ts`): Claude's, Codex's, and Gemini CLI's status, each CLI's own sign-in and sign-out commands, the API key only on standard input, the terminal launch without a shell, and the chat's sign-in, refresh, and conflict messages.
- **Offline and machine-wide usage** (`offline-usage.test.ts`): the connection errors Claude Code, Codex, and Node report, the TCP probe and the proxy, rechecking a run waiting for the network every 15 seconds, `AgentLimits.observe`, and reading both CLIs' logs incrementally, counting each message once, including subagents.
- **Chat helpers** (`helpers-ui.test.ts`): the `sources` block with BibTeX and RIS, splitting a suggested command, slash commands, and the answer diff.
- **Agent mode** (`cliAdapters.test.ts`, `presentation.test.ts`): Claude's full toolset with the permission bridge, Codex's sandbox and network in any folder, and the consent text.
- **Runs** (`orchestrator.test.ts`, `limits.test.ts`): the recorded stop reason, the handover before a window is used up, pausing offline and continuing where the run stopped, fallback for a connection error while online, and dated weekly resets. The agents selector and Compare are covered by the smoke test.
- **Folder snapshots** (`worktree.test.ts`): snapshot, diff, keep, undo, per-file apply and discard, and nested repositories, with real Git.

Process-level behavior is tested with fake CLIs: `test/helpers.ts` writes a small Node.js script plus a launcher, a `.cmd` shim on Windows (the same shape npm installs for the real CLIs) or an executable shell script elsewhere. The adapter and check-runner tests run these through the real process runner, which covers argument escaping, stdin prompts, the environment allowlist, `--resume` and its fresh-session retry, and provider failure reports. Git snapshot and worktree tests create temporary repositories, so Git must be on `PATH`.

Run one coverage run at a time: two `vitest run --coverage` processes in the same checkout share the coverage folder and can fail each other.

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
- sends a second Edit message that adds another file, then edits and resends it, and checks that the message was replaced, its file was undone from the checkpoint, and Claude started a new session;
- sends a message while another runs, and checks that it waits in the queue and then runs by itself;
- chooses **Codex only** and checks that only Codex worked and Claude was not called, then **Codex + Claude** and checks that Codex answered and Claude checked;
- sends a Compare message and checks for two answers and a merge;
- runs **Fix with Dual Agent** and **Ask Dual Agent About This** on a file, and checks that they set the composer's mode (Edit, then Chat) without sending anything;
- checks that the chat page reported no script errors or content blocked by its Content-Security-Policy and Trusted Types;
- opens the chat in an editor tab and the **Get started** walkthrough.

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
- agent text in tooltips is Markdown-escaped, so `command:` links cannot be injected (`presentation.test.ts`);
- credentials in diffs and history are masked in prompts, and samples are assembled at run time so no credential-shaped literal is committed (`redact.test.ts`);
- the chat's HTML is created only through its Trusted Types policy (`chat.test.ts`);
- an agent at its usage limit is skipped until the reset, a run with both agents out stops with the reset time and continues on resume, and a continued session gets the turns it missed (`limits.test.ts`);
- a continuation the run rescheduled while it was continuing is kept, and overdue continuations run after a restart (`limits.test.ts`);
- a checkpoint restore reverts edits, re-creates deleted files, removes added ones, leaves ignored files alone, and refuses anything that is not a tree ID (`worktree.test.ts`);
- a folder snapshot never writes into the folder, leaves `.env` and `node_modules` alone on undo, and its removal refuses a path outside the extension's storage (`worktree.test.ts`);
- the permission bridge denies a caller without the token without asking the user, and denies everything when no broker is reachable (`permissions.test.ts`);
- a suggested command that uses pipes, redirection, chaining, substitution, or variables is refused rather than run without a shell (`helpers-ui.test.ts`);
- a Codex session log is read only for a thread ID that is a UUID, so `../` paths and other threads' logs are never opened (`quota.test.ts`);
- CSV cells that start with `=`, `+`, `-`, or `@` are written as text, not formulas (`chat.test.ts`);
- Claude's Agent-mode arguments always name the permission bridge, and fail without it (`cliAdapters.test.ts`).

Some tests run only on Windows or only on POSIX; CI covers both. Coverage is measured for `src/core`, `src/adapters`, `src/ui/presentation.ts`, the chat's protocol and transcript, and the Markdown renderer. The view classes, the chat controller, `extension.ts`, `config.ts`, and the page's Preact components are covered by the smoke test instead; the pure chat helpers (`permissions.ts`, `slash.ts`, `textDiff.ts`) and the permission server are unit-tested but not measured.

## Local extension debugging

1. Open the project in VS Code.
2. Press `F5` or run **Run Dual Agent Extension**. The build task runs first, and an Extension Development Host window opens.
3. In that window, open a disposable Git repository with at least one commit.
4. Select the **Dual Agent** activity-bar icon and expand **Agents**, or run **Dual Agent: Check Agent Setup**.
5. Test a Chat message first because it is read-only; try an attachment and a follow-up.
6. Test an Edit message next: allow edits, review the changes card in the diff editor, and apply or discard them. Then try Implement mode, which asks you to approve the plan.
7. In a disposable folder without Git, send an Agent message such as "install left-pad and show its version": answer the permission cards, then use **Undo all…** and confirm the folder is back as it was, apart from `node_modules`.
8. Check the chat in a light and a dark theme, and moved to the right-hand side bar.
9. Use `npm run watch` to rebuild on save, then **Developer: Reload Window** in the host. **Developer: Open Webview Developer Tools** inspects the chat page.

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

## Screenshots and icon

`npm run screenshots` builds the extension and renders `media/icon.png` and `media/screenshots/*.png` in headless Chrome or Edge (set `CHROME_PATH` to choose one). The screenshots load the real `dist/webview` bundle with VS Code's Dark Modern and Light Modern colors and sample conversations about a made-up project, defined in `scripts/screenshots.mjs`. Re-render them after visible chat changes. Screenshots are excluded from the VSIX; the Marketplace shows them from the repository, because `vsce` rewrites the README's relative links to the GitHub repository.

## Release procedure

### Before the first release

1. **Marketplace publisher.** Create the publisher `NileshRavishan` at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), signed in with the Microsoft account that will own it. The ID must equal `publisher` in `package.json`; changing it changes the extension's ID.
2. **First Marketplace version: upload by hand.** On the publisher page choose **New extension → Visual Studio Code** and upload the VSIX built by `npm run package` (or attached to the GitHub release).
3. **Marketplace trusted publishing, once it is available.** At the end of October 2026 the Marketplace backend did not yet accept `vsce publish --oidc` (vscode-vsce issue #1275), and Microsoft said it would be announced shortly. When the publisher page offers trusted publishers, add one for the repository `RavishanBBN/Dual-Agent-VS-Code-Orchestrator` and the workflow `release.yml`. Until then the release workflow's Marketplace step fails with a warning, the GitHub release is still created, and you upload that release's VSIX by hand.
4. **Open VSX (optional, for VSCodium, Cursor, and other editors).**
   1. Create an Eclipse account with your GitHub user name, log in to [open-vsx.org](https://open-vsx.org) with GitHub, then link the Eclipse account and sign the Publisher Agreement in **Settings**.
   2. Generate a token under **Settings → Access Tokens**. Then run `npx ovsx create-namespace NileshRavishan -p <token>` and `npx ovsx publish dual-agent-orchestrator-<version>.vsix -p <token>`. The first version must be published with a token.
   3. Claim ownership of the namespace by opening an issue at [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose); trusted publishing needs a verified namespace you own.
   4. Under **Settings → Trusted Publishers**, choose the namespace and GitHub Actions, and enter `RavishanBBN`, `Dual-Agent-VS-Code-Orchestrator`, and `release.yml`, with no environment.
   5. Delete the token.
5. **Repository security settings.** On GitHub, enable private vulnerability reporting and Dependabot alerts, and leave CodeQL's *default setup* off, because `codeql.yml` is the advanced setup. Add rulesets so only you can push `main` and `v*` tags.

Never store a publishing token in the repository. For a manual publish from your machine, set `VSCE_PAT` or pass `-p` for that one command only.

### Every release

1. Update the version in `package.json` and `CHANGELOG.md`, then `npm install --package-lock-only`.
2. Update `PROJECT_STATUS.md` verification results.
3. Run `npm.cmd run check`, `npm.cmd run smoke`, `npm.cmd audit`, and `npm.cmd run package`.
4. Install the VSIX in an isolated profile.
5. With signed-in CLIs, test doctor, a Chat message with attachments and a follow-up, an Edit message with apply, retry of an Edit message, a brainstorming run, cancellation, resume, export, and an implementation run in a disposable repository: approve the plan, review the diff, and apply it. Then, in a disposable folder without Git, an Agent message with its permission cards and **Undo all…**, and an Edit message with **Keep…**.
6. Commit, push `main`, and wait for CI and CodeQL to pass.
7. Tag the verified commit with the version and push the tag: `git tag v2.4.0 && git push origin v2.4.0`.

The **Release** workflow then:

1. checks that the tag matches `package.json`;
2. installs from the lockfile without a cache, then runs `npm audit`, `npm audit signatures`, and `npm run package`;
3. records SHA-256 checksums and a GitHub build-provenance attestation for the VSIX;
4. publishes that same file to the Marketplace and Open VSX, where each registry trusts the workflow;
5. creates a GitHub release with the VSIX and `SHA256SUMS.txt`, and lists in the run summary which registries accepted the version.

Anyone can verify a downloaded VSIX with `gh attestation verify dual-agent-orchestrator-<version>.vsix --repo RavishanBBN/Dual-Agent-VS-Code-Orchestrator`.

The package currently overrides `@azure/msal-node` to `7.1.0` because the VSIX packager's permitted dependency range otherwise resolves to a version covered by GHSA-xcx6-jx8p-x3h5. Re-evaluate and remove the override when `@vscode/vsce` declares a fixed compatible dependency directly.
