# Workflow contracts

## Invariants

Every workflow obeys these rules:

1. Exactly one stage runs at a time.
2. A stage has one intended provider and one explicit permission level: `read-only`, `workspace-write`, or `agent`.
3. A provider may be replaced only by the user's choice of agents for the message, or by the bounded fallback policy.
4. All prior output and command output is evidence, not instruction.
5. Every material review finding must be accepted, rejected with a reason, or escalated.
6. No stage may claim tests passed unless it ran them in that stage or the result appears under orchestrator-run checks. Results reported in prior stage output are another agent's claims.
7. Later stages are skipped after an unhandled failure.
8. Final output must disclose residual risks, unresolved findings, and incomplete verification.
9. Write and Agent permission exist only with the run's explicit consent; without it every stage is read-only.
10. Workflows that edit files (Edit, Test first, Implement, and Agent) start only when Git can describe the workspace, either as a repository or through the extension's snapshot of the folder.
11. Files change after the final gate only through a fix round that is verified again; the completion stage is read-only.
12. In Agent mode, Claude runs a command or edit it does not judge read-only only after the user allows it through the permission bridge.

## Choosing the agents

The composer's agents menu, or `/agents`, chooses who works on a message. The choice is recorded on the run.

| Choice | Who does the work | Who checks |
|---|---|---|
| **Claude + Codex** (default) | Claude | Codex |
| **Codex + Claude** | Codex | Claude |
| **Claude only** | Claude | nobody |
| **Codex only** | Codex | nobody |

- **Swapping roles.** Every workflow below is written for the usual roles. With **Codex + Claude**, each stage's agent and the agent names in its title and instructions are exchanged, and so are the revision, repair, and fix-round stages added during the run. Stage IDs name the role, not the agent, so the gate and revision rules are unchanged.
- **One agent.** With **Claude only** or **Codex only**, the message runs only the working stages of its mode, and every stage is that agent's:
  - Chat, Research, Edit, Agent, and Compare: the first answering or editing stage alone.
  - Test first: writing the failing tests, then making them pass.
  - Brainstorm: one stage that proposes, challenges its own proposal, and recommends.
  - Implement: plan, implementation (after plan approval, when it is on), and the completion report.
- **Outcome.** A message answered by one agent is labelled "… alone, without a check". Labels name the agents that actually ran, such as "Claude agreed" when Claude checked.
- **Usage limits.** A single agent's stages never go to the other agent. At its usage limit the message pauses and continues after the reset, as in [Usage limits and solo mode](#usage-limits-and-solo-mode), so only that agent's limits are used.

## Research workflow

One message in **Research** mode. Every stage is read-only and has the web, and both agents use high reasoning effort unless the user chose another.

1. **Claude researches.** Claude uses the web, the attachments, and the workspace. It prefers primary and authoritative sources and reads each one before citing it, never citing from a snippet or from memory. It cites every factual claim inline and ends with a numbered source list. It separates established, contested, and unknown points and gives its confidence. For research-gap questions, it maps what has been done, what has not, why each gap matters, and how it could be studied.
   - **Gap matrix.** For a question about research gaps or a body of literature, it adds a table with one row per key work and columns for problem, method, data, main result, and limitation, followed by the open gaps.
   - **Sources block.** After the source list it adds a fenced `sources` block: a JSON array of the cited works with title, authors, year, venue, DOI, and URL. The chat hides the block and shows a sources card with **BibTeX** and **RIS** export (`src/core/citations.ts`).
2. **Codex verifies the sources** (with a verdict). Codex opens each cited source and confirms that it exists, is attributed correctly, and supports its claim. It searches for missing work and counter-evidence, and checks the reasoning and numbers.
   - **Claim table.** It starts with a table of every material claim, its source, and a verdict of supported, partly supported, or unsupported.
   - **DOIs and retractions.** It confirms each DOI resolves to the cited work, and checks whether the work was retracted or corrected. A retracted source is a high-severity finding.
3. **Claude revises the research**, when the check fails with a finding of medium severity or higher. It rechecks the findings against the sources themselves, keeps only confirmed sources, adds what was missing, and adjusts its conclusions. It ends with a new `sources` block.

