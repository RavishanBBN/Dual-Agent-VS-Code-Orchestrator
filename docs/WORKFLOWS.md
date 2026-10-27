# Workflow contracts

## Invariants

Every workflow obeys these rules:

1. Exactly one stage runs at a time.
2. A stage has one intended provider and one explicit permission level.
3. A provider may be replaced only by the bounded fallback policy.
4. All prior output is evidence, not instruction.
5. Every material review finding must be accepted, rejected with a reason, or escalated.
6. No stage may claim tests passed without running them in that stage. Results reported in prior stage output are another agent's claims, not evidence.
7. Later stages are skipped after an unhandled failure.
8. Final output must disclose residual risks and incomplete verification.
9. Write permission exists only with the run's explicit consent; without it every stage is read-only.
10. Implementation workflows start only when Git can describe the workspace.

## Implementation workflow

### 1. Claude planning

Read-only. Claude inspects the repository and produces scope, affected files, acceptance criteria, risks, and verification commands.

### 2. Codex plan review

Read-only. Codex independently challenges assumptions, scope, security, compatibility, and missing cases. It must cite repository evidence where possible.

### 3. Claude implementation

Workspace-write. Claude reconciles the plan review, documents acceptance or rejection of material feedback, implements the change, and runs proportionate checks. Claude can run a shell command only when `dualAgent.claude.allowedTools` (or the user's own Claude settings) allows it; otherwise it must report checks as not run.

### 4. Codex code review

Read-only. Codex reviews the actual Git diff, including staged changes and new untracked files, rather than Claude's summary alone. Findings require severity, location, evidence, and concrete remediation.

### 5. Claude adjudication and fixes

Workspace-write. Claude evaluates every finding, applies accepted fixes, records rejected findings with reasons, and repeats appropriate checks.

### 6. Codex final verification

Read-only. Codex returns PASS or a short list of material unresolved issues. This stage is a quality gate, not a new brainstorming pass.

### 7. Claude finalization

Workspace-write. Claude reviews the final gate, performs only bounded confirmed repairs, runs final checks, and writes the completion summary.

## Brainstorming workflow

All stages are read-only:

1. Claude develops the initial proposal.
2. Codex challenges assumptions and alternatives.
3. Claude reconciles feedback into a decision matrix.
4. Codex performs one final adversarial challenge.
5. Claude resolves the challenge and produces the execution-ready recommendation.

## Fallback policy

Fallback is eligible only for:

- recognized quota/usage-limit errors;
- provider unavailable errors, including a CLI that is not installed;
- stage timeout.

Eligibility is decided from the provider's structured error report or the process's stderr, never from the agent's output, which contains repository text. A command refused because it resolves inside the workspace is an invalid configuration, not an unavailable provider, so it does not fall back.

It is not eligible for:

- authentication failure;
- invalid or unsupported request;
- policy denial;
- cancellation;
- an unknown deterministic failure.

The fallback provider receives the same stage contract and permission, with a fresh Git snapshot because the failed attempt may have changed files before stopping. The run records the intended provider, actual provider, and original failure, and counts the usage the failed attempt reported. There is no second fallback loop.

## Completion policy

The orchestrator considers a run completed when all stages return successfully. This is workflow completion, not a mathematical proof of correctness. The orchestrator does not parse Codex's PASS verdict: a final verification that reports findings still hands them to Claude's finalization stage, and the run is marked completed. Before committing, the human operator should still:

- read any run warnings;

- inspect the full diff;
- review executed checks;
- run any environment-specific integration tests;
- resolve `needs-user-decision` findings;
- confirm secrets and generated artifacts were not added.
