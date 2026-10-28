# Changelog

All notable changes are documented here. This project follows semantic versioning.

## [Unreleased]

## [2.4.0] - 2026-10-28

Agent mode runs commands and installs software with your approval, folders without Git can be edited, you choose which agent leads, and three new modes join Chat, Research, and Edit.

### Added

- **Agent mode.** It works like Claude Code in a terminal: Claude runs commands, installs packages, and edits the folder itself, then Codex checks the result. When the check fails, Claude finishes the task.
  - **Asking first.** Claude asks before each command or edit it does not judge read-only. The chat shows a card with what the agent wants to do, the exact command or edit, and warnings for deletions, administrator rights, scripts piped from the internet, changes to the system, and paths outside the folder. The choices are **Allow**, **Allow *tool* for this message**, and **Deny**. A modal dialog asks instead while the chat is hidden.
  - **The permission bridge.** Claude Code runs with `--permission-mode default` and `--permission-prompt-tool mcp__dualagent__approve`. That tool belongs to a small MCP server, bundled as `dist/permissionServer.js` and run on VS Code's own runtime, which asks the extension over a private local pipe. If the bridge cannot start, Claude cannot work in Agent mode, and the output log says why.
  - **When Codex leads.** Codex cannot ask, so it works inside its workspace-write sandbox. The sandbox can reach the network to install packages unless `dualAgent.codex.agentNetwork` is off.
  - **A snapshot first.** The folder is snapshotted before the first stage, so file changes can be kept or undone from the changes card. Installed software and other effects outside the folder cannot be undone, and the consent card says so.
  - **The web.** The lead agent has the web, as it would in a terminal session.
- **Folders without Git.** Edit, Test first, and Implement work in a folder that is not a Git repository or has no commit yet.
  - **The snapshot.** The extension records the folder's files in a bare repository in its private worktree storage (`direct-<id>.git`). Dependency and build folders such as `node_modules`, `.venv`, `dist`, and `build`, files whose names suggest secrets, and whatever the folder's own `.gitignore` files exclude are left out. Nothing is written to the folder.
  - **Direct edits.** The agents then edit the folder itself, and reviewers see the changes since the snapshot as a diff.
  - **Keep or undo.** **Keep…** deletes the snapshot. **Undo all…** restores it: changed and deleted files are put back, and files the agents created are deleted; the excluded folders are left as they are. **Undo** on one file restores only that file, and retrying a message restores the folder to its checkpoint.
  - **Limits.** A folder with more than 20,000 files outside the excluded folders is refused. A subfolder that is a Git repository of its own is named in a warning, because Undo cannot put back changes inside it.
- **Choose the agents** in the composer or with `/agents`:
  - **Claude + Codex**, the default.
  - **Codex + Claude:** Codex does the work and Claude checks it.
  - **Claude only** or **Codex only:** one agent runs each workflow's working stages, without a check, and the outcome says so. The other agent never stands in: at the chosen agent's usage limit the message pauses until the reset.
- **Compare mode.** Claude and Codex answer independently: Codex sees neither Claude's answer nor its steps. Claude then merges the two answers into one, with a "Where we differed" list that names which answer was right on each point and why.
- **Test first mode.** Codex writes tests that fail until the requested behavior exists; the failing checks after that stage are expected, so no repair follows. Claude makes the tests pass without weakening them, and Codex reviews the tests and the code together as the gate.
- **Research additions.**
  - **Gap matrix.** A question about research gaps or a body of literature gets a table of the key works by problem, method, data, main result, and limitation, followed by the open gaps.
  - **Claim table.** Codex's check starts with a table of every material claim, its source, and whether the source supports it.
  - **DOI and retraction checks.** Codex confirms each DOI resolves to the cited work and checks for retractions and corrections. A retracted source is a high-severity finding.
  - **Sources card.** Research answers end with a machine-readable `sources` block, shown as a card with **BibTeX** and **RIS** export.
  - **CSV.** Every table in an answer has a **CSV** button.
- **Editor integration.** None of these sends anything by itself; each fills the message box.
  - **Editor context.** The active file, the selected lines, and the file's errors and warnings go with the next message, shown as a chip you can turn off (`dualAgent.chat.includeEditorContext`).
  - **Quick fixes.** **Fix with Dual Agent** prepares an Edit message and **Explain with Dual Agent** a Chat message about a problem in the editor.
  - **Ask Dual Agent About This** in the editor's context menu, or `Ctrl+Alt+Shift+D` (`Cmd+Alt+Shift+D` on macOS).
  - **Findings in the editor.** Reviewers' findings that name a file and line appear as problems in the editor and the Problems panel (`dualAgent.findings.showInEditor`). **Dual Agent: Clear Findings in the Editor** removes them.
  - **Status bar.** The last message's outcome; clicking it opens the chat.
  - **Commit message.** After **Apply**, Source Control gets a suggested commit message, unless its message box already has text.