Every Markdown table in an answer has a **CSV** button. Cells that a spreadsheet would run as formulas are kept as text (see [SECURITY.md](SECURITY.md#exported-tables-and-sources)).

## Web access

Research stages always have the web. In every other mode the user can turn on the composer's **Web** toggle for a message, which gives every stage of that message the web. Claude gets its WebSearch and WebFetch tools, and Codex runs with `--search`. Web access adds no other permission: read-only stages still cannot run commands or edit files.

The lead agent in Agent mode also has the web, as it would in a terminal session: Claude's toolset includes WebSearch and WebFetch, and Codex runs with `--search`.

## Quality and context rules

- **Lean context.** Chat, Research, and Brainstorm stages see the workspace as a summary: status, the diff summary, at most 8,000 characters of diff, and untracked files by name. They read the files they need. Edit and Implement stages keep the full diff.
- **Evidence trail.** Each stage after another sees the steps the previous stage took, fenced as untrusted. Reviewers check specific claims and look at what was not examined instead of re-exploring.
- **Economical work.** Every stage is told to find code with search tools before reading, to read only the files and ranges it needs, and not to re-read what it already has.
- **Answers for the reader.** In conversations, answers lead with the result and contain no stage-report sections; a passing check is at most two sentences.
- **Minor notes.** A Chat or Research check that fails with only low-severity findings keeps the answer; the notes stay visible on the check.
- **Asking for Agent mode.** Outside Agent mode, every stage that does the work is told to say in one line when a request needs something its mode cannot do, such as installing software or running programs, and that the user can send it again with `/agent`. It still does the part it can.
- **Project brief.** The user's brief (`brief.md` in the extension's private workspace storage) is given to every stage as the user's own guidance, outside the untrusted blocks, up to 4,000 characters. Quick replies leave it out.
- **Editor context.** The file, selected lines, and problems the user had open when sending go to the stages that do the work, fenced as untrusted, with at most 8,000 characters of selection and 20 problems. Review stages and quick replies leave them out.

## Chat workflow

One message in **Chat** mode, the default. Every stage is read-only and runs in the conversation's folder.

1. **Claude answers.** Claude answers the user's latest message in the context of the conversation, reading the files and attachments it needs.
2. **Codex checks the answer** (with a verdict). Codex verifies Claude's claims, code references, and reasoning against the repository and attachments itself. It passes an answer that is correct and complete enough to act on, and fails it only for material errors, omissions, or risks.
3. **Claude revises the answer**, only when the check did not pass. Claude weighs each finding against the evidence and gives the complete, corrected answer. This stage is not checked again, so a message costs at most three agent calls.

A missing or unparseable verdict counts as a failed check, so Claude revises. The run is **completed** either way; the chat shows whether Codex agreed or Claude revised. The answer shown to the user is the last completed stage that does the work rather than checks it, whoever ran it.

When a check led to a revision, the message offers **See what changed**: a word diff of the first answer against the revision (`src/ui/chat/textDiff.ts`). **Keep the revision** closes it, **Prefer the first answer** makes the first answer the one later messages build on, and **Check again** sends a follow-up Chat message asking for one more check of the revision.

### Referee

With `dualAgent.gemini.enabled` on, a check that fails and adds a revision first goes to Gemini CLI. This applies to Chat, Research, and Agent messages:

1. **Gemini rules on the findings.** It gets the answer and the check, fenced as untrusted, and rules on each finding (upheld, partly upheld, or rejected) with brief evidence from the files or sources, which it may read. It runs in its read-only plan mode, with JSON output, in the run's working folder.
2. **The revision weighs the ruling.** The ruling is shown in the check stage and given to the revising stage as evidence, fenced as untrusted, never as an instruction.

The ruling decides nothing by itself: the verdict, the revision, and permissions are unchanged. If Gemini fails or times out (after `dualAgent.timeoutMinutes`), the run records a warning and the revision proceeds without it.

### Quick replies

A message that is only a greeting, a thank-you, or a question about the assistant ("hi", "thanks", "who are you?", "what are your skills?") gets one read-only stage, in any mode, as long as nothing is attached:

- **One reply from the pair.** The lead agent answers as the pair, from a fixed description of Dual Agent's modes, features, and limits (`src/core/about.ts`).
- **No workspace.** The prompt includes neither the diff nor the workspace status.
- **No check.** Codex does not check the reply, because nothing in it depends on the code.

The detector is deliberately narrow: anything that names a task, a file, or code ("hi, can you fix the failing test?") runs the full workflow of the selected mode. Every Chat and Research prompt also says the agents speak for Dual Agent, so a question about the assistant phrased another way still gets an accurate answer.

## Edit workflow

One message in **Edit** mode: a quick change without a planning stage. It needs consent. With the default isolation it works in a worktree, or, in a folder without Git, in the folder itself after a snapshot (see [Folders without Git](#folders-without-git)).

1. **Claude makes the change** (workspace-write). Claude inspects the relevant code, makes the change asked for, and ends with a summary. Configured verification commands then run.
2. **Codex reviews the change** (read-only, with a verdict, a gate). Codex reviews the diff against the message and the checks.

Claude may run the configured verification commands itself while it edits (see [Orchestrator-run checks](#orchestrator-run-checks)). If the checks still fail after the edit, one **Claude fixes the failing checks** stage runs before the review, so Codex reviews working code; this repair happens at most once per run, in Implement as well. A failed review starts fix rounds exactly as in the implementation workflow. The changes stay in the worktree until you apply or discard them. Later Edit messages in the same conversation keep working in the same worktree, so a change can be built up over several messages and reviewed once.

## Agent workflow

One message in **Agent** mode: the lead agent works in the folder itself, on the user's machine, as Claude Code or Codex do in a terminal. It needs consent, and the consent card says what cannot be undone.

1. **Claude works on it** (permission `agent`). Claude inspects the environment, runs commands, installs what is needed, edits files, and confirms the result itself, for example by running a tool again after installing it. It ends with what it did, the commands it ran and their results, and anything left for the user.
2. **Codex checks the result** (read-only, with a verdict). The evidence trail lists every command Claude ran and what it returned, and the diff shows file changes since the snapshot. Codex verifies the outcome where it can without changing anything, such as with a version check, and looks for anything unsafe or half done.
3. **Claude finishes the task** (permission `agent`), only when the check did not pass. Commands and edits still ask the user first.

How each agent gets its authority:

- **Claude asks.** Claude Code runs with its full toolset (Read, Grep, Glob, TodoWrite, Edit, Write, NotebookEdit, Bash, WebSearch, WebFetch) in its `default` permission mode. It runs what it judges read-only, and what the user's own allow rules match, by itself; everything else goes to the permission bridge, which asks the user (see [SECURITY.md](SECURITY.md#agent-mode-and-the-permission-bridge)).
- **The user decides.** The chat shows a card with what the agent wants to do, the exact command or edit, and warnings for deletions, administrator rights, scripts piped from the internet, system changes, and paths outside the folder. **Allow** runs this call. **Allow *tool* for this message** runs this call and every later call of that tool until the message finishes. **Deny** tells Claude to find another way or ask. While the chat is hidden, a modal dialog asks instead. **Stop** denies a pending request.
- **Codex cannot ask.** When Codex does the work (with **Codex + Claude**, or standing in for Claude), it runs in its `workspace-write` sandbox, which can write only in the folder. With `dualAgent.codex.agentNetwork` on (the default), the sandbox can reach the network, so Codex can install packages for the folder.
- **Snapshot first.** Before the first stage the extension snapshots the folder, as for [folders without Git](#folders-without-git), even when the folder is a Git repository. File changes can be kept or undone from the changes card. Installed software and other effects outside the folder cannot be undone.
- **Checks.** Configured verification commands run after each Agent stage, as after an editing stage.

If the permission bridge could not start when the extension activated, Claude cannot work in Agent mode: its stage fails with "Agent mode needs the permission bridge, which is not running."

## Compare workflow

One read-only message in **Compare** mode: a second opinion without anchoring.

1. **Claude answers independently.** As in Chat.
2. **Codex answers independently.** Codex answers the same message with the conversation history, but its prompt contains neither Claude's answer nor Claude's steps, so the two answers stay independent.
3. **Claude merges the two answers.** Claude compares them claim by claim, checks the files or sources itself where they disagree, and gives one answer followed by a short "Where we differed" list naming which answer was right on each point and why.

Compare has no verdict, so the outcome reads "Claude merged two independent answers".

## Test-first workflow

One message in **Test first** mode. It needs consent, and works in a worktree or a snapshotted folder like Edit.

1. **Codex writes failing tests** (workspace-write). Codex reads the code and its tests, then writes tests for the requested behavior that fail now for the right reason and will pass once it exists. It changes only test files. Verification commands run, and their failure is expected, so no repair stage follows.
2. **Claude makes the tests pass** (workspace-write). Claude implements the behavior without weakening, skipping, or deleting a test; if a test is genuinely wrong, it fixes only that test and says why. Verification commands run, and a repair stage follows if they still fail.
3. **Codex reviews the tests and the code** (read-only, with a verdict, a gate). Codex confirms the tests capture the request and were not weakened, and that the implementation is correct and scoped. A failed gate starts fix rounds as in Edit.

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

A slash command at the start of a message (`/chat`, `/research`, `/agent`, `/edit`, `/test`, `/compare`, `/brainstorm`, `/implement`) sends that one message in the named mode, without changing the composer's mode.

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

With the default `dualAgent.isolation.mode` of `worktree`, every implementation stage runs in an isolated Git worktree, or in a snapshotted folder when the workspace has no Git (see [Isolation](#isolation)). Configured setup commands run there once before the first stage.

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

`dualAgent.verification.commands` run after every stage that can change files (workspace-write or Agent), including fallback-completed and fix-round stages. Commands run in order in the stage's working directory and stop at the first failure. Each records its command, exit code, duration, and the last 16 KB of combined output. The next prompt lists each command with its exit code, which is reported by the extension and reliable, and fences the output as untrusted evidence. Up to a fifth of the evidence budget is reserved for check output.

Editing stages may also run these commands themselves while they work. Claude gets a Claude Code prefix rule for each command, for example `Bash(node --test:*)`, which also allows extra arguments such as a single test file. A command with an argument that would need quoting gets no rule. Read-only stages never get these rules.

`dualAgent.isolation.setupCommands` run once in a new worktree, or a newly snapshotted folder, before the first stage. A failing setup command fails the run before any agent runs; resuming the run retries setup.

## Sessions

With `dualAgent.claude.resumeSessions` on (the default), each Claude stage after the first continues the session of the latest Claude stage in the run (`--resume`). Its prompt then leaves out Claude's own earlier artifacts, which are already in the session, but keeps everything else: the objective, contract, current diff, checks, and Codex's output. If Claude reports that the session no longer exists, the stage runs again in a new session with the full prompt. A fallback provider always starts a new session. Codex stages always start a new session, which keeps each review independent.

## Isolation

An Edit, Test first, or Implement run in `worktree` mode creates a detached worktree in the extension's private storage. Its base commit holds the workspace as it was at the start: `HEAD` plus staged, unstaged, and untracked changes. Untracked files whose names suggest secrets, symbolic links, and ignored files are not copied. Agents, snapshots, and checks run in the worktree's counterpart of the workspace folder, so the diff reviewers see contains only the agents' changes.

When the run ends you can review the changes in the diff editor, then apply or discard them. Applying checks the whole patch against your working tree first. If any file conflicts with edits you made since the run started, nothing is written. A successful apply writes the files without staging or committing anything, then removes the worktree. A failed or cancelled run keeps its worktree, so it can be resumed or its partial changes reviewed.

- **One file at a time.** **Apply** on a file in the changes card applies only that file, after the same `git apply --check`, and takes it out of the worktree's changes so a later full apply does not repeat it. **Discard** on a file puts only that file back in the worktree.
- **Part of a file.** Open the file from the changes card and undo single changes with the arrows in the diff editor's margin, then apply.
- **Commit message.** After a full apply, Source Control's message box gets a suggested commit message (the request, the final summary's first line, and the outcome), unless it already has text.

In `none` mode, editing stages work in the workspace directly, as in 1.x, and still need a Git repository.

### Folders without Git

When the workspace is not a Git repository, or has no commit, an Edit, Test first, or Implement run in `worktree` mode cannot have an isolated copy. It edits the folder itself after a snapshot instead. Agent mode always works this way, Git or not.

A conversation's changes waiting for review are continued only by a mode that works the same way. An Agent message does not start while an earlier Edit's changes wait in an isolated copy, and an Edit, Test first, or Implement message does not start while Agent mode's direct changes wait; the chat asks whether to apply or discard them, or keep or undo them, and sends the message once that is done, or not at all if you cancel. In a folder without Git every mode edits directly, so they all continue the same snapshot.

- **The snapshot.** `createFolderSnapshot` creates a bare repository, `direct-<id>.git`, in the extension's worktree storage, and records the folder's files in it as the base commit. Git reaches it through `GIT_DIR` and `GIT_WORK_TREE`, and nothing is written to the folder. Line-ending conversion and clean, smudge, and ident filters are turned off, so the snapshot holds the exact bytes.
- **What it leaves out.** Dependency and build folders (`node_modules`, `.venv`, `venv`, `__pycache__`, `.git`, `dist`, `build`, `out`, `.next`, `target`, `coverage`), logs, `.DS_Store`, files whose names suggest secrets (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`), and whatever the folder's own `.gitignore` files exclude.
- **Limits.** A folder with more than 20,000 files outside those exclusions is refused, with a suggestion to open a Git repository or a smaller folder. A subfolder that is a Git repository of its own is recorded as a link, not as its files, and the run warns that Undo cannot put back changes inside it.
- **During the run.** Snapshots, diffs, change lists, and checkpoints use the snapshot repository, so reviewers see the changes since the snapshot, and the changes card and retry work as in a worktree. Setup and verification commands run in the folder itself.
- **Keep.** **Keep…** leaves the files as they are and deletes the snapshot. After that the changes cannot be undone from Dual Agent.
- **Undo.** **Undo all…** restores the snapshot: changed and deleted files are put back, and files the agents created are deleted. The excluded folders are left as they are, so a package installed into `node_modules` stays. **Undo** on one file restores only that file, or deletes it if the agents created it. Retrying or editing an earlier message restores the folder to that message's checkpoint.

## Fallback policy

Fallback is eligible only for:

- recognized quota/usage-limit errors;
- provider unavailable errors, including a CLI that is not installed;
- connection errors while the machine is online, which mean one provider's outage (see [Network outages](#network-outages));
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

### Handing over before a limit is reached

The CLIs also report how much of each usage window is used:

- **Claude** emits `rate_limit_event` events in its stream, with each window's utilization and reset time.
- **Codex** writes its rate limits to its session log rather than to `exec --json`. After each Codex stage, `readCodexQuota` opens the log of that stage's thread (`sessions/<year>/<month>/<day>/…<thread id>.jsonl` under `CODEX_HOME`, today's or yesterday's folder), and keeps only its `rate_limits` fields.

- **Every session on the machine.** With `dualAgent.usage.readLocalLogs` on (the default), the extension also reads the CLIs' own logs for use outside Dual Agent, such as a terminal or another editor: Codex's rate limits from any recent session, and a usage-limit message Claude reported there (see [SECURITY.md](SECURITY.md#reading-the-clis-logs)).

Each reading updates the usage panel's limits meter. `AgentLimits.observe` applies one rule to readings from runs and from the logs alike: when a reading says a limit is reached, or a window is at least 98% used, the agent is recorded as limited until that window resets, so the next stage goes to the other agent before a call fails. The call that reported it still completes, and its success does not clear the record.

### Network outages

A connection error is classified as `network` from the provider's error report or stderr, for example Claude Code's "API Error: Connection error.", Codex's "stream disconnected … error sending request", or `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, "fetch failed", and "dns error". The orchestrator then asks whether the machine is online, by opening a TCP connection to `api.anthropic.com`, `chatgpt.com`, or `api.openai.com` on port 443 and closing it, sending nothing. Behind a proxy set in `HTTPS_PROXY`, `ALL_PROXY`, or `HTTP_PROXY`, it probes the proxy instead.

- **Online.** The error is one provider's outage, and the other agent covers the stage as in any fallback.
- **Offline.** No agent could run, so the run stops at once, without trying the other agent. It is marked failed and resumable, with `offlineSince`. With `dualAgent.limits.autoContinue` on, it is checked every 15 seconds and continues from the stage where it stopped once the connection is back; queued messages wait behind it, and a pending continuation survives a restart. A run that edits files continues by itself only with unchanged setup and verification commands, as after a usage limit.

## Resuming

A failed or cancelled run can be resumed, including one interrupted because VS Code closed, which is marked cancelled when the extension next starts. The run records why it stopped: "Stopped by you." or "VS Code closed while the message was running." Completed stages, their outputs, fix-round stages already added, an earlier plan approval, and an earlier gate result are kept. Every unfinished stage is reset and runs again from the first one. Runs that edit files ask for consent again, and a worktree or snapshot run can be resumed only while its worktree or snapshot exists and its changes have not been applied, kept, discarded, or undone.

## Completion policy

A run is **completed** when every stage succeeded and the last gate passed, and **completed with unresolved findings** when the stages succeeded but the gate did not pass. Neither is a proof of correctness. Before committing, the human operator should still:

- read any run warnings and unresolved findings;
- inspect the full diff before applying it, and again in Source Control;
- review the orchestrator-run checks;
- run any environment-specific integration tests;
- resolve `needs-user-decision` findings;
- confirm secrets and generated artifacts were not added.
