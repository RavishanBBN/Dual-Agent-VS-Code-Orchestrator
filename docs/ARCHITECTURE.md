# Architecture

## System boundary

Dual Agent Orchestrator is a local desktop VS Code extension. The VS Code extension host owns orchestration and launches the official agent CLIs, Git, and the user's configured commands as child processes. It does not proxy raw model APIs, does not embed web content, and does not open a network port.

```text
┌──────────────────────────── VS Code ────────────────────────────┐
│                                                                │
│  Runs view · Agents view · status bar · output channel         │
│  dual-agent-run: documents · dual-agent-base: diff sources     │
│      │ commands, QuickPick, input box, modal consent           │
│      v                                                         │
│  extension.ts (composition root)                               │
│      │                                                         │
│      v                                                         │
│  WorkflowOrchestrator ── FileRunStore (private storage)        │
│      │   │   │   └── worktree.ts ──> git worktree in storage   │
│      │   │   └────── checkRunner ──> setup/verification cmds   │
│      │   └────────── gitSnapshot + context builder             │
│      ├── ClaudeCliAdapter ──> claude child process             │
│      └── CodexCliAdapter  ──> codex child process              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Components

### User interface (`src/ui`)

The interface uses only native VS Code components:

- **Runs view** (`views.ts`): a tree of recent runs, then each run's warnings, stages, check results, and changed files. Icons and descriptions show status, agent, permission, verdict, and check outcome. Context values such as `run resumable worktree` drive the inline and context-menu actions. Redraws are debounced, and a worktree's change list is read only while no agent works in it.
- **Agents view**: Claude Code, Codex, and Git health, including the resolved executable path and whether Git accepts the workspace.
- **Welcome view**: start links shown while there is no run.
- **Status bar** (`approvals.ts`): the active run's stage progress, and a highlighted prompt while a plan waits for approval.
- **Output channel**: a `LogOutputChannel` with orchestrator activity, check output, and excerpts of agent events.
- **Documents** (`documents.ts`): a read-only `dual-agent-run:` content provider for reports, stage outputs, and check logs, refreshed while a run progresses; and a `dual-agent-base:` provider that serves a file from a run's base commit as the left side of the diff editor.
- **Approvals** (`approvals.ts`): holds the orchestrator's approval request until the user decides through a notification, the status bar, the Runs view, or the Command Palette.
- **Presentation** (`presentation.ts`): pure functions for labels, icons, context values, tooltips, and dialog text, with no `vscode` import, so they are unit-tested. Text from agents and repositories is Markdown-escaped before it reaches a tooltip, and tooltips are untrusted `MarkdownString`s, so command links never activate.

### Composition root (`src/extension.ts`)

It reads user-level configuration, resolves the trusted local folder (asking in a multi-root workspace), reads the objective (typed, or the active editor's selection), and asks for consent. It constructs the adapters and the orchestrator with their dependencies, registers commands and providers, and handles review, apply, discard, export, and resume. Only one run, or one run being set up, can be active. Configuration changes made during a run apply when it ends. On activation, runs left active by a closed window are marked cancelled.

### Workflow orchestrator (`src/core/orchestrator.ts`)

The orchestrator is a sequential state machine. It:

1. validates the objective and write consent;
2. materializes an immutable workflow template into a run record, downgrading every stage to read-only when the run has no write consent;
3. for an isolated implementation run, creates the worktree and runs setup commands once;
4. records repository-configuration warnings from each adapter;
5. for implementation, refuses to continue unless Git can describe the working directory;
6. before a stage marked `requiresApproval`, waits for the user's decision when plan approval is enabled;
7. captures the Git snapshot before each stage, recording its warnings;
8. builds bounded shared context, and a shorter prompt when the agent's earlier session can be continued;
9. invokes the assigned adapter and parses a verdict from review stages;
10. attempts one eligible fallback when configured, with a fresh snapshot;
11. runs verification commands after every workspace-write stage;
12. applies the gate after a gating stage, inserting a fix round or recording unresolved findings;
13. persists and emits every transition, and marks later stages skipped after failure or cancellation.

Its dependencies (snapshot capture, worktree creation, the check runner, and the approval handler) are injected, so the whole state machine is tested without VS Code, Git, or live models. `resume` resets every unfinished stage of a failed or cancelled run and continues; `updateRun` changes a finished run, such as marking its worktree applied.

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

Every stage records intended agent, actual agent, permission, timestamps, normalized result, usage, provider session ID, whether the session was continued, verdict, checks, error, and fallback reason. Fix-round stages carry their round number. A run additionally records its isolation mode, worktree (path, working directory, repository root, base commit, state), setup checks, approval and guidance, unresolved reason, and resume count.

## Context synchronization

The coordinator does not expose hidden model reasoning. It builds a visible checkpoint containing:

- original objective, and any guidance given at plan approval;
- current role, permission, and stage contract, including the verdict format for review stages;
- snapshot warnings, such as Git being unavailable;
- Git status, diff summary, and the staged and unstaged diff against `HEAD` (in a worktree, against the run's base commit);
- new untracked files, with content for small text files;
- the latest orchestrator-run checks: trusted exit codes, and fenced output;
- outputs from completed stages, except those already in a continued session;
- the stage contract again;
- output-quality requirements.

The context is bounded by `dualAgent.context.maxCharacters` with a budget per section. The objective may use up to 15% of the limit and approval guidance up to 5%. The two copies of the stage contract and the output requirements are always kept. Check output may take up to a fifth of the remaining space, then the newest completed-stage artifacts (up to half), then status, diff summary, untracked files, and the diff. Trimmed text keeps its beginning and end around a truncation marker; artifacts that no longer fit are omitted with a note.

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

Codex uses `codex exec --json`, `read-only` or `workspace-write` sandbox selection, stdin prompts, and optional explicit model selection. JSONL events supply thread IDs, messages, tool activity, usage, and `turn.failed`/`error` reports. A `turn.failed` event fails the stage even if the process exits cleanly. The adapter warns when the workspace contains a `.codex` directory. It ignores session-resume requests.

### Claude

Claude uses print mode with text input and stream-JSON output, `--setting-sources user`, and `--strict-mcp-config`. Review stages use plan mode; write stages use accept-edits mode plus any rules from `dualAgent.claude.allowedTools`. `--max-turns` bounds agentic work. A `result` event with `is_error` or an `error_*` subtype fails the stage; its text, or its `errors` list, becomes the error, never stage output. To continue a session the adapter adds `--resume <id>` (IDs that could read as flags are rejected); when Claude reports "No conversation found", it runs the stage again in a new session with the full prompt.

### Check runner (`src/adapters/checkRunner.ts`)

Runs setup and verification commands as argument vectors in order, stopping at the first failure. Each executable is resolved like an agent CLI, so nothing inside the workspace or worktree (including `node_modules/.bin`) is used, and each command gets the same allowlisted environment, timeout, and process-tree termination. Output is kept as the last 16 KB of stdout and stderr combined. Cancellation stops the run; every other failure becomes a recorded result.

### Git (`src/core/git.ts`, `gitSnapshot.ts`, `worktree.ts`)

Every Git command resolves Git like any other executable and runs with `core.hooksPath` set to the null device, `core.fsmonitor=false`, `--no-optional-locks`, and, for diffs, `--no-ext-diff --no-textconv`. Hooks are disabled because the extension's own commands (worktree checkout, staging, ref updates) would otherwise run repository hooks, which an agent with write access could plant.

`captureGitSnapshot` checks that Git can describe the directory and turns failures (not a repository, dubious ownership, Git missing) into an explicit unavailable snapshot with a warning. The diff compares the working tree with `HEAD`; in a repository without commits it combines staged and unstaged diffs. Up to 40 untracked files are listed, with content for small regular text files whose names do not suggest secrets. Output beyond 4 MB is truncated with a warning.

`worktree.ts` creates the run's worktree: `git stash create` records uncommitted tracked changes as a commit without touching the stash or files, `git worktree add --detach` checks it out, untracked non-ignored files are copied in (except secret-named files and links), and `write-tree`, `commit-tree`, and `update-ref` record a base commit as the worktree's `HEAD`. Listing changes and building the patch stage everything in the worktree (never the user's index) and diff against the base. Applying runs `git apply --check` and then `git apply` on the user's working tree from the repository root; `git apply` normalizes line endings as checkout does. Removal refuses any path outside the extension's worktree directory.

## Persistence

Run history is stored as a versioned JSON document under VS Code's workspace-specific private storage, with worktrees in a `worktrees` folder beside it. Saves are serialized, and each writes a temporary file and renames it into place, retrying briefly when Windows reports the target as locked and falling back to an in-place copy. A file that cannot be parsed is renamed to `runs.json.unreadable-<timestamp>` rather than overwritten. History is capped by configuration, except that a run whose worktree changes are still waiting to be applied or discarded is never pruned. New fields are optional, so 1.x records load unchanged and are treated as edits made directly in the workspace.

## Trust and permission zones

| Zone | Trust | Authority |
|---|---|---|
| Extension code/package | trusted local code | launches configured binaries, stores run state |
| User settings | trusted configuration | selects executables, billing, commands, limits, tool rules |
| Workspace settings | untrusted configuration | ignored for every Dual Agent setting |
| User consent and approval | authorization boundary | required for writes, commands, resume, and (by default) implementation |
| Agent output and verdicts | untrusted content | cannot grant permissions; a verdict only selects a fix round and the run's label |
| Repository content, diff, check output | untrusted content | context only; cannot supply executables or hooks |
| Repository agent configuration | untrusted configuration | excluded for Claude; reported for Codex |
| CLI sandbox/permission mode | enforcement boundary | controls filesystem/tool access |
| Isolated worktree | containment boundary | agents' edits reach the workspace only through a checked apply |

## Upgrade path

A later Codex app-server adapter can add interactive approvals, live rate-limit reads, thread resumption, and model catalog discovery while preserving the `AgentAdapter` and workflow contracts. See [ROADMAP.md](ROADMAP.md).