- **Apply or discard one file.** The changes card has **Apply** and **Discard** on each file; the other changes stay in the copy. To keep only part of a file, undo single changes with the arrows in the diff editor's margin before applying.
- **Disagreement view.** When a check led to a revision, **See what changed** shows a word diff of the first answer against the revision, with **Keep the revision**, **Prefer the first answer**, and **Check again**.
- **Subscription limits meter.** The usage panel shows each account's five-hour and weekly windows, how much of each is used, and when it resets. The header button turns to a warning at 90%.
  - **Claude** reports its windows in `rate_limit_event` stream events.
  - **Codex** records them in its session log. After each Codex stage, the extension reads the log of that stage's thread, and only its rate-limit fields.
  - **Handover before a failure.** A window 98% used marks the agent as at its limit until that window resets, so the other agent takes over before a call fails. `AgentLimits.observe` applies this rule to readings from runs and from the CLIs' logs alike.
- **Usage across the whole machine** (`dualAgent.usage.readLocalLogs`, on by default).
  - **What it reads.** The CLIs' own logs: Claude Code's `~/.claude/projects/**/*.jsonl`, including subagent files, and Codex's `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`, honoring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Only lines with a usage marker are decoded, and only token counts per local day for the last 8 days, Claude's usage-limit messages, and Codex's rate-limit percentages are kept.
  - **How.** Claude messages are counted once by message and request ID; Codex counts only the growth of its running total. Reading is incremental, skips files over 512 MB, and yields between files. It runs 10 seconds after start, 3 seconds after a change in either folder, and every 2 minutes.
  - **Where it shows.** The usage panel gets an **On this machine** section, with today and the last 7 days, covering terminals, other editors, and Dual Agent alike, above **In Dual Agent**.
  - **Effect on limits.** Codex readings from any session update the limits meter, and a limit found in either log hands work to the other agent before a call fails.
