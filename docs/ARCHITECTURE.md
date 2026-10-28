# Architecture

## System boundary

Dual Agent is a local desktop VS Code extension. The VS Code extension host owns orchestration and launches the official agent CLIs, Git, the optional Gemini CLI referee, and the user's configured commands as child processes. It does not proxy raw model APIs, loads no remote content, and opens no network port; Agent mode's permission bridge uses a local named pipe or Unix socket. Its only network activity of its own is a connectivity check after a connection error, which opens and closes a TCP connection without sending data. It reads the CLIs' own logs for usage counts and limits. The chat panel is a webview whose page comes entirely from the extension package.

```text
┌──────────────────────────── VS Code ─────────────────────────────────┐
│                                                                      │
│  Chat webview (dist/webview) ◄── validated messages ──┐              │
│  Runs view · Agents view · status bar · output channel │              │
│  editor: code actions, findings as problems, context   │              │
│  dual-agent-run: documents · dual-agent-base: diffs    │              │
│      │ commands, QuickPick, input box, modal consent   │              │
│      v                                                 │              │
│  extension.ts (composition root) ── ChatController ────┘              │
│      │        │                    │ conversations, attachments       │
│      │        └─ PermissionBroker ◄┼── pipe + token ──┐               │
│      v                             v                  │               │
│  WorkflowOrchestrator ── FileRunStore (private storage)│               │
│      │   │   │   └── worktree.ts ──> worktree or folder snapshot      │
│      │   │   └────── checkRunner ──> setup/verification cmds, Run     │
│      │   └────────── gitSnapshot + context builder    │               │
│      ├── ClaudeCliAdapter ──> claude ──> permissionServer.js (MCP)    │
│      ├── CodexCliAdapter  ──> codex  ──> session log (rate limits)    │
│      ├── GeminiReferee    ──> gemini (plan mode, optional)            │
│      └── isOnline ──> TCP connect to provider host or proxy           │
│  LocalUsageScanner ──> ~/.claude/projects, ~/.codex/sessions          │
│  pdfWorker.js (worker thread) ── PDF text for attachments             │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Components

### Chat (`src/ui/chat`, `src/webview`)

- **Chat view** (`chatProvider.ts`): a `WebviewViewProvider` for the `dualAgent.chat` view, and the same page in an editor tab. The page loads only `dist/webview/chat.js` and `chat.css` under a Content-Security-Policy that allows the bundle's nonce-tagged script, the extension's own styles, and images from the webview's resource roots, which are the bundle and the attachment folder. The policy requires Trusted Types and allows only the Markdown renderer's policy. Command URIs are disabled. The page reports script errors and policy violations back to the output log.
- **Protocol** (`protocol.ts`): every message type in both directions. `parseWebviewMessage` validates each incoming message (types, lengths, IDs, base64) and drops anything malformed; `linkTarget` and `fileReference` decide what a link in agent output may open.
- **Transcript** (`transcript.ts`): a pure function from conversations, runs, live streaming state, and worktree changes to the view model the page displays. The page makes no decisions of its own.
- **Controller** (`chatController.ts`): owns conversations, pending attachments, the composer's mode, models, and efforts (in `globalState`, never workspace settings), and the edit-consent cards. It turns a message into a run through the extension's single-run lock and records each finished run on its turn.
  - **Queue.** It holds the message queue, persisted in `workspaceState`, and drains it whenever the lock is free and the agents can work.
  - **Retry and edit.** It handles both by rewinding the conversation and the worktree checkpoint before running the message again.
  - **Catch-up.** For each continued session, it computes the turns that session missed.
  - **Permission requests.** `askPermission` holds an Agent-mode request from the broker until the user decides on the chat's card or, while the chat is hidden, in a modal dialog, and keeps the tools allowed for the rest of a run.
  - **Chat actions.** It runs a code block's command through the host after `splitCommandLine`, exports conversations, tables, and sources through a save dialog, and reads the project brief and the editor context for each message.
- **Permission view** (`permissions.ts`): turns a request's tool and input into the card's summary, exact command or edit, and warnings. It has no `vscode` import, so it is unit-tested.
- **Slash commands** (`slash.ts`): parses `/mode`, `/agents`, `/model`, `/effort`, `/web`, and the feature commands, and lists matches for the composer's menu. Pure, and bundled into the page.
- **Answer diff** (`textDiff.ts`): a word-level longest-common-subsequence diff of the first answer against its revision, falling back to lines for long texts. Pure, and bundled into the page.
- **Page** (`src/webview/main.tsx`): Preact components for the transcript (a timeline of stages, each with its tool calls and their IN/OUT boxes, TodoWrite checklists, Thinking steps, and streamed text), consent, approval, permission, changes, comparison, sources, and check cards, the usage panel with the limits meter, the history with search and export, and the composer with attachments, `@` mentions, the editor chip, slash commands, mode, agents, and model pickers. `markdown.ts` renders agent Markdown with markdown-it: raw HTML is escaped, images are disabled, and links carry their target in a data attribute that the extension checks when clicked. It adds **Run** and **Terminal** buttons to shell code blocks, a **CSV** button to tables (`rowsToCsv`), and hides the `verdict` and `sources` blocks. Styles use VS Code theme variables only.

### Native views (`src/ui`)

The rest of the interface uses native VS Code components:

- **Runs view** (`views.ts`): a tree of recent runs, then each run's warnings, stages, check results, and changed files. Icons and descriptions show status, agent, permission, verdict, and check outcome. Context values such as `run resumable worktree` drive the inline and context-menu actions. Redraws are debounced, and a worktree's change list is read only while no agent works in it.
- **Agents view**: Claude Code, Codex, and Git health, and Gemini CLI's when the referee is enabled, including the resolved executable path and whether Git accepts the workspace.
- **Welcome view**: start links shown while there is no run.
- **Status bar** (`approvals.ts`): the active run's stage progress, and a highlighted prompt while a plan waits for approval. A second item shows the last finished message's outcome and opens the chat.
- **Editor integration** (`extension.ts`): a code-action provider offering **Fix with Dual Agent** and **Explain with Dual Agent** on diagnostics, **Ask Dual Agent About This** in the editor context menu, and a `Dual Agent` diagnostic collection for reviewers' findings. Each command only fills the composer through `ChatController.prefill`.
- **Output channel**: a `LogOutputChannel` with orchestrator activity, check output, and excerpts of agent events.
- **Documents** (`documents.ts`): a read-only `dual-agent-run:` content provider for reports, stage outputs, and check logs, refreshed while a run progresses; and a `dual-agent-base:` provider that serves a file from a run's base commit as the left side of the diff editor.
- **Approvals** (`approvals.ts`): holds the orchestrator's approval request until the user decides through the chat's approval card, a notification (shown only while the chat is hidden), the status bar, the Runs view, or the Command Palette.
- **Presentation** (`presentation.ts`): pure functions for labels, icons, context values, tooltips, and dialog text, with no `vscode` import, so they are unit-tested. Text from agents and repositories is Markdown-escaped before it reaches a tooltip, and tooltips are untrusted `MarkdownString`s, so command links never activate.

### Usage limits and continuations (`src/core/limits.ts`, `src/ui/continuations.ts`)

- **Limit tracker.** `AgentLimits` holds the usage limit each agent last reported and when it resets, persisted in `globalState` because limits belong to the account. The orchestrator receives it as a dependency: it skips a limited agent, records limits from quota errors, clears them after a successful call, and stops a run with `limitReset` when no agent can continue.
- **Scheduler.** `ContinuationScheduler` keeps the runs waiting to continue after a reset, persisted in `workspaceState`. It fires them through the extension, which checks consent conditions and resumes the run through the chat or the orchestrator.
- **Quota readings.** A `QuotaReading` lists an account's usage windows with the percentage used and the reset time. The flow:
  1. The Claude parser reads `rate_limit_event` stream events (`claudeQuota`); after each Codex stage, `readCodexQuota` reads the rate limits from the session log of that stage's thread (`codexQuota`).
  2. The adapter puts the reading on the stream event or the `StageResult`.
  3. The orchestrator's `noteQuota` passes it to the `onQuota` dependency, which keeps the latest reading per agent in `globalState` for the chat's limits meter.
  4. `AgentLimits.observe` then applies the handover rule (`NEARLY_EXHAUSTED`, 98): when the reading says the limit is reached, or a window is at least 98% used, it records the limit until that window resets, so the next stage goes to the other agent.
- **Machine-wide usage** (`src/adapters/localUsage.ts`). `LocalUsageScanner` reads the CLIs' own logs incrementally, keeping per-file byte offsets: Claude Code's `projects/**/*.jsonl` and Codex's dated `sessions` folders for the last 8 days. It decodes only lines with a usage marker and returns token counts per local day, the newest Codex rate-limit reading, and a recent Claude limit message. The composition root runs it 10 seconds after activation, 3 seconds after a recursive `fs.watch` on either folder fires, and every 2 minutes, while `dualAgent.usage.readLocalLogs` is on; its quota readings go through the same `onQuota` and `AgentLimits.observe` path, and its counts feed the usage panel's **On this machine** section.
- **Accounts** (`src/adapters/accounts.ts`). Each CLI's own status, sign-in, and sign-out commands, with the agents' allowlisted environment. `accountStatus` parses `claude auth status --json`, `codex login status`, and Gemini CLI's sign-in type; `terminalLaunch` starts an interactive sign-in in a VS Code terminal without a shell; `signInWithKey` passes an API key on standard input. The composition root keeps the latest status per CLI, refreshes it with the Agents view and while a sign-in terminal is open, and gives it to the chat for its sign-in banner.
- **Connectivity** (`src/adapters/connectivity.ts`). `isOnline` opens a TCP connection to a provider host, or to the configured proxy, and closes it. The orchestrator receives it as the `online` dependency and asks it after a `network` failure: offline, it throws `ConnectionLostError` and the run stops with `offlineSince`; online, the failure falls back like an unavailable provider. The continuation scheduler retries a run waiting for the network every 15 seconds (`network: true`) and resumes it once `isOnline` answers yes.

### Agent mode permission bridge (`src/adapters/permissionBroker.ts`, `src/permission`)

Claude Code in print mode cannot show its own permission prompt, so Agent mode routes it through a local MCP server:

```text
claude (--permission-prompt-tool mcp__dualagent__approve, --mcp-config permission-mcp.json)
   │ stdio, JSON-RPC: tools/call approve {tool_name, input}
   v
