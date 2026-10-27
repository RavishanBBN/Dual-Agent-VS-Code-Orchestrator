# Architecture

## System boundary

Dual Agent Orchestrator is a local desktop VS Code extension. The VS Code extension host owns orchestration and launches official local agent CLIs as child processes. It does not proxy raw model APIs and does not expose a listening network port.

```text
┌──────────────────────── VS Code ────────────────────────┐
│                                                        │
│  Dashboard webview                                     │
│      │ messages/events                                 │
│      v                                                 │
│  Extension controller                                  │
│      │                                                 │
│      v                                                 │
│  WorkflowOrchestrator ── FileRunStore                  │
│      │       │             private workspace storage   │
│      │       └── GitSnapshot + ContextBuilder          │
│      │                                                 │
│      ├── ClaudeCliAdapter ──> claude child process     │
│      └── CodexCliAdapter  ──> codex child process      │
│                                                        │
└────────────────────────────────────────────────────────┘
```

## Components

### Dashboard

The webview provides workflow selection, objective entry, explicit write consent, provider health, stage progress, observed usage, run warnings, cancellation, and report export. It has no direct filesystem or process access. All consequential actions cross the message boundary to the extension host, where `src/ui/messages.ts` validates every message and drops malformed ones. In the other direction the host sends a reduced run view (titles, status, agents, permissions, usage, warnings) and truncated activity messages, never stage outputs or raw provider events.

### Extension controller

The composition root reads user-level configuration (workspace values are ignored, and numbers are clamped), resolves the active trusted local workspace, constructs adapters and the orchestrator, registers commands, and handles exported reports. Configuration changes made during a run are applied when it ends.

### Workflow orchestrator

The orchestrator is a sequential state machine. It:

1. validates the objective and write consent;
2. materializes an immutable workflow template into a run record, downgrading every stage to read-only when the run has no write consent;
3. records repository-configuration warnings from each adapter;
4. for implementation, refuses to continue unless Git can describe the workspace;
5. persists and emits each transition;
6. captures the current Git snapshot before each stage, recording its warnings on the run;
7. builds bounded shared context;
8. invokes the assigned adapter;
9. normalizes usage, including usage reported by failed attempts, and provider session identifiers;
10. attempts one eligible fallback when configured, with a fresh snapshot;
11. marks later stages skipped after failure or cancellation;
12. emits UI-safe progress events.

Only one run can be active in an extension host. The active marker is cleared in a `finally` block even when saving the run fails, so a storage error cannot wedge the orchestrator. A cancellation that arrives while a snapshot is being taken is checked before the agent starts. Stages execute sequentially, so there can be no concurrent writers. A fallback provider inherits the failed stage's permission but cannot broaden it.

## Run state model

```text
QUEUED -> RUNNING -> COMPLETED
              |
              +----> FAILED
              |
              +----> CANCELLED
```

Stage state:

```text
PENDING -> RUNNING -> COMPLETED
             |
             +----> FAILED
             +----> CANCELLED

PENDING ------------------> SKIPPED
```

Every stage records intended agent, actual agent, permission, timestamps, normalized result, usage, provider session ID, raw event count, error, and fallback reason.

## Context synchronization

The coordinator does not attempt to expose hidden model reasoning. It builds a visible checkpoint containing:

- original objective;
- current role and permission;
- stage-specific contract;
- snapshot warnings, such as Git being unavailable;
- Git status;
- diff summary and the staged and unstaged diff against `HEAD`;
- new untracked files, with content for small text files;
- outputs from completed stages;
- the stage contract again;
- output-quality requirements.

The context is bounded by `dualAgent.context.maxCharacters` with a budget per section rather than one cut through the whole prompt. The objective may use up to 15% of the limit. The two copies of the stage contract and the output requirements are always kept. The remaining space goes to the newest completed-stage artifacts first (up to half), then to status, diff summary, untracked files, and the diff. Trimmed text keeps its beginning and end around a truncation marker; artifacts that no longer fit are omitted with a note.

