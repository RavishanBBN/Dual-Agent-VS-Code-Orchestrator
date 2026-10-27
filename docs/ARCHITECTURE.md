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

The webview provides workflow selection, objective entry, explicit write consent, provider health, stage progress, observed usage, cancellation, and report export. It has no direct filesystem or process access. All consequential actions cross the typed message boundary to the extension host.

### Extension controller

The composition root reads machine/workspace configuration, resolves the active local workspace, constructs adapters and the orchestrator, registers commands, and handles exported reports.

### Workflow orchestrator

The orchestrator is a sequential state machine. It:

1. validates the objective and write consent;
2. materializes an immutable workflow template into a run record;
3. persists each transition;
4. captures the current Git snapshot before each stage;
5. builds bounded shared context;
6. invokes the assigned adapter;
7. normalizes usage and provider session identifiers;
8. attempts one eligible fallback when configured;
9. marks later stages skipped after failure or cancellation;
10. emits UI-safe progress events.

Only one run can be active in an extension host. Stages execute sequentially, so there can be no concurrent writers. A fallback provider inherits the failed stage's permission but cannot broaden it.

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
- Git status;
- diff summary and current diff;
- outputs from completed stages;
- output-quality requirements.

The entire context is bounded by `dualAgent.context.maxCharacters`. Oversized context retains both the beginning and end with an explicit truncation marker.

Previous outputs and repository content are enclosed in labeled blocks and described as untrusted evidence. This reduces, but cannot eliminate, indirect prompt-injection risk.

## Provider adapters

Both adapters share the same contract:

```ts
interface AgentAdapter {
  doctor(): Promise<AgentHealth>;
  run(request: AgentRunRequest): Promise<StageResult>;
}
```

The process runner uses argument arrays and stdin rather than interpolated shell commands. It captures line-oriented stdout/stderr, supports cancellation and timeouts, and escalates non-zero exits into classified errors.

### Codex

Codex uses `codex exec --json`, `read-only` or `workspace-write` sandbox selection, stdin prompts, and optional explicit model selection. JSONL events supply thread IDs, messages, tool activity, and usage.

### Claude

Claude uses print mode with text input and stream-JSON output. Review stages use plan mode; write stages use accept-edits mode. `--max-turns` bounds agentic work.

## Persistence

Run history is stored as a versioned JSON document under VS Code's workspace-specific private storage location. Writes use a temporary file and replacement rename. History is capped by configuration. No state file is created inside the user's repository unless the user exports a report.

## Trust and permission zones

| Zone | Trust | Authority |
|---|---|---|
| Extension code/package | trusted local code | launches configured binaries, stores run state |
| Webview | untrusted UI boundary | sends typed user actions only |
| Agent output | untrusted content | cannot grant permissions |
| Repository content/diff | untrusted content | context only |
| CLI sandbox/permission mode | enforcement boundary | controls filesystem/tool access |
| User write consent | authorization boundary | required before implementation |

## Upgrade path

The CLI integration is intentionally portable and subscription-friendly. A later app-server adapter can add interactive approvals, live rate-limit reads, richer thread resumption, and model catalog discovery while preserving the `AgentAdapter` and workflow contracts.