dist/permissionServer.js (own process, VS Code's runtime with ELECTRON_RUN_AS_NODE=1)
   │ named pipe or Unix socket: {token, toolName, input}
   v
PermissionBroker (extension host) ── token check ──> ChatController.askPermission
   │                                                   │ card in the chat, or a modal dialog
   v                                                   v
{behavior: allow | deny} <──────────────────────── the user's decision
```

- **Broker.** `PermissionBroker.start` listens on a randomly named pipe or socket, and writes `permission-mcp.json`, naming the server script, the pipe, and a random token, to global storage with mode 0600. It answers each request line after checking the token with `timingSafeEqual`, and denies malformed, oversized, or unauthenticated requests. `dispose` closes the pipe and deletes the file.
- **Server.** `src/permission/server.ts` implements the MCP handshake, lists one `approve` tool, and forwards each call to the broker. It allows a call only when the broker answers `allow`, passing the input through unchanged, and denies when the broker is unreachable or closes first. `main.ts` is the entry point, bundled as `dist/permissionServer.js`.
- **Adapter.** The composition root starts the broker on activation and passes `{ configFile, tool }` to the Claude adapter, which builds the Agent-mode arguments from it. Without it, a Claude Agent-mode stage fails with an invalid-request error.

### Referee (`src/adapters/gemini.ts`)

`GeminiReferee` runs Gemini CLI with `--output-format json --approval-mode plan`, the prompt on standard input, and an optional validated `--model`, through the same `resolveExecutable`, allowlisted environment, and process runner as the agents. `parseGeminiOutput` reads the response, the per-model token counts, and an error report. The orchestrator receives the referee as an optional dependency; `doctor` feeds the Agents view.

### Small pure modules

- **`src/core/about.ts`**: `ABOUT_DUAL_AGENT`, the product description used by quick replies, `DUAL_AGENT_IDENTITY` for conversational prompts, and `isSmallTalk`.
- **`src/core/citations.ts`**: `parseSources` reads a research answer's `sources` block, checking and trimming every field; `toBibtex` and `toRis` write it for reference managers.
- **`src/core/commandLine.ts`**: `splitCommandLine` turns a one-line command from agent output into an argument vector, or refuses it when it uses shell syntax.

### Secret masking (`src/core/redact.ts`)

`redactSecrets` replaces recognizable credentials with a labelled placeholder. The prompt builder applies it to every untrusted section before fencing; the extension applies it to the output log and exported reports.

### Composition root (`src/extension.ts`)

It reads user-level configuration, resolves the trusted local folder (asking in a multi-root workspace), reads the objective (typed, or the active editor's selection), and asks for consent. It starts the permission broker, constructs the adapters, the optional referee, the orchestrator, and the chat controller with their dependencies, registers commands and providers, and handles review, apply, discard, keep and undo, per-file apply and discard, export, and resume. Its `prepareWorktree` creates a worktree, or a folder snapshot for Agent mode and for a folder that Git does not track or that has no commit. After a full apply it suggests a commit message in the Git extension's input box when that box is empty. It also implements the chat host's editor context (active file, selection, and up to 20 errors and warnings, only for a file inside the folder), the project brief, and the **Run** confirmation, which runs the command through `runChecks`. Applying or discarding a worktree marks every run that shared it, since a conversation's edit messages work in one worktree. Only one run, or one run being set up, can be active. Configuration changes made during a run apply when it ends. On activation, runs left active by a closed window are marked cancelled.

### Workflow orchestrator (`src/core/orchestrator.ts`)

The orchestrator is a sequential state machine. It:

1. validates the objective and write consent;
2. materializes an immutable workflow template into a run record, arranged for the chosen agents with `arrangeStage` (swapped roles, or one agent's working stages), downgrading every stage to read-only when the run has no write consent;
3. for an isolated Edit, Test first, or Implement run, reuses the conversation's worktree if it still exists, or creates one (a folder snapshot when the folder has no Git or no commit); for an Agent run, always a folder snapshot. A message never continues the other kind of changes (`worktreeConflict`); then runs setup commands once;
4. records repository-configuration warnings from each adapter;
5. for a run that edits files, refuses to continue unless Git can describe the working directory;
6. before a stage marked `requiresApproval`, waits for the user's decision when plan approval is enabled;
7. captures the Git snapshot before each stage, recording its warnings;
8. builds bounded shared context, and a shorter prompt when the agent's earlier session, in this run or the conversation's previous message, can be continued;
9. invokes the assigned adapter with the run's model and effort (validated again), image attachments, and attachment folders, and parses a verdict from review stages;
10. passes every quota reading to `noteQuota`, which records a reached or nearly used-up window through `AgentLimits.observe`;
11. after a connection error, asks `online`, and stops the run with `offlineSince` when the machine is offline;
12. attempts one eligible fallback when configured, with a fresh snapshot;
13. runs verification commands after every stage that can change files, adding one repair stage when they fail, unless the stage expects failing checks (Test first's tests);
14. applies the gate after a gating stage, inserting a fix round or recording unresolved findings, and after a chat, research, or agent check that did not pass inserts the single revision stage, consulting the referee first when one is configured;
15. persists and emits every transition, tagging agent events with their stage, and marks later stages skipped after failure or cancellation, recording the reason given to `cancel` ("Stopped by you." by default).

Its dependencies (snapshot capture, worktree creation, the check runner, the approval handler, reading attachment text, usage limits, the quota listener, the connectivity check, and the referee) are injected, so the whole state machine is tested without VS Code, Git, or live models. `resume` resets every unfinished stage of a failed or cancelled run and continues; `updateRun` changes a finished run, such as marking its worktree applied.

Only one run can be active in an extension host. The active marker is cleared in a `finally` block even when saving fails. Cancellation is checked after every snapshot, approval wait, and check. A fallback provider inherits the failed stage's permission but cannot broaden it.

## Run state model

```text
QUEUED -> RUNNING <-> AWAITING-APPROVAL
              |
              +----> COMPLETED                 (last gate passed)
              +----> COMPLETED-WITH-FINDINGS   (stages succeeded, gate did not pass)
              +----> FAILED     --resume--> RUNNING
              +----> CANCELLED  --resume--> RUNNING
```

Stage state:

```text
PENDING -> RUNNING -> COMPLETED
             |
             +----> FAILED
             +----> CANCELLED

PENDING ------------------> SKIPPED
```

Every stage records intended agent, actual agent, permission, timestamps, the agent's steps (at most 60, with input and output trimmed, a Claude tool result linked to its call by ID), normalized result, usage, provider session ID, whether the session was continued, verdict, checks, error, fallback reason, the latest quota reading, and a referee's ruling. Fix-round stages carry their round number. A run additionally records its isolation mode, worktree (path, working directory, repository root, base commit, state, and for a folder edited directly the snapshot repository), setup checks, approval and guidance, unresolved reason, resume count, the chosen agents, the project brief, the editor context, and, for a run that stopped and can continue by itself, `limitReset` or `offlineSince`.

## Context synchronization

The coordinator does not expose hidden model reasoning. It builds a visible checkpoint containing:

- original objective (for chat and edit, the user's latest message), any guidance given at plan approval, and the user's project brief;
- current role, permission, and stage contract, including the verdict format for review stages, what Agent mode can and cannot undo, and, outside Agent mode, when to point the user to `/agent`;
- earlier turns of the conversation, unless the agent continues a session that already holds them;
- the attachments, each with its path, extracted text or unpacked folder, and notes, and the text of small ones, with reading guidance specific to the agent;
- for stages that do the work, the file, selection, and problems the user had open when sending;
- for a revision after a refereed check, the referee's ruling;
- snapshot warnings, such as Git being unavailable;
- Git status, diff summary, and the staged and unstaged diff against `HEAD` (in a worktree, against the run's base commit);
- new untracked files, with content for small text files;
- the latest orchestrator-run checks: trusted exit codes, and fenced output;
- outputs from completed stages, except those already in a continued session, and none for a blind stage (Compare's second answer), which also gets no evidence trail;
- the stage contract again;
- output-quality requirements.

The context is bounded by `dualAgent.context.maxCharacters` with a budget per section. The objective may use up to 15% of the limit, and approval guidance and the project brief up to 5% each. The editor context (8,000 characters of selection and 20 problems at most) and a referee's ruling are capped where they are built. The two copies of the stage contract and the output requirements are always kept. Check output may take up to a fifth of the remaining space, attachments a quarter of what is left, and conversation history 15%, then the newest completed-stage artifacts (up to half), then status, diff summary, untracked files, and the diff. Trimmed text keeps its beginning and end around a truncation marker; artifacts that no longer fit are omitted with a note.

Untrusted content is enclosed in blocks whose tags carry a random boundary generated for each prompt. Untrusted text has the boundary removed and its own block tags escaped, so it cannot close a block early.

## Provider adapters

Both adapters share the same contract:

```ts
interface AgentAdapter {
  doctor(signal?: AbortSignal, workspacePath?: string): Promise<AgentHealth>;
  run(request: AgentRunRequest): Promise<StageResult>;
  preflightWarnings?(workspacePath: string): Promise<string[]>;
}
```

`AgentRunRequest` carries the full prompt, the working directory, extra untrusted directories (the workspace and the worktree), and optionally a session to continue with a shorter prompt. Before each run the adapter resolves its command with `resolveExecutable` (`src/core/executables.ts`) to an absolute path outside every untrusted directory, and builds an allowlisted environment with `buildChildEnvironment` (`src/adapters/environment.ts`).

The process runner uses argument arrays and stdin rather than interpolated shell commands, and accepts only absolute executable paths. It keeps the last 64 KB of each stream, honors a signal aborted before the process started, and on cancellation or timeout terminates the whole process tree (`src/core/processTree.ts`). It settles even if a descendant holds the pipes open. Non-zero exits become errors classified from stderr only, unless the caller asks for the exit code instead, as the check runner does.

### Codex

Codex uses `codex exec --json`, `read-only` or `workspace-write` sandbox selection, stdin prompts, `--image` for each image attachment (placed before `--sandbox`, because `--image` takes several values), `--model`, and `--config model_reasoning_effort=<level>`. Every stage adds `--skip-git-repo-check`: read-only stages cannot change a folder, and editing stages work in a worktree or a snapshotted folder. Stages with web access put the top-level `--search` flag before `exec`. An Agent-mode stage uses the `workspace-write` sandbox with `--search`, and with `dualAgent.codex.agentNetwork` on adds `--config sandbox_workspace_write.network_access=true`. After each stage, `readCodexQuota` reads the account's rate limits from the session log of the stage's thread. JSONL events supply thread IDs, messages, commands, file changes, reasoning, searches, usage, and `turn.failed`/`error` reports; the parser turns each non-message item into an activity for the chat. A `turn.failed` event fails the stage even if the process exits cleanly. The adapter warns when the workspace contains a `.codex` directory. It ignores session-resume requests. `models.ts` reads `codex debug models` for the chat's model picker, keeping listed models with their reasoning levels.

### Claude

Claude uses print mode with text input and stream-JSON output, `--setting-sources user`, and `--strict-mcp-config` (left out only when the user turned on `dualAgent.claude.userMcpServers`). Every stage passes an explicit `--tools` list. Review stages use plan mode with Read, Grep, Glob, and TodoWrite only. Agent-mode stages use the `default` permission mode with Read, Grep, Glob, TodoWrite, Edit, Write, NotebookEdit, Bash, WebSearch, and WebFetch, plus `--mcp-config` for the permission bridge and `--permission-prompt-tool mcp__dualagent__approve`; the `dualAgent.claude.allowedTools` rules are passed as `--allowedTools`. Write stages use accept-edits mode and add Edit, Write, and NotebookEdit, plus the tool each `dualAgent.claude.allowedTools` rule names, with the rules passed as `--allowedTools`. Stages with web access add WebSearch and WebFetch to the tool list and pre-approve them; editing stages add Bash with prefix rules for the verification commands (`commandRules`). Attachment folders are added with `--add-dir`, the run's model and effort with `--model` and `--effort`, and `--include-partial-messages` streams text, which the parser turns into deltas; each `tool_use` block becomes an activity (a TodoWrite call as a checklist), each `thinking` block a **Thinking** step, each `rate_limit_event` a quota reading, and the `init` event's model is recorded on the stage. `--max-turns` bounds agentic work. A `result` event with `is_error` or an `error_*` subtype fails the stage; its text, or its `errors` list, becomes the error, never stage output. To continue a session the adapter adds `--resume <id>` (IDs that could read as flags are rejected); when Claude reports "No conversation found", it runs the stage again in a new session with the full prompt.

### Check runner (`src/adapters/checkRunner.ts`)

Runs setup and verification commands as argument vectors in order, stopping at the first failure. Each executable is resolved like an agent CLI, so nothing inside the workspace or worktree (including `node_modules/.bin`) is used, and each command gets the same allowlisted environment, timeout, and process-tree termination. Output is kept as the last 16 KB of stdout and stderr combined. Cancellation stops the run; every other failure becomes a recorded result. The chat's **Run** button uses the same runner for one command, after `splitCommandLine` and a modal confirmation.

### Git (`src/core/git.ts`, `gitSnapshot.ts`, `worktree.ts`)

Every Git command resolves Git like any other executable and runs with `core.hooksPath` set to the null device, `core.fsmonitor=false`, `--no-optional-locks`, and, for diffs, `--no-ext-diff --no-textconv`. Hooks are disabled because the extension's own commands (worktree checkout, staging, ref updates) would otherwise run repository hooks, which an agent with write access could plant.

`captureGitSnapshot` checks that Git can describe the directory and turns failures (not a repository, dubious ownership, Git missing) into an explicit unavailable snapshot with a warning. The diff compares the working tree with `HEAD`; in a repository without commits it combines staged and unstaged diffs. Up to 40 untracked files are listed, with content for small regular text files whose names do not suggest secrets. Output beyond 4 MB is truncated with a warning.

`worktree.ts` creates the run's worktree: `git stash create` records uncommitted tracked changes as a commit without touching the stash or files, `git worktree add --detach` checks it out, untracked non-ignored files are copied in (except secret-named files and links), and `write-tree`, `commit-tree`, and `update-ref` record a base commit as the worktree's `HEAD`. Listing changes and building the patch stage everything in the worktree (never the user's index) and diff against the base. Applying runs `git apply --check` and then `git apply` on the user's working tree from the repository root; `git apply` normalizes line endings as checkout does. `applyWorktreeFiles` does the same for chosen files and then takes them out of the worktree's changes, and `revertWorktreeFiles` puts chosen files back as they were in the base, deleting files that did not exist there; both refuse paths outside the worktree. Removal refuses any path outside the extension's worktree directory.

For a folder edited directly, `createFolderSnapshot` makes a bare repository (`direct-<id>.git`) in the worktree directory, writes its `info/exclude` (dependency and build folders, logs, secret-looking names) and `info/attributes` (`* -text -filter -ident`), sets `core.autocrlf=false`, stages the folder, refuses more than 20,000 files, and records the base commit. The `WorktreeInfo` then has `gitDir`, and `snapshotEnvironment` supplies `GIT_DIR` and `GIT_WORK_TREE`, so snapshots, change lists, checkpoints, restores, and base-file reads run the same commands against the folder. Applying such a run is a no-op (the files are already there), undoing it restores the base tree, and removal deletes only the snapshot repository.

### Attachments (`src/core/attachments.ts`, `pdfText.ts`, `pdfWorker.ts`)

`storeAttachment` reads at most 25 MB, classifies the file by its signature (and its extension only to tell Office files from other ZIPs), and writes it under a random ID and a platform-safe name into the conversation's folder in private storage. Archives are unpacked with fflate into a sibling folder as regular files only, refusing absolute, drive, and `..` paths, and limited to 5,000 entries, 200 MB in total, 50 MB per entry, and a compression ratio of 200. Word, PowerPoint, and Excel text is read from their XML parts without an Office library. PDF text comes from pdf.js (through unpdf), bundled separately as `dist/pdfWorker.js` and run in a worker thread that is terminated after 60 seconds, so a hostile PDF cannot stall the extension host; the bundle is loaded only when a PDF is attached. `attachmentText` chooses what goes into a prompt for each agent: Codex gets extracted PDF text, while Claude reads PDFs itself. `storeFolder` copies an attached folder's regular files within the archive limits, skipping links, dependency and tooling folders, oversized files, and secret-looking names, and writes a text version beside each PDF and Office file and a listing of what it copied.

## Persistence

Conversations are stored one JSON file per conversation under `conversations/` in the same private storage, so a save rewrites only one conversation; at most 50 are kept, never pruning the current one or one whose changes wait in a worktree. Attachments live under `attachments/<conversation>` and are deleted with their conversation. Each turn of a mode that edits files records a checkpoint of the conversation's worktree or snapshotted folder as a Git tree ID. The queue and pending continuations, after a usage limit or while waiting for the network, are in `workspaceState`, and usage limits, the latest quota readings (`dualAgent.quotas`), and the composer's choices in `globalState`. The project brief is `brief.md` in workspace storage, written with mode 0600; the permission bridge's `permission-mcp.json` is in global storage. **Delete All History** removes conversations, attachments, the queue, and run history together.

Run history is stored as a versioned JSON document under VS Code's workspace-specific private storage, with worktrees and folder snapshots (`direct-<id>.git`) in a `worktrees` folder beside it. Saves are serialized, and each writes a temporary file and renames it into place, retrying briefly when Windows reports the target as locked and falling back to an in-place copy. A file that cannot be parsed is renamed to `runs.json.unreadable-<timestamp>` rather than overwritten. History is capped by configuration, except that a run whose worktree changes are still waiting to be applied or discarded is never pruned. New fields are optional, so 1.x records load unchanged and are treated as edits made directly in the workspace.

## Trust and permission zones

| Zone | Trust | Authority |
|---|---|---|
| Extension code/package | trusted local code | launches configured binaries, stores run state |
| User settings | trusted configuration | selects executables, billing, commands, limits, tool rules |
| Workspace settings | untrusted configuration | ignored for every Dual Agent setting |
| User consent and approval | authorization boundary | required for writes, commands, resume, and (by default) implementation |
| Permission decisions in Agent mode | authorization boundary | each command or edit Claude does not judge read-only runs only after the user allows it; an allowance ends with the run |
| Permission bridge (pipe, token, MCP server) | trusted local channel | carries requests and decisions; a caller without the token gets nothing |
| Project brief | trusted user content | the user's guidance in every prompt; stored privately, never read from the repository |
| Agent output and verdicts | untrusted content | cannot grant permissions; a verdict only selects a fix round, a revision, and the run's label |
| Referee ruling | untrusted content | evidence for the revision only |
| Editor context and suggested commands | untrusted content | context only; a suggested command runs only after a confirmation, without a shell |
| Provider rate-limit reports | provider data | reroute or pause stages and fill the limits meter; never change permissions |
| The CLIs' own logs | provider data that holds conversations | read only for token counts, limit messages, and rate limits; nothing else is kept |
| Chat webview | untrusted input | sends validated requests; every action still goes through consent, the single-run lock, and the same commands |
| Attachments and conversation history | untrusted content | context only; stored privately, unpacked and parsed with limits |
| Repository content, diff, check output | untrusted content | context only; cannot supply executables or hooks |
| Repository agent configuration | untrusted configuration | excluded for Claude; reported for Codex |
| CLI sandbox/permission mode | enforcement boundary | controls filesystem/tool access |
| Isolated worktree | containment boundary | agents' edits reach the workspace only through a checked apply |
| Folder snapshot | recovery point, not containment | agents edit the folder directly; file changes inside it can be undone, other effects cannot |

## Upgrade path

A later Codex app-server adapter can add interactive approvals for Codex, live rate-limit reads without the session log, thread resumption, and streamed Codex text while preserving the `AgentAdapter` and workflow contracts. See [ROADMAP.md](ROADMAP.md).