Previous outputs and repository content are enclosed in blocks whose tags carry a random boundary generated for each prompt. Untrusted text has the boundary removed and its own block tags escaped, so it cannot close a block early. This reduces, but cannot eliminate, indirect prompt-injection risk.

## Provider adapters

Both adapters share the same contract:

```ts
interface AgentAdapter {
  doctor(signal?: AbortSignal, workspacePath?: string): Promise<AgentHealth>;
  run(request: AgentRunRequest): Promise<StageResult>;
  preflightWarnings?(workspacePath: string): Promise<string[]>;
}
```

Before each run the adapter resolves its command with `resolveExecutable` (`src/core/executables.ts`) to an absolute path outside the workspace, and builds an allowlisted environment with `buildChildEnvironment` (`src/adapters/environment.ts`).

The process runner uses argument arrays and stdin rather than interpolated shell commands, and accepts only absolute executable paths. It keeps the last 64 KB of each stream, honors a signal that was aborted before the process started, and on cancellation or timeout terminates the whole process tree (`src/core/processTree.ts`). It settles even if a descendant holds the pipes open. Non-zero exits become errors classified from stderr only; adapters prefer the provider's structured error when one was reported, and attach the usage observed before the failure.

### Codex

Codex uses `codex exec --json`, `read-only` or `workspace-write` sandbox selection, stdin prompts, and optional explicit model selection. JSONL events supply thread IDs, messages, tool activity, usage, and `turn.failed`/`error` reports. A `turn.failed` event fails the stage even if the process exits cleanly. The adapter warns when the workspace contains a `.codex` directory.

### Claude

Claude uses print mode with text input and stream-JSON output, `--setting-sources user`, and `--strict-mcp-config`. Review stages use plan mode; write stages use accept-edits mode plus any rules from `dualAgent.claude.allowedTools`. `--max-turns` bounds agentic work. A `result` event with `is_error` or an `error_*` subtype fails the stage, and its text is never used as stage output.

### Git snapshot

`captureGitSnapshot` resolves Git like any other executable and runs it with filesystem monitors, external diff, textconv drivers, and optional locks disabled. It first checks that Git can describe the workspace and turns failures (not a repository, dubious ownership, Git missing) into an explicit unavailable snapshot with a warning instead of an empty diff. The diff compares the working tree with `HEAD` so staged changes are included; in a repository without commits it combines the staged and unstaged diffs. Up to 40 untracked files are listed, with content for regular text files of at most 32 KB inside the workspace whose names do not suggest secrets. Output beyond 4 MB is truncated with a warning.

## Persistence

Run history is stored as a versioned JSON document under VS Code's workspace-specific private storage location. Saves are serialized, and each writes a temporary file and renames it into place, retrying briefly when Windows reports the target as locked and falling back to an in-place copy. A file that cannot be parsed, or that uses an unknown schema version, is renamed to `runs.json.unreadable-<timestamp>` rather than overwritten, and a fresh history starts. History is capped by configuration. No state file is created inside the user's repository unless the user exports a report.

## Trust and permission zones

| Zone | Trust | Authority |
|---|---|---|
| Extension code/package | trusted local code | launches configured binaries, stores run state |
| User settings | trusted configuration | selects executables, billing, limits, tool rules |
| Workspace settings | untrusted configuration | ignored for every Dual Agent setting |
| Webview | untrusted UI boundary | sends validated user actions only |
| Agent output | untrusted content | cannot grant permissions or steer fallback |
| Repository content/diff | untrusted content | context only; cannot supply executables |
| Repository agent configuration | untrusted configuration | excluded for Claude; reported for Codex |
| CLI sandbox/permission mode | enforcement boundary | controls filesystem/tool access |
| User write consent | authorization boundary | required before implementation |

## Upgrade path

The CLI integration is intentionally portable and subscription-friendly. A later app-server adapter can add interactive approvals, live rate-limit reads, richer thread resumption, and model catalog discovery while preserving the `AgentAdapter` and workflow contracts.