- **Network outages.**
  - **Recognized.** A new failure kind, `network`, covers the connection errors Claude Code, Codex, and Node report, such as "API Error: Connection error.", "stream disconnected … error sending request", `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, "fetch failed", and "dns error".
  - **Online or offline.** After a connection error, the extension opens a TCP connection to `api.anthropic.com`, `chatgpt.com`, or `api.openai.com` on port 443, or to the configured proxy, and closes it, sending nothing.
  - **Offline.** The message stops where it was, without trying the other agent, and continues by itself once the connection is back, checking every 15 seconds. The chat shows a **Waiting for the network** card with **Do not continue** and **Continue now** (or **Continue when online** when `dualAgent.limits.autoContinue` is off); a hidden chat gets a notification. Queued messages wait behind it, and the continuation survives a restart.
  - **Online.** The error is one provider's outage, and the other agent covers the stage.
- **Gemini as referee** (`dualAgent.gemini.enabled`, off by default).
  - **When:** after a check fails and before the revision.
  - **What:** Gemini CLI rules on each finding (upheld, partly upheld, or rejected) in its read-only plan mode. The ruling is shown in the check stage and given to the revision as evidence.
  - **Setup:** `npm install -g @google/gemini-cli`, then run `gemini` once to sign in. A row in the Agents view shows whether it is ready.
- **Slash commands.** Typing `/` lists them.
  - `/chat`, `/research`, `/agent`, `/edit`, `/test`, `/compare`, `/brainstorm`, and `/implement` send one message in that mode.
  - `/agents`, `/model`, `/effort`, and `/web` change the composer.
  - `/new`, `/history`, `/export`, `/usage`, `/brief`, and `/help` open those features.
- **Project brief.** A header button and **Dual Agent: Edit Project Brief** open `brief.md` in the extension's private workspace storage, not the repository. Both agents read it with every message, up to 4,000 characters.
- **Run and Terminal on shell code blocks.**
  - **Run** appears on one-line commands. It splits the arguments without a shell and refuses pipes, redirection, chaining, substitution, and variables. A modal confirmation names the folder. The command then runs as verification commands do, with the allowlisted environment, and its output is attached to the next message.
  - **Terminal** puts a one-line command into a terminal named **Dual Agent** without pressing Enter. Blocks of several lines can only be copied, since a pasted line break would run them.
- **Smaller additions.**
  - **Export a conversation** as Markdown from the history panel, with `/export`, or with **Dual Agent: Export Conversation as Markdown**.
  - **History search** over conversation titles and messages.
  - **Starter prompts** in an empty conversation.
  - **A chime** when a message that took longer than 15 seconds finishes (`dualAgent.chat.sound`).
  - **Attach a folder,** such as a set of papers. Regular files are copied within the archive limits, skipping links, dependency and tooling folders such as `node_modules`, and names that suggest secrets. PDF and Office files get their text extracted.
  - **Steps:** Claude's TodoWrite plan shows as a checklist step, and its thinking as a **Thinking** step.
- **Your own MCP servers** (`dualAgent.claude.userMcpServers`, off by default) let Claude load MCP servers as Claude Code does in your terminal: those in your own Claude configuration, and a repository's `.mcp.json` servers only if you approved them in Claude Code. Off, Claude loads none.
- **Sign in from VS Code.**
  - **Dual Agent: Sign In** runs the CLI's own sign-in in a terminal named after it: Claude Code with a Claude subscription, the Anthropic Console, or SSO; Codex with a ChatGPT account, a device code, or an API key; Gemini CLI with a Google account.
  - **Same configuration as the agents.** The terminal gets the agents' own environment, so the sign-in lands in the configuration folders the agents read.
  - **API keys go straight to the CLI.** An API key is typed into a password box and passed to the CLI's standard input. Dual Agent does not keep it.
  - **Status everywhere.** The **Agents** view shows each CLI's sign-in and plan, from `claude auth status` and `codex login status`, with **Sign In** and **Sign Out** on each row. The chat shows a banner when an agent the next message needs is signed out, and a message that failed because an agent is not signed in gets a **Sign in** button.
  - **Sign out.** **Dual Agent: Sign Out** runs the CLI's own sign-out, after a confirmation.
- **Refresh subscription limits.** **Refresh** in the limits meter, or **Dual Agent: Refresh Subscription Limits**, asks each agent for its current usage windows with one tiny call: Claude on Haiku, Codex at low effort. It runs only when you ask, because it uses a little of each subscription. A window whose reset time has passed now shows as empty instead of as it was.
- **Waiting changes.** An Agent message that would continue an Edit message's isolated changes, or an Edit, Test first, or Implement message that would continue Agent mode's direct changes, asks what to do with them: apply or discard, or keep or undo, then continue. Before, it did not start.
- ADR 0010.

### Changed

- **Marketplace name.** The extension is listed as **Dual Agent: Claude + Codex**, so searches for Claude and Codex find it. The description leads with what it does, and the keywords are broader. The extension ID, `NileshRavishan.dual-agent-orchestrator`, is unchanged, so installs and settings carry over.
- **Codex in any folder.** Codex stages always pass `--skip-git-repo-check`. Editing stages work in an isolated worktree or in a folder the extension snapshotted first, so Git's own check is no longer needed.
- **TodoWrite for read-only Claude stages.** They now get Read, Grep, Glob, and TodoWrite, which updates Claude's task list, not the workspace.
- **Agents by role.** The answer shown is the last completed stage that does the work rather than checks it, whoever ran it. Outcome labels name the agents that actually ran, such as "Claude agreed" when Claude checked.
- **Requests that need Agent mode.** Outside Agent mode, every stage that does the work is told to say in one line when a request needs Agent mode, such as installing software, and how to send it with `/agent`, and to do the part it can instead of refusing.
- **Checks after every stage that can change files.** Verification commands now also run after Agent-mode stages.
- **Fallback on connection errors.** A connection error while the machine is online is now eligible for fallback, like an unavailable provider.

### Fixed

- **Weekly limit resets.** Reset times that name a date are now read exactly, for example Codex's "try again at Oct 30th, 2026 5:51 PM" and Claude's "resets Nov 3, 9am". Before, they fell back to estimated retries every 15 to 120 minutes until the limit actually reset.
- **Stop right after Send.** The Stop button ignores clicks within one second of sending. A double click on Send stopped the new message, which showed as "Stopped after 4s".
- **Why a run stopped.** A cancelled run records why: "Stopped by you." or "VS Code closed while the message was running."

### Security

- **Permission bridge.**
  - **Private channel.** The broker listens on a named pipe on Windows, or a Unix socket elsewhere, with a random name. It answers only requests that carry a random 32-byte token, compared in constant time.
  - **Private configuration.** The MCP configuration that holds the token is written to the extension's private global storage with mode 0600, and deleted when the extension stops.
  - **The user decides.** Every decision comes from the user. A request the bridge cannot deliver, or that arrives without the token, is denied.
- **Run button.** It never uses a shell, refuses shell syntax, resolves the executable outside the folder, and asks first, because the command comes from agent output.
- **Codex session logs.** The thread ID is checked to be a UUID before it is used in a path, and only rate-limit fields are read from that thread's log.
- **The CLIs' logs.** The machine-wide reader decodes only lines with a usage marker and keeps only token counts, times, usage-limit messages, and rate-limit percentages. Conversations are never kept, logged, or sent; credential files are never opened; links are not followed. `dualAgent.usage.readLocalLogs` turns it off.
- **Connectivity check.** It only opens and closes a TCP connection to a provider host or the proxy, and sends no data.
- **CSV formulas.** A cell that starts with `=`, `+`, `-`, or `@` is saved with a leading `'`, unless it is a number, so a spreadsheet shows it as text instead of running it as a formula.
- **Folder snapshots.** They hold no files whose names suggest secrets, store the exact bytes without line-ending conversion or filters, and live in the extension's storage; removing one deletes only the snapshot repository.
- **Gemini referee.** Gemini CLI runs in its read-only plan mode, resolved outside the workspace, with the allowlisted environment.
- **Sign-in.** The extension runs only each CLI's own sign-in, sign-out, and status commands, resolved outside the workspace and without a shell (a Windows batch shim starts through the absolute `COMSPEC`). It never opens a credential file: Claude's and Codex's status come from their status commands, and Gemini's from the sign-in type in its settings file. An API key reaches the CLI only on standard input.

