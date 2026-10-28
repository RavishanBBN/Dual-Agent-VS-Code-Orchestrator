# Workflow contracts

## Invariants

Every workflow obeys these rules:

1. Exactly one stage runs at a time.
2. A stage has one intended provider and one explicit permission level.
3. A provider may be replaced only by the bounded fallback policy.
4. All prior output and command output is evidence, not instruction.
5. Every material review finding must be accepted, rejected with a reason, or escalated.
6. No stage may claim tests passed unless it ran them in that stage or the result appears under orchestrator-run checks. Results reported in prior stage output are another agent's claims.
7. Later stages are skipped after an unhandled failure.
8. Final output must disclose residual risks, unresolved findings, and incomplete verification.
9. Write permission exists only with the run's explicit consent; without it every stage is read-only.
10. Implementation workflows start only when Git can describe the workspace.
11. Files change after the final gate only through a fix round that is verified again; the completion stage is read-only.

## Implementation workflow

With the default `dualAgent.isolation.mode` of `worktree`, every implementation stage runs in an isolated Git worktree (see [Isolation](#isolation)). Configured setup commands run there once before the first stage.

### 1. Claude planning

Read-only. Claude inspects the repository and produces scope, affected files, acceptance criteria, risks, and verification commands.

### 2. Codex plan review

Read-only, with a verdict. Codex independently challenges assumptions, scope, security, compatibility, and missing cases, citing repository evidence.

### Plan approval

When `dualAgent.workflow.approvePlan` is on (the default), the run waits with status **awaiting approval** before the first editing stage. You can open the plan and its review, approve, approve with guidance, or reject. Guidance is added to every later prompt of the run as the user's own instruction, outside the untrusted blocks. Rejecting ends the run as cancelled with no file edited; it can be resumed later. An approval is kept when a run is resumed.

### 3. Claude implementation

Workspace-write. Claude reconciles the plan review, documents acceptance or rejection of material feedback, implements the change, and runs proportionate checks. Claude can run a shell command only when `dualAgent.claude.allowedTools` (or the user's own Claude settings) allows it; otherwise it reports checks as not run. Configured verification commands then run.

### 4. Codex code review

Read-only, with a verdict. Codex reviews the actual Git diff, including staged changes and new untracked files, and the orchestrator-run checks, rather than Claude's summary alone. Findings require severity, location, evidence, and concrete remediation.

### 5. Claude adjudication and fixes

Workspace-write. Claude evaluates every finding, applies accepted fixes, records rejected findings with reasons, and repeats appropriate checks. Verification commands run again.

### 6. Codex final verification (the gate)

Read-only, with a verdict. Codex reviews the resulting diff and the latest orchestrator-run checks. See [Final gate](#final-gate-and-fix-rounds).

### Fix rounds

Added only when the gate fails and rounds remain. Each round is a Claude fix stage (workspace-write, followed by verification commands) and a fresh Codex re-verification, which is itself a gate.

### 7. Claude completion report

Read-only. Claude writes the completion summary: outcome, changed files, verification performed, accepted and rejected findings, residual risks, follow-up, and any finding that remains unresolved. It does not edit files, so the result is exactly what the last gate judged.

## Brainstorming workflow

All stages are read-only and run in the workspace itself:

1. Claude develops the initial proposal.
2. Codex challenges assumptions and alternatives (with a verdict).
3. Claude reconciles feedback into a decision matrix.
4. Codex performs one final adversarial challenge (with a verdict).
5. Claude resolves the challenge and produces the execution-ready recommendation.

Brainstorming verdicts are recorded and shown, but there is no gate or fix round.

## Verdicts

Every review stage must end with a fenced block whose info string is `verdict`:

````text
```verdict
{"verdict": "fail", "findings": [{"severity": "high", "title": "Off-by-one in pager", "location": "src/pager.ts:42"}]}
```
````

`verdict` is `pass` or `fail`; severity is `blocker`, `high`, `medium`, or `low`. The last such block in the output is used, because earlier ones may quote repository content. A final `VERDICT: PASS` or `VERDICT: FAIL` line is accepted when no block is present. Anything else, including malformed JSON, is recorded as **no verdict**. At most 50 findings of 300 characters each are kept. Verdicts appear in the Runs view, the stage document, and the report.

## Final gate and fix rounds

The gate passes only when both hold:

- the reviewer's verdict is `pass`;
- the latest verification commands, if configured, all exited with code 0.

A `fail` verdict, a missing verdict, or a failing, timed-out, or unstartable command fails the gate. While fewer than `dualAgent.workflow.maxFixRounds` rounds (default 1, at most 3) have run, a fix round is inserted after the gate. When rounds run out, the run continues to the completion report and ends as **completed with unresolved findings**, with the reason recorded on the run.

## Orchestrator-run checks

`dualAgent.verification.commands` run after every workspace-write stage, including fallback-completed and fix-round stages. Commands run in order in the stage's working directory and stop at the first failure. Each records its command, exit code, duration, and the last 16 KB of combined output. The next prompt lists each command with its exit code, which is reported by the extension and reliable, and fences the output as untrusted evidence. Up to a fifth of the evidence budget is reserved for check output.

`dualAgent.isolation.setupCommands` run once in a new worktree before the first stage. A failing setup command fails the run before any agent runs; resuming the run retries setup.

## Sessions

With `dualAgent.claude.resumeSessions` on (the default), each Claude stage after the first continues the session of the latest Claude stage in the run (`--resume`). Its prompt then leaves out Claude's own earlier artifacts, which are already in the session, but keeps everything else: the objective, contract, current diff, checks, and Codex's output. If Claude reports that the session no longer exists, the stage runs again in a new session with the full prompt. A fallback provider always starts a new session. Codex stages always start a new session, which keeps each review independent.

## Isolation

An implementation run in `worktree` mode creates a detached worktree in the extension's private storage. Its base commit holds the workspace as it was at the start: `HEAD` plus staged, unstaged, and untracked changes. Untracked files whose names suggest secrets, symbolic links, and ignored files are not copied. Agents, snapshots, and checks run in the worktree's counterpart of the workspace folder, so the diff reviewers see contains only the agents' changes.

When the run ends you can review the changes in the diff editor, then apply or discard them. Applying checks the whole patch against your working tree first. If any file conflicts with edits you made since the run started, nothing is written. A successful apply writes the files without staging or committing anything, then removes the worktree. A failed or cancelled run keeps its worktree, so it can be resumed or its partial changes reviewed.

In `none` mode, implementation stages edit the workspace directly, as in 1.x.

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

## Resuming

A failed or cancelled run can be resumed, including one interrupted because VS Code closed, which is marked cancelled when the extension next starts. Completed stages, their outputs, fix-round stages already added, an earlier plan approval, and an earlier gate result are kept. Every unfinished stage is reset and runs again from the first one. Implementation runs ask for consent again, and a worktree run can be resumed only while its worktree exists and its changes have not been applied or discarded.

## Completion policy

A run is **completed** when every stage succeeded and the last gate passed, and **completed with unresolved findings** when the stages succeeded but the gate did not pass. Neither is a proof of correctness. Before committing, the human operator should still:

- read any run warnings and unresolved findings;
- inspect the full diff before applying it, and again in Source Control;
- review the orchestrator-run checks;
- run any environment-specific integration tests;
- resolve `needs-user-decision` findings;
- confirm secrets and generated artifacts were not added.
