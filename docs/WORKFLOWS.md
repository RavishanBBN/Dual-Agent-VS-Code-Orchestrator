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
10. Workflows that edit files (Edit and Implement) start only when Git can describe the workspace.
11. Files change after the final gate only through a fix round that is verified again; the completion stage is read-only.

## Research workflow

One message in **Research** mode. Every stage is read-only and has the web, and both agents use high reasoning effort unless the user chose another.

1. **Claude researches.** Claude uses the web, the attachments, and the workspace. It prefers primary and authoritative sources and reads each one before citing it, never citing from a snippet or from memory. It cites every factual claim inline and ends with a numbered source list. It separates established, contested, and unknown points and gives its confidence. For research-gap questions, it maps what has been done, what has not, why each gap matters, and how it could be studied.
2. **Codex verifies the sources** (with a verdict). Codex opens each cited source and confirms that it exists, is attributed correctly, and supports its claim. It searches for missing work and counter-evidence, and checks the reasoning and numbers.
3. **Claude revises the research**, when the check fails with a finding of medium severity or higher. It rechecks the findings against the sources themselves, keeps only confirmed sources, adds what was missing, and adjusts its conclusions.

## Web access

Research stages always have the web. In every other mode the user can turn on the composer's **Web** toggle for a message, which gives every stage of that message the web. Claude gets its WebSearch and WebFetch tools, and Codex runs with `--search`. Web access adds no other permission: read-only stages still cannot run commands or edit files.

## Quality and context rules

- **Lean context.** Chat, Research, and Brainstorm stages see the workspace as a summary: status, the diff summary, at most 8,000 characters of diff, and untracked files by name. They read the files they need. Edit and Implement stages keep the full diff.
- **Evidence trail.** Each stage after another sees the steps the previous stage took, fenced as untrusted. Reviewers check specific claims and look at what was not examined instead of re-exploring.
- **Economical work.** Every stage is told to find code with search tools before reading, to read only the files and ranges it needs, and not to re-read what it already has.
- **Answers for the reader.** In conversations, answers lead with the result and contain no stage-report sections; a passing check is at most two sentences.
- **Minor notes.** A Chat or Research check that fails with only low-severity findings keeps the answer; the notes stay visible on the check.

## Chat workflow

One message in **Chat** mode, the default. Every stage is read-only and runs in the conversation's folder.

1. **Claude answers.** Claude answers the user's latest message in the context of the conversation, reading the files and attachments it needs.
2. **Codex checks the answer** (with a verdict). Codex verifies Claude's claims, code references, and reasoning against the repository and attachments itself. It passes an answer that is correct and complete enough to act on, and fails it only for material errors, omissions, or risks.
3. **Claude revises the answer**, only when the check did not pass. Claude weighs each finding against the evidence and gives the complete, corrected answer. This stage is not checked again, so a message costs at most three agent calls.

A missing or unparseable verdict counts as a failed check, so Claude revises. The run is **completed** either way; the chat shows whether Codex agreed or Claude revised. The answer shown to the user is the last completed stage in Claude's role.

### Quick replies

A message that is only a greeting, a thank-you, or a question about the assistant ("hi", "thanks", "who are you?", "what are your skills?") gets one read-only stage, in any mode, as long as nothing is attached:

- **One reply from the pair.** Claude answers as the pair, from a fixed description of Dual Agent's modes, features, and limits (`src/core/about.ts`).
- **No workspace.** The prompt includes neither the diff nor the workspace status.
- **No check.** Codex does not check the reply, because nothing in it depends on the code.

The detector is deliberately narrow: anything that names a task, a file, or code ("hi, can you fix the failing test?") runs the full workflow of the selected mode. Every Chat and Research prompt also says the agents speak for Dual Agent, so a question about the assistant phrased another way still gets an accurate answer.

## Edit workflow

One message in **Edit** mode: a quick change without a planning stage. It needs consent and a Git repository, and with the default isolation it works in a worktree.

1. **Claude makes the change** (workspace-write). Claude inspects the relevant code, makes the change asked for, and ends with a summary. Configured verification commands then run.
2. **Codex reviews the change** (read-only, with a verdict, a gate). Codex reviews the diff against the message and the checks.