## [2.3.1] - 2026-10-28

The assistant introduces itself, and the chat runs on Preact 11.

### Added

- **Quick replies about the assistant.**
  - **What counts:** a greeting, a thank-you, or a question such as "hi, what are your skills?" or "who are you?".
  - **The reply:** one answer from the pair, built from a description of Dual Agent's modes, features, and limits.
  - **What it skips:** the workspace and Codex's check, so it costs one call instead of two or three.
  - **Any mode:** it applies in every mode, so a greeting in Edit mode no longer asks to edit files.
  - **What still gets the full workflow:** a message that names a task, a file, or code, or that has an attachment.
  - **Other wordings:** every Chat and Research prompt now says the agents speak for Dual Agent, so the assistant describes itself accurately however it is asked.

### Changed

- **Dependencies:**
  - The chat page now runs on Preact 11. The smoke test passes in VS Code, and three of the four screenshots render byte-for-byte identically. The fourth differs only in the frame of its animated spinner.
  - unpdf 1.9.1 for PDF text.
  - eslint 10.
  - CodeQL action 4.39.1.
- **Error causes.** eslint 10's `preserve-caught-error` rule found a cancellation that dropped the failure it interrupted; the failure is now kept as the error's cause.
- **Dependabot ignores two kinds of update.**
  - **@types/node major versions:** these types must describe the Node 22 that VS Code 1.105 runs. Version 26 also fails the typecheck.
  - **@types/vscode minor and major versions:** these must not exceed `engines.vscode`.

## [2.3.0] - 2026-10-28

Ready for the Visual Studio Marketplace and Open VSX. Work continues through usage limits, messages can be queued, and any earlier message can be retried or edited.

### Added

- **Solo mode at usage limits.**
  - **Limits are remembered.** When an agent reports a usage limit or exhausted credits, the extension records when the limit resets, reading the provider's message ("resets 3pm", "try again in 2 hours 13 minutes", Unix or ISO times).
  - **The other agent takes over.** Until the reset, that agent's stages go straight to the other agent, without failing first. The stage is marked as standing in.
  - **The limited agent rejoins and catches up.** After the reset it is tried again. A continued Claude session is given the turns it missed, which the other agent answered alone.
  - **Estimated resets.** When the provider gives no reset time, the agent is tried again after 15 minutes, then 30, 60, and 120.
  - **Persistence.** Limits are kept in global state, because they belong to the account.
- **Continue after the limits reset.**
  - **Pausing.** When both agents are at their limits, the message or run stops with the reset time and a **Paused at the usage limits** card.
  - **Automatic continuation.** By default (`dualAgent.limits.autoContinue`) it continues by itself a minute after the first reset, from where it stopped, and survives a restart of VS Code.
  - **Manual control.** **Continue now** and **Do not continue** are on the card and in the notification.
  - **Consent.** A run that edits files continues on its own only if its setup and verification commands are unchanged since you allowed it.
- **Message queue.**
  - **Queueing.** Messages sent while another runs, or while both agents are at their limits, wait in a queue above the composer, which you can remove items from. They run in order once the current message finishes.
  - **Persistence.** The queue is kept across restarts.