Claude may run the configured verification commands itself while it edits (see [Orchestrator-run checks](#orchestrator-run-checks)). If the checks still fail after the edit, one **Claude fixes the failing checks** stage runs before the review, so Codex reviews working code; this repair happens at most once per run, in Implement as well. A failed review starts fix rounds exactly as in the implementation workflow. The changes stay in the worktree until you apply or discard them. Later Edit messages in the same conversation keep working in the same worktree, so a change can be built up over several messages and reviewed once.

## Conversations

Chat and Edit messages belong to a conversation, kept in private workspace storage with one file per conversation:

- **History.** Each new message's prompt includes earlier turns, oldest first, keeping the newest when the budget runs out and trimming each answer. The history is fenced as untrusted, because it contains agent output.
- **Sessions.** Claude's first stage in a message continues Claude's last session from the conversation, so it receives only what is new and the history is left out. If the session is gone, the stage starts a new session with the full prompt. Codex always starts fresh, with the history.
- **Catching up.** If messages were answered without that session, for example by Codex alone while Claude was at its usage limit, the continued session is given those messages instead, fenced as history.
- **Queue.** A message sent while another runs waits in a queue and starts when the run lock is free, in the order sent, each in its own conversation.
- **Retry and edit.** Retrying or editing a message removes it and every later message, undoes their file changes in the worktree from the checkpoint recorded before the first of them that edited files, and runs the message again. The retried run and later messages start new sessions, because earlier sessions also saw what was removed.
- **Records.** Each turn keeps its final answer, outcome, and sessions, so the conversation survives the pruning of old runs from run history.
- **Models and effort.** Each message records the models and efforts chosen in the composer; they are validated again when the run starts.

Brainstorm and Implement messages from the chat run the workflows below, with the conversation's history and attachments.

## Attachments

Attachments are copied into the conversation's private attachment folder when added, never into the repository:

| Kind | Detected by | Claude reads | Codex reads |
|---|---|---|---|
| Image (PNG, JPEG, GIF, WebP) | file signature | the file, with its Read tool | the file, attached to its prompt with `--image` |
| PDF | `%PDF-` signature | the file, with its Read tool | the text the extension extracted |
| Word, Excel, PowerPoint | ZIP signature and extension | the extracted text | the extracted text |
| ZIP archive | ZIP signature | the unpacked folder and its listing | the unpacked folder and its listing |
| Jupyter notebook | extension, valid UTF-8 | the file, with its Read tool | the file |
| Text or code | valid UTF-8 without NUL bytes | the file; small files are also included in the prompt | the same |

Other binary files are refused. Up to 40 KB of text per attachment is included in the prompt, within a quarter of the evidence budget; larger content is referenced by path. Claude gets read access to the attachment folder with `--add-dir`, through the same Read, Grep, and Glob tools as the rest of a read-only stage. An `@`-mentioned workspace file is referenced in place, not copied.

## Implementation workflow

With the default `dualAgent.isolation.mode` of `worktree`, every implementation stage runs in an isolated Git worktree (see [Isolation](#isolation)). Configured setup commands run there once before the first stage.

### 1. Claude planning

Read-only. Claude inspects the repository and produces scope, affected files, acceptance criteria, risks, and verification commands.

### 2. Codex plan review

Read-only, with a verdict. Codex independently challenges assumptions, scope, security, compatibility, and missing cases, citing repository evidence.

### Plan approval

When `dualAgent.workflow.approvePlan` is on (the default), the run waits with status **awaiting approval** before the first editing stage. You can open the plan and its review, approve, approve with guidance, or reject. Guidance is added to every later prompt of the run as the user's own instruction, outside the untrusted blocks. Rejecting ends the run as cancelled with no file edited; it can be resumed later. An approval is kept when a run is resumed.

### 3. Claude implementation

Workspace-write. Claude reconciles the plan review, documents acceptance or rejection of material feedback, implements the change, and runs proportionate checks. Claude has a shell only when a rule in `dualAgent.claude.allowedTools` names one; otherwise it reports checks as not run. Configured verification commands then run.

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

Editing stages may also run these commands themselves while they work. Claude gets a Claude Code prefix rule for each command, for example `Bash(node --test:*)`, which also allows extra arguments such as a single test file. A command with an argument that would need quoting gets no rule. Read-only stages never get these rules.

`dualAgent.isolation.setupCommands` run once in a new worktree before the first stage. A failing setup command fails the run before any agent runs; resuming the run retries setup.

## Sessions

With `dualAgent.claude.resumeSessions` on (the default), each Claude stage after the first continues the session of the latest Claude stage in the run (`--resume`). Its prompt then leaves out Claude's own earlier artifacts, which are already in the session, but keeps everything else: the objective, contract, current diff, checks, and Codex's output. If Claude reports that the session no longer exists, the stage runs again in a new session with the full prompt. A fallback provider always starts a new session. Codex stages always start a new session, which keeps each review independent.

## Isolation

An Edit or Implement run in `worktree` mode creates a detached worktree in the extension's private storage. Its base commit holds the workspace as it was at the start: `HEAD` plus staged, unstaged, and untracked changes. Untracked files whose names suggest secrets, symbolic links, and ignored files are not copied. Agents, snapshots, and checks run in the worktree's counterpart of the workspace folder, so the diff reviewers see contains only the agents' changes.

When the run ends you can review the changes in the diff editor, then apply or discard them. Applying checks the whole patch against your working tree first. If any file conflicts with edits you made since the run started, nothing is written. A successful apply writes the files without staging or committing anything, then removes the worktree. A failed or cancelled run keeps its worktree, so it can be resumed or its partial changes reviewed.

In `none` mode, editing stages work in the workspace directly, as in 1.x.

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

### Usage limits and solo mode

A quota failure also records the agent's limit and its reset time, read from the provider's message. If the message names no reset time, it is estimated as 15, 30, 60, then 120 minutes. The limit is shared by every run.

- **One agent limited.** Its stages go straight to the other agent, which is told it is the recorded fallback. The answer is taken from the stage in Claude's role whoever ran it, and review stages still give a verdict.
- **The limit resets.** The agent is tried again; its first successful call clears the record.
- **Every agent that could run the stage is limited.** That means both agents, or only the stage's own agent while fallback is off. The run fails with `limitReset`, the time the first of those limits resets. With `dualAgent.limits.autoContinue` on, it is resumed automatically a minute after that time. A run that edits files is resumed this way only with unchanged isolation, setup, and verification commands.

## Resuming

A failed or cancelled run can be resumed, including one interrupted because VS Code closed, which is marked cancelled when the extension next starts. Completed stages, their outputs, fix-round stages already added, an earlier plan approval, and an earlier gate result are kept. Every unfinished stage is reset and runs again from the first one. Runs that edit files ask for consent again, and a worktree run can be resumed only while its worktree exists and its changes have not been applied or discarded.

## Completion policy

A run is **completed** when every stage succeeded and the last gate passed, and **completed with unresolved findings** when the stages succeeded but the gate did not pass. Neither is a proof of correctness. Before committing, the human operator should still:

- read any run warnings and unresolved findings;
- inspect the full diff before applying it, and again in Source Control;
- review the orchestrator-run checks;
- run any environment-specific integration tests;
- resolve `needs-user-decision` findings;
- confirm secrets and generated artifacts were not added.