- **Retry and Edit for any message.**
  - **Retry** runs a message again.
  - **Edit** puts the message's text in the composer, and sending replaces the message.
  - **Rewinding.** In both cases the messages after it are removed, and the agents start new sessions, so nothing removed carries over.
  - **File changes are undone.** Before each Edit-mode message a checkpoint of the isolated worktree is recorded as a Git tree. Retrying from that message or earlier puts the files back, or discards the worktree if that message created it.
- **Secret masking** (`dualAgent.privacy.redactSecrets`, on by default).
  - **What is masked:** API keys, tokens, and private keys (AWS, GitHub, OpenAI, Anthropic, Google, Slack, Stripe, npm, Azure, JWTs, PEM keys).
  - **Where:** in the diffs, files, attachments, history, and check output the extension puts into prompts, and in the output log and exported reports.
- **Dual Agent: Delete All History.** It deletes every conversation, attachment, and run record for the workspace. It refuses while a run is active or while changes wait to be applied.
- **Get started walkthrough** in VS Code's Welcome page: setup check, chat, modes, checks, and reviewing changes.
- **Marketplace listing.** It adds a color icon, screenshots rendered from the real chat bundle (`npm run screenshots`), repository links, and the AI and Chat categories.
- **Release automation.**
  - **Trigger:** pushing a `v*` tag.
  - **Build:** verifies, audits, and packages; records SHA-256 checksums and GitHub build provenance for the VSIX.
  - **Publish:** to the Visual Studio Marketplace and Open VSX through OpenID Connect trusted publishing (no stored tokens), then to a GitHub release. Until a registry trusts the workflow (the Marketplace did not yet accept it at release time), the VSIX from the GitHub release is uploaded by hand.
- **Repository hygiene:** CodeQL code scanning, Dependabot with a one-week cooldown, `npm audit` and registry-signature checks in CI, issue and pull-request templates, and a private vulnerability-reporting policy.

### Changed

- **The chat page requires Trusted Types.** Its Content-Security-Policy allows only the Markdown renderer's policy to create HTML, and adds `base-uri 'none'` and `form-action 'none'`. Script errors and blocked content are reported to the output log.
- **More quota wording is recognized.** "5-hour limit reached", "hit your usage limit", "weekly limit", and "credit balance is too low" now count as quota failures, so they trigger fallback.
- **A stand-in's stage is titled for the agent that ran it** ("Codex answers"). The answer, and **Copy answer**, come from the stage in Claude's role, whoever ran it.
- **Tooling.** All GitHub Actions are pinned to commit SHAs with `persist-credentials: false`. `@vscode/vsce` is 4.0.0 and `cross-spawn` is pinned exactly. `vsce package` runs without bypass flags.
- **Extension ID.** It is now `NileshRavishan.dual-agent-orchestrator`. Conversations and runs recorded under the earlier local ID `local.dual-agent-orchestrator` stay in that ID's storage and are not shown.

### Fixed

- **Lockfile labels.** The lockfile labelled `isexe` and `shebang-command` as 2.1.0, a version that never existed, while resolving them to the genuine 2.0.0 tarballs. This was a side effect of replacing the 2.1.0 version bump across the file. The installed code was always the real 2.0.0, but `npm audit signatures` failed on a clean install. The labels are corrected, and a test now checks that every label matches its tarball. The published 2.3.0 VSIX is unaffected, because it bundles the same code.

## [2.2.0] - 2026-10-28

Research support and better answers for fewer tokens.

### Added

- **Research mode.**
  - **Claude researches** with the web, the attachments, and the workspace. It reads every source before citing it, cites each claim inline with a numbered source list, separates established, contested, and unknown points with its confidence, and maps research gaps.
  - **Codex verifies the sources:** it opens every cited source, confirms it exists and supports its claim, and searches for missing or contrary work.
  - **Claude revises** when needed, keeping only confirmed sources.
  - **Both agents reason at high effort** unless you choose otherwise.
- **Web access.** A **Web** toggle in the composer lets the agents search and read the web for a message in any mode; Research always has it. Claude gets WebSearch and WebFetch, and Codex runs with `--search`. Codex's web steps appear on the timeline.
- **First-shot edits.** Editing stages may run your configured verification commands themselves (for example `node --test math.test.js` under `Bash(node --test:*)`), and when the checks still fail after an edit, Claude repairs once before Codex reviews.
- ADR 0008.

### Changed

- **Lean context.** Chat, Research, and Brainstorm stages get the workspace as a summary (status, diff summary, at most 8,000 characters of diff, untracked file names) and read what they need. Editing reviews keep the full diff.
- **Evidence trail.** Each stage after another sees the previous stage's steps, so reviewers verify specific claims and look at what was not examined.
- **Prompt guidance.**
  - Every stage is told to work economically: search before reading, read only what is needed, and don't re-read.
  - Conversation answers lead with the result and drop stage-report sections, and a passing check is at most two sentences.
  - The Edit stage reads callers and tests first, follows the project's conventions, adds tests, and runs the checks.
- **Minor notes.** A Chat or Research check that fails with only low-severity findings keeps the answer and shows the notes ("Codex agreed, with 2 minor notes") instead of spending a revision.

### Verified live

Using Claude haiku and Codex gpt-5.6-luna:
- **Tokens:** with the same chat question and attachments as before, the follow-up's Codex check used half the input tokens (15.7k instead of 31.3k), and answers were shorter.
- **Research:** a research run found three real problems in Claude's first draft through Codex's source check, and Claude corrected them after reopening the papers.
- **Edit:** an Edit run had Claude run `node --test math.test.js` itself before finishing.

## [2.1.0] - 2026-10-28

A Claude Code–style chat becomes the main interface. Claude answers and Codex checks the answer, conversations take attachments, and each agent's model and effort can be chosen per message. The Runs and Agents views, Command Palette workflows, and every safety boundary from 2.0 remain.

### Added

- **Chat panel.** A **Chat** view in the right-hand (secondary) side bar, where Claude Code places its panel, also available as an editor tab (**Dual Agent: Open Chat in Editor**; `Ctrl+Alt+D` focuses it).
  - Claude's text streams in as it is written.
  - A timeline shows each agent's stage (Claude orange, Codex blue) and every tool call with the tool's name, its IN (command, path, pattern, or edit) and OUT, as in Claude Code. Steps are saved with the run, so they stay after the message finishes. Codex's verdict appears as a badge.
  - An editor title-bar button opens the chat as a tab named after the conversation.
  - Agent Markdown is rendered with tables and code blocks with a Copy button, and file references open at the cited line.
  - Token usage per stage, per message (a table per agent, with the Claude CLI's API-equivalent cost estimate), and overall: a header button and **Dual Agent: Show Token Usage** show this conversation, today, the last 7 days, and all runs. Past conversations are listed in a history.
- **Chat mode** (the default): Claude answers, Codex checks the answer against the code and attachments, and Claude revises only when the check fails. It is read-only, with two or three agent calls per message.
- **Edit mode:** Claude edits an isolated worktree, verification commands run, and Codex reviews the diff as a gate, followed by fix rounds. A card lists the changed files with **Review all**, **Apply…**, and **Discard…**. Later Edit messages in the conversation keep working on the same worktree.
- **Brainstorm and Implement from the chat,** with the plan approval card (approve, approve with guidance, review plan, reject) and the edit consent card (allow once or for the conversation, with the commands that will run).
- **Conversations.** Follow-up messages continue Claude's session; Codex starts fresh with a budgeted history of the conversation. Conversations are saved one file each and survive run-history pruning.
- **Attachments.**
  - **Ways to attach:** paste, drop, or pick files, or type `@` to mention a workspace file.
  - **Images** (PNG, JPEG, GIF, WebP) go to Claude's Read tool and to Codex with `--image`.
  - **PDFs** are read by Claude directly; Codex gets the text, extracted with pdf.js in a worker thread.
  - **Word, Excel, and PowerPoint** files have their text extracted for both agents.
  - **ZIP archives** are unpacked safely.
  - **Jupyter notebooks and any text or code file** are supported too.
- **Models and effort.**
  - Composer pickers for each agent's model and reasoning effort, or the CLI default.
  - Codex's models and their supported efforts come from `codex debug models`.
  - New settings `dualAgent.claude.effort` and `dualAgent.codex.effort` set the defaults.
- The model Claude reports is recorded on each stage and shown in the chat.

### Changed

- The chat has its own container in the secondary side bar; the activity-bar icon holds Runs and Agents, with a link to the chat.
- Read-only Codex stages pass `--skip-git-repo-check`, so Chat and Brainstorm work in folders without Git.
- `dualAgent.history.maxRuns` defaults to 100, since every chat message is a run.
- The plan approval notification is shown only while the chat is hidden, since the chat has its own card.
- Applying or discarding a worktree updates every run that shared it.

### Fixed

- Claude's input tokens now include cache reads and writes, and its thinking tokens are recorded. Claude reports them separately, so earlier runs showed only a few uncached input tokens per stage; usage recorded before 2.1.0 still under-counts Claude's input.

### Security

- Claude stages pass an explicit `--tools` list. Plan mode alone let read-only stages run shell commands that Claude Code judged read-only, such as `node -e` scripts, and write a plan file outside the workspace; it also offered Bash, PowerShell, WebFetch, and publishing tools. Read-only stages now get Read, Grep, and Glob only. Write stages add Edit, Write, and NotebookEdit, plus the tools named by `dualAgent.claude.allowedTools` rules, so user-level Claude rules can no longer add a shell. A Claude Code version without `--tools` fails the stage instead of running unrestricted.
- The chat page runs under a nonce Content-Security-Policy with no network access and command URIs disabled. Agent HTML is escaped, images in agent Markdown never load, links open only after a check and a confirmation, files open only inside the conversation's folder or worktree, and every message from the page is validated.
- Attachments are stored privately and classified by content. Archives are unpacked as regular files only, with path, count, size, and compression-ratio limits. PDFs are parsed in a worker thread with a timeout. Files with secret-looking names need confirmation.
- Models and efforts are validated wherever they enter: settings, the composer, and stored runs. A value that could read as a flag never reaches a CLI.
- Dependencies are pinned: preact 10.29.8, markdown-it 15.0.3 (the release that fixes two quadratic-time parsing advisories), fflate 0.8.3, and unpdf 1.8.1.

## [2.0.0] - 2026-10-28

A native VS Code interface replaces the webview dashboard, and the improvement proposals from the 1.0 review are implemented. Implementation runs now edit an isolated Git worktree by default, and plan approval is on by default; set `dualAgent.isolation.mode` to `none` and `dualAgent.workflow.approvePlan` to `false` for 1.x behavior.

### Changed

- **Native interface.** The Dual Agent activity-bar container now holds a **Runs** tree view (runs, stages, check results, warnings, changed files) and an **Agents** view (Claude Code, Codex, and Git health), with a welcome view, title and context-menu actions, Command Palette commands, a status bar item, and a **Dual Agent** output channel. Stage outputs, check logs, and reports open as read-only documents, and changes open in the built-in diff editors. The webview, its HTML/CSS/JS assets, and its message protocol are removed.
- Objectives are typed in an input box or taken from the active editor's selection; in a multi-root workspace you choose the folder (previously the first folder was always used).
- The final Claude stage writes the completion report read-only. Fixes after the final verification happen only in fix rounds that are verified again.
- A run's status now reflects the final gate: `completed` only when the last verification passed, otherwise `completed-with-findings`.
- The manifest no longer lists `activationEvents`; VS Code derives them from the contributed views and commands.

### Added

- **Verification gate.** Review stages end with a machine-readable `verdict` block that is parsed into an outcome and findings by severity. A failing, missing, or unparseable verdict, or a failing verification command, fails the final gate. Claude then gets up to `dualAgent.workflow.maxFixRounds` fix rounds (default 1), each followed by a fresh Codex re-verification.
- **Extension-run checks.** `dualAgent.verification.commands` run after every editing stage, and `dualAgent.isolation.setupCommands` once in a new worktree. Each is an argument list run without a shell, resolved outside the workspace, with the allowlisted environment and a timeout (`dualAgent.verification.timeoutMinutes`). Exit codes are reported to reviewers as reliable evidence, and the output is fenced as untrusted.
- **Isolated worktrees.** `dualAgent.isolation.mode` (default `worktree`) runs implementation in a detached worktree. Its base includes your uncommitted and untracked work, and your branch, index, stash, and files are not touched. **Review Changes** opens every change in the multi-file diff editor. **Apply Changes** checks the whole patch for conflicts and writes the working tree only, and **Discard Changes** deletes the worktree.
- **Plan approval.** `dualAgent.workflow.approvePlan` (default on) pauses before the first editing stage. You can open the plan beside its review, approve, approve with guidance that later prompts include, or reject.
- **Session continuity.** `dualAgent.claude.resumeSessions` (default on) continues the previous Claude session in later Claude stages and leaves Claude's own earlier output out of the prompt. If the session is gone, the stage reruns in a new session automatically.
- **Resume Run.** Failed and cancelled runs continue from their first unfinished stage, keeping completed stages and an earlier approval. Runs interrupted by closing VS Code are marked cancelled on the next start.
- `npm run smoke`: an automated test inside a real VS Code. It completes a run against fake CLIs and reviews a worktree's changes in the diff editors.

### Security

- Every Git command the extension runs disables hooks (`core.hooksPath` set to the null device). Worktree checkout, staging, and ref updates would otherwise run repository hooks, which an agent with write access could plant.
- Executables for agents, Git, and configured commands exclude the workspace, the worktree, and the repository root.
- Untracked files whose names suggest secrets are never copied into a worktree, so they are not written into the repository's object database.
- Worktree deletion refuses any path outside the extension's storage, and runs whose changes have not been applied or discarded are never pruned from history.
- Agent text reaches tooltips only Markdown-escaped in untrusted `MarkdownString`s, so injected `command:` links cannot activate.
- Claude session IDs that could be read as command-line flags are rejected.

### Fixed

- A Claude error result reported only in `errors` (for example an unknown session) now surfaces that message instead of a generic subtype.
- Path containment checks resolved Windows short names (such as `C:\Users\RUNNER~1`) and linked directories only for paths that already existed. A path that does not exist yet is now resolved through its deepest existing parent. Previously untracked files were not copied into a worktree under such a folder, and a new file under a linked directory that points elsewhere counted as inside.

## [1.1.0] - 2026-10-28

Security hardening release. Upgrade from 1.0.0 and rebuild any distributed VSIX: the first and fourth items under Security can be exploited by a malicious repository.

### Security

- Agent CLIs and Git are resolved to absolute paths that never come from the workspace. On Windows a `codex.cmd`, `claude.cmd`, or `git.exe` planted in the repository root previously ran instead of the real tool, outside any sandbox, and an agent that could write files could plant one for the next stage.
- Cancellation and timeouts terminate the agent's whole process tree. On Windows, killing an npm `.cmd` shim previously left the real agent running and editing files, and the stage waited for it.
- A cancellation that arrives while a Git snapshot is being taken now stops the stage; previously the agent ran to completion with its full permissions.
- Claude stages pass `--setting-sources user` and `--strict-mcp-config`, so repository hooks, permission rules, and MCP servers no longer apply in print mode, which skips Claude Code's folder-trust prompt.
- The extension declares that it does not support untrusted or virtual workspaces, and checks workspace trust before running.
- Agents receive an allowlisted environment instead of the full extension-host environment. Subscription mode also removes `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_BASE_URL`, and `AZURE_OPENAI_API_KEY`, ignoring case on Windows.
- Failures are classified from provider error reports and stderr only, with word-boundary patterns. Previously the whole output stream, including repository text, decided whether a failed write stage fell back to the other provider.
- Untrusted prompt content is fenced with a random per-prompt boundary, and forged closing tags are escaped. The stage contract is restated after the evidence, as the threat model already claimed.
- All settings are machine-scoped and read only from user settings; numeric settings are clamped and model names and tool rules validated.
- Git snapshots disable filesystem monitors, external diff and textconv drivers, and optional index locks.
- The webview receives only the fields it renders, validates incoming messages, and uses a cryptographic CSP nonce.
- Reports are exported to the home folder by default instead of the repository.

### Fixed

- The orchestrator could be left permanently "already running" when saving the run failed, and a corrupted `runs.json` broke every save; unreadable history is now set aside.
- Git failures such as "dubious ownership" produced an empty diff silently. They are now run warnings, and implementation workflows require a working Git repository.
- Staged changes and new untracked files were missing from the review diff.
- A fallback attempt reused the snapshot taken before the failed attempt.
- Process output was buffered without limit, and every activity event sent the complete run record to the webview.
- A process that exited before reading its prompt could raise an unhandled `EPIPE` error.
- Settings changed during a run were never applied; `history.maxRuns` changes required a reload.
- Usage reported by failed attempts was discarded.
- Claude error results (`is_error`) and Codex `turn.failed` events could be accepted as stage output.
- Prompt truncation could cut through a block boundary or drop the newest stage output.
- The write-consent checkbox did not hide for brainstorming.

### Added

- `dualAgent.claude.allowedTools`: Claude permission rules for write stages, so Claude can run approved commands such as tests in print mode.
- `dualAgent.environment.passthrough`: extra environment variables for agents.
- Run warnings in the dashboard and exported report.
- Regression tests for each vulnerability above, fake-CLI adapter tests, and Git snapshot tests. Coverage now includes the process runner, adapters, and Git snapshot.

## [1.0.0] - 2026-10-27

### Added

- Claude-led seven-stage implementation workflow.
- Claude-led five-stage reciprocal brainstorming workflow.
- Codex JSONL and Claude stream-JSON adapters.
- Read-only and workspace-write permission mapping.
- Explicit implementation write consent.
- Subscription-only child-process environment mode.
- Git-aware bounded checkpoint context.
- Quota, timeout, and unavailable-provider fallback.
- Durable private run history and Markdown report export.
- VS Code activity-bar dashboard and command-palette actions.
- Strict TypeScript, ESLint, Vitest coverage, esbuild, VSIX packaging, and CI.
- Architecture, workflow, security, operations, development, status, and ADR documentation.
