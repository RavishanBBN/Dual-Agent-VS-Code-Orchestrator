# Project status

This document is the maintained implementation ledger for Dual Agent: Claude + Codex. Update it whenever behavior, verification, risk, or release readiness changes.

## Snapshot

| Field | Value |
|---|---|
| Release | 2.4.0 (Agent mode with permission prompts, folders without Git, agents selector, Compare and Test first, editor integration, limits meter and machine-wide usage, offline pause, Gemini referee, slash commands, Marketplace name "Dual Agent: Claude + Codex"), after 2.3.1 (quick replies about the assistant) and 2.3.0 (Marketplace-ready: solo mode at usage limits, automatic continuation, message queue, retry and edit, secret masking) |
| Last updated | 2026-10-28 |
| Product scope | Desktop VS Code extension, trusted local workspaces only |
| Interface | Chat webview (side bar or editor tab); native Runs and Agents views, commands, status bar, output channel, read-only documents, diff editors; editor quick fixes, context menu, and findings as problems |
| Primary workflow | Chat: Claude answers, Codex checks the answer, Claude revises when the check fails; the user can swap the roles or choose one agent alone, and one agent carries on alone while the other is at its usage limit |
| Other workflows | Research (web research, Codex source verification, revision); Agent (commands, installs, and edits in the folder with the user's approval, Codex check); Edit (worktree or snapshotted-folder edit, Codex review gate, fix rounds); Test first; Compare; Claude-led implementation with plan approval and a verified final gate; reciprocal brainstorming |
| Runtime integration | Local Claude Code and Codex CLIs, and optionally Gemini CLI as referee, resolved to absolute paths outside the workspace and worktree; a bundled MCP permission server for Agent mode |
| Authentication | Existing CLI sign-ins; credentials are not read by the extension |
| Agent environment | Allowlisted; billing variables removed in subscription mode |
| State | Private VS Code workspace storage: conversations, attachments, run history, worktrees, folder snapshots, project brief; global storage: usage limits, quota readings, permission bridge configuration |
| Network service | None; the permission bridge uses a local named pipe or Unix socket, the connectivity check only opens and closes a TCP connection, the chat page loads nothing from the network, and there is no telemetry |
| Distribution | Visual Studio Marketplace and Open VSX as `NileshRavishan.dual-agent-orchestrator`, published by tag through OpenID Connect trusted publishing (first Marketplace version uploaded by hand until the Marketplace accepts it) |

## Delivery progress

| Area | Status | Evidence |
|---|---|---|
| Project structure and build | Complete | TypeScript, esbuild (extension, PDF worker, and webview bundles), strict configuration |
| Chat panel | Complete | Webview view and editor tab (title-bar button, named after the conversation), nonce CSP, validated protocol, streamed text, a timeline of agent steps with IN/OUT kept after the run (TodoWrite checklists, Thinking steps), verdict badges, consent, approval, permission, changes, comparison, sources, and check cards, history with search and Markdown export, starter prompts, slash commands, project brief, Run and Terminal buttons, CSV export of tables, chime after long messages, folder attachments; smoke test in VS Code 1.143.1 |
| Research workflow and web access | Complete | Claude WebSearch and WebFetch, Codex `--search`, source verification, high effort by default, Web toggle per message |
| Quality and token controls | Complete | Lean context, evidence trail, economical-work guidance, answers for the reader, minor-notes rule, verification commands available to editing stages, one repair before review |
| Chat and Edit workflows | Complete | Chat check with a single revision and a disagreement view; Edit with a gate and fix rounds in a conversation-scoped worktree or snapshotted folder, per-file apply and discard |
| Agent mode and permission bridge | Complete | Claude with its full toolset in the folder, `--permission-prompt-tool` through a bundled MCP server, private pipe or socket with a token, chat card and modal dialog with warnings, per-message tool allowance; Codex in its workspace-write sandbox with optional network; snapshot first; consent text on what cannot be undone |
| Compare and Test first workflows | Complete | Blind second answer and merge; Codex-written failing tests, implementation, gated review |
| Agents selection | Complete | Claude + Codex, Codex + Claude, Claude only, Codex only; roles swapped by `arrangeStage`, single-agent workflows; composer menu and `/agents`; smoke test |
| Folders without Git | Complete | Bare snapshot repository in private storage with exclusions and a 20,000-file limit, direct edits, keep, undo, per-file undo, retry restores, nested-repository warning |
| Editor integration | Complete | Editor context chip, Fix and Explain quick fixes, Ask Dual Agent About This, findings as problems, outcome status bar item, suggested commit message |
| Gemini referee | Complete | Optional, plan mode, JSON output, ruling per finding before the revision, Agents view row |
| Subscription limits meter | Complete | Claude `rate_limit_event`, Codex session log of the run's own thread and, with the machine-wide reader, any session; usage panel meter, header warning at 90%, handover at 98% through `AgentLimits.observe` |
| Machine-wide usage | Complete | `LocalUsageScanner` over the CLIs' own logs: incremental, usage-marker lines only, token counts per day, Claude limit messages, Codex rate limits; "On this machine" in the usage panel; `dualAgent.usage.readLocalLogs` |
| Sign-in from VS Code | Complete | Each CLI's own sign-in in a terminal with the agents' environment (Claude subscription, Console, or SSO; Codex ChatGPT, device code, or API key on standard input; Gemini Google account), status from `claude auth status` and `codex login status`, Sign In and Sign Out on Agents rows, chat banner and Sign in button on failed turns; smoke test |
| Limits refresh | Complete | One tiny call per agent on request (Claude on Haiku, Codex at low effort); reset windows shown empty |
| Network outages | Complete | `network` failure kind, TCP connectivity check (provider hosts or proxy), offline pause with automatic continuation every 15 seconds, fallback when only one provider is down |
| Conversations | Complete | One file per conversation, budgeted history, Claude sessions across messages, answers kept after run pruning |
| Attachments | Complete | Images, PDFs, ZIP, Word, Excel, PowerPoint, notebooks, text; private storage, content detection, safe unpacking, PDF worker with timeout |
| Models and effort | Complete | Composer pickers, Codex catalog from `codex debug models`, default settings, validation at every entry point |
| Native VS Code views | Complete | Runs and Agents views, welcome view, menus, status bar, output channel, documents, diff review |
| Claude CLI adapter | Complete | Stream-JSON parser with deltas, tool activity, thinking, and rate-limit events, error results, user-only settings, no MCP unless the user opts in, explicit tool allowlist, Agent-mode arguments with the permission bridge, `--add-dir`, `--model`, `--effort`, `--resume` with fresh-session retry |
| Codex CLI adapter | Complete | JSONL parser with activity, `turn.failed` handling, sandbox modes including Agent mode with optional network, `--image`, `--model`, reasoning effort, `--skip-git-repo-check` for every stage, rate limits from the session log, `.codex` warning |
| Executable resolution | Complete | Absolute paths only; workspace, worktree, and relative `PATH` entries excluded |
| Process lifecycle | Complete | Bounded capture, pre-aborted signals, process-tree termination, no indefinite waits |
| Reciprocal implementation workflow | Complete | Seven stages plus bounded fix rounds; requires a working Git repository |
| Reciprocal brainstorming workflow | Complete | Five read-only stages with recorded verdicts |
| Verdict parsing and final gate | Complete | Fenced JSON verdict; gate needs a pass verdict and passing checks; `completed-with-findings` |
| Extension-run checks | Complete | Setup and verification commands as argument vectors, allowlisted environment, consent |
| Worktree isolation | Complete | Base includes uncommitted and untracked work; review, conflict-checked apply, discard, per-file apply and discard; hooks disabled; shared by a conversation's edits; folder snapshot when there is no Git |
| Plan approval | Complete | Chat card, notification, status bar, view, and palette; guidance carried into later prompts |
| Session continuity and resume | Complete | Claude session reuse within runs and across messages; resume from first unfinished stage; interrupted runs recovered |
| Shared checkpoint context | Complete | Per-section budgets including checks, attachments, and history; random block boundaries; restated contract |
| Durable state | Complete | Serialized saves, locked-file retry, unreadable files set aside, unapplied work never pruned |
| Usage observation | Complete | Per-provider totals including failed attempts, with input counted the same way for both agents; shown per stage, per message, and for the conversation, today, 7 days, and all runs |
| Bounded provider fallback | Complete | Classified from provider errors and stderr only; fresh snapshot |
| Usage limits and solo mode | Complete | Reset times parsed from provider messages, including dated weekly resets, estimates with backoff, limited agent skipped until reset, handover before a window is used up, limits from the CLIs' logs, catch-up for continued sessions, answers by role |
| Automatic continuation | Complete | Paused runs continue after the reset or once the network is back, survive restarts, retry while busy, and edit runs continue only with unchanged commands |
| Message queue | Complete | Persisted, bounded, removable items; drained when the lock is free and the agents can work |
| Retry and edit | Complete | Later turns removed, worktree restored from a Git-tree checkpoint or discarded, fresh sessions, confirmation when rewinding past later messages |
| Secret masking | Complete | Credentials masked in prompts, the output log, and exported reports |
| Marketplace readiness | Complete | Publisher, icon, screenshots from the real bundle, walkthrough, categories, repository links, clean `vsce package`, Delete All History command |
| Supply chain and release | Complete | SHA-pinned actions, `npm audit` and `npm audit signatures`, CodeQL, Dependabot with cooldown, tag release with checksums, build provenance, and OIDC publishing |
| Report export | Complete | Markdown report with verdicts, checks, isolation, approval, attachments, warnings |
| Unit and integration tests | Complete | Fake-CLI adapter and check tests, real-Git snapshot, worktree, checkpoint, and folder-snapshot tests, attachment tests with real pdf.js, chat protocol, Markdown, Trusted Types, and transcript tests, limit parsing, solo mode, continuation, and masking tests, permission bridge, quota, connectivity, offline-continuation, machine-wide usage, citation, command-splitting, slash-command, and answer-diff tests |
| CI and packaging | Complete | Windows/Linux checks, supply-chain job, CodeQL, VSIX artifact, and tag-triggered release workflow |
| Documentation | Complete | Marketplace README, walkthrough, architecture, workflow, security, operations, development and release, roadmap, ADRs 0001 to 0010, issue and pull-request templates |

## Verification record

Results of the 2.4.0 verification on Windows 11 with Node.js 22.13.0:

| Check | Result | Notes |
|---|---|---|
| Dependency audit | Passed | `npm audit`: 0 vulnerabilities; `npm audit signatures`: 262 packages with verified registry signatures, 65 with verified attestations |
| TypeScript and ESLint | Passed | Strict `tsc --noEmit`; type-aware ESLint with zero findings |
| Unit and integration tests | Passed | 297 passed, 1 skipped (POSIX-only symlink test), 27 files; coverage thresholds met (90.3% lines, 76.4% branches, 86.9% statements, 88.7% functions); seven more coverage runs in a row passed |
| Smoke test in VS Code | Passed | Everything from 2.3.0, plus: every new command is registered; Codex only answered without calling Claude; both CLIs reported signed in through their status commands; Codex + Claude made Claude the checker; Compare gave two answers and a merge; Fix with Dual Agent and Ask Dual Agent filled the message box in the right mode without sending; no script errors or blocked content on the page. Passed on two consecutive runs |
| VSIX package | Passed | `dual-agent-orchestrator-2.4.0.vsix`, 19 files, 813 KB, including `dist/permissionServer.js` |
| Screenshots | Rendered | Chat (dark), edit (light), usage panel with limits and machine-wide usage, Agent mode with a permission card, and solo mode |
| Machine-wide usage | Checked | On this machine: a first scan of eight days of Claude Code and Codex logs took 1.2 s, a rescan 10 ms; Codex's limits matched its last report |
| Live Agent mode | Passed | Signed-in Claude Code 2.1.312 (Haiku) and Codex CLI 0.165.0 (low effort), in a folder without Git: the folder was snapshotted, Claude asked through the bridge before writing `hello.txt` and ran `node --version` without asking (read-only), the file held exactly `hello`, Codex's check passed, and Undo removed the file and kept the README |
| Live network outage | Passed | Both CLIs pointed at a proxy nobody listens on: Claude Code retried for about 3 minutes, then reported "API Error: Connection refused"; the run stopped with `offlineSince`, Codex was not tried, and resuming without the proxy completed with Codex agreeing |
| Live limits refresh | Passed | One tiny call each: Claude reported its 5-hour window (7,077 input tokens), Codex its 5-hour and weekly windows (13,468 input tokens) |
| Gemini referee live | Not run | Gemini CLI 0.66.0 is installed but not signed in; the referee's parser and its place in the run are tested |

Results of the 2.3.0 verification on Windows 11 with Node.js 22.13.0 and VS Code 1.143.1:

| Check | Result | Notes |
|---|---|---|
| Dependency audit | Passed | `npm audit`: 0 vulnerabilities; `npm audit signatures` on a clean `npm ci`: 282 packages with verified registry signatures, 62 with verified attestations |
| TypeScript and ESLint | Passed | Strict `tsc --noEmit`; type-aware ESLint with zero findings |
| Unit and integration tests | Passed | 245 passed, 1 skipped (POSIX-only symlink test), 22 files, coverage thresholds met (2.3.1) |
| Smoke test in VS Code | Passed | Everything from 2.2.0, plus: the extension activated under its Marketplace ID; a second Edit message was edited and resent, its file was undone from the checkpoint, and Claude started a new session; a message sent during a run waited in the queue and then ran by itself; the chat page reported no script errors or blocked content under Trusted Types; the walkthrough opened |
| Workflow lint | Passed | The GitHub Actions extension reported no problems in `ci.yml`, `codeql.yml`, or `release.yml`; action SHAs checked against their tags with `git ls-remote` |
| VSIX package | Passed | `dual-agent-orchestrator-2.3.0.vsix`, 18 files, 753 KB, `vsce package` without bypass flags and with no warnings; docs and screenshots excluded |
| Screenshots | Rendered | From the built chat bundle in headless Chrome: chat (dark), edit with changes (light), usage panel, and solo mode with the limit banner and queue |
| Live usage-limit behavior | Not run | Reset parsing is tested against the wording both CLIs have used; a real limit was not reached during verification |
| Live release | Not run | The release workflow runs when a version tag is pushed, after the trusted publishers are set up on both registries |

Results of the 2.1.0 verification on Windows 11 with Node.js 22.13.0, Git 2.49.0, VS Code 1.143.1, Claude Code 2.1.312, and Codex CLI 0.165.0:

| Check | Result | Notes |
|---|---|---|
| Dependency audit | Passed | `npm audit`: 0 known vulnerabilities, with preact 10.29.8, markdown-it 15.0.3, fflate 0.8.3, and unpdf 1.8.1 pinned |
| TypeScript | Passed | Strict `tsc --noEmit`, including the webview's TSX |
| ESLint | Passed | Type-aware rules; zero findings |
| Unit and integration tests | Passed | 215 passed, 1 skipped (POSIX-only symlink test), 18 files |
| Coverage | Passed | 93.8% lines, 78.5% branches, 90.2% statements, 91.4% functions across every module that does not import `vscode` or Preact |
| Smoke test in VS Code | Passed | `npm run smoke`, VS Code 1.143.1. Brainstorming and worktree review as in 2.0.0. The chat page loaded its script under its CSP, and the Codex model list arrived from the fake CLI. A Chat message with an attachment completed with "Codex agreed", both agents' steps stayed in the transcript with their IN and OUT, and each fake CLI received the chosen model, effort, attachment folder, streaming, and read-only tools. A follow-up continued Claude's session. An Edit message passed the consent card and changed only the worktree, and its changes card listed the file. The chat opened in an editor tab |
| Live chat with attachments | Passed | Real CLIs, Claude haiku at low effort and Codex gpt-5.6-luna at low effort, in a disposable repository. Claude read a PNG, a PDF, a Word file, and a ZIP and answered all four facts correctly, with text streamed in 28 chunks. Codex opened the unpacked ZIP file in its sandbox and saw the image through `--image`, and passed the answer |
| Live follow-up | Passed | Claude continued its session and answered from it |
| Live research | Passed | Claude haiku and Codex gpt-5.6-luna: Claude cited three arXiv papers; Codex opened their full text and found three real problems (an understated mitigation section, real workloads described as missing, a paper published at EuroSys 2025 described as a preprint); Claude reopened the papers, corrected all three, and rebutted the part Codex overstated |
| Live token comparison | Passed | Same chat question, attachments, and models as the 2.1 check: Codex input on the follow-up check fell from 31.3k to 15.7k tokens, Claude's follow-up answer from 49 to 21 output tokens, first message unchanged within noise on this small repository |
| Live first-shot edit | Passed | With `node --test` configured, Claude ran `node --test math.test.js` itself under the prefix rule and reported both tests passing; an exact rule had blocked the same command, which led to prefix rules |
| Live edit | Passed | Claude continued the session from the worktree folder and edited only the worktree. Codex reviewed with `git diff` and passed it. The repository was unchanged until apply. API-equivalent Claude cost for all three messages: $0.13 |
| PDF worker | Passed | The bundled `dist/pdfWorker.js` extracted text in a worker thread; a hanging worker is stopped by the timeout in tests |
| Chat layout | Checked | The built page rendered in headless Chrome with VS Code's dark theme colors at 300, 400, and 440 pixels wide: the timeline of stages and tool calls with IN/OUT boxes, cards, and the composer's mode and model pills |
| Claude tool limits | Passed | A read-only stage had only Glob, Grep, and Read, and its Write attempt failed; a write stage without rules had no Bash; a `Bash(node:*)` rule ran that command |
| Live brainstorming run | Passed | (2.0.0) all 5 stages on their intended agents, verdicts parsed, Claude session continued |
| Git hooks disabled | Passed | Planted hooks never ran during the worktree lifecycle; a control `git worktree add` ran them |
| Worktree apply | Passed | Applies to the working tree only, refuses conflicts without writing, works with `core.autocrlf=true` checkouts on Windows |
| VSIX package | Passed | `dual-agent-orchestrator-2.1.0.vsix`, 27 files, 752 KB, no packaging warnings |
| CI | Passed | GitHub Actions on Windows and Linux, and the VSIX package job, for 2.1.0 at commit `31b23cb` |
| Live implementation run | Not run | Plan approval from the chat card, verification commands, and apply with signed-in CLIs remain to be tested by hand |

## Release acceptance criteria

- [x] A first-time reader can understand the product and safety boundary from README.
- [x] The chat is the only webview, loads nothing from the network, and validates every message; everything else is native VS Code UI.
- [x] A chat answer is checked by Codex, and revised by Claude when the check fails.
- [x] Claude leads implementation and final synthesis; Codex independently reviews planning, implementation, and final state.
- [x] Brainstorming applies the same reciprocal challenge/synthesis pattern.
- [x] Only explicitly authorized stages can write, by default to an isolated worktree that the user applies.
- [x] A run is marked completed only when its final gate passed.
- [x] Attachments stay in private storage and are unpacked and parsed with limits.
- [x] Models and efforts can be chosen per message and are validated before reaching a CLI.
- [x] Commands the extension runs come only from user settings and are listed in the consent dialog or card.
- [x] Agent credentials remain owned by official CLIs.
- [x] API billing cannot be selected accidentally in the default configuration.
- [x] Conversations and run state survive VS Code restarts, and interrupted runs can be resumed.
- [x] A repository cannot supply the executables, Git hooks, settings, or model choices the extension uses.
- [x] Cancellation stops the agent's whole process tree.
- [x] Final `npm run check` passes.
- [x] `npm run smoke` passes in a real VS Code.
- [x] VSIX packaging passes.
- [x] Live chat, follow-up, and edit messages pass with signed-in CLIs.
- [x] CI passes on Windows and Linux for 2.1.0.
- [x] Usage limits reroute or pause work and never change permissions; automatic continuation of an edit run needs unchanged commands.
- [x] Retrying a message never changes files outside the extension's worktree storage.
- [x] `vsce package` passes without bypass flags, and the VSIX contains no docs, sources, or screenshots.
- [x] In Agent mode, Claude runs a command or edit it does not judge read-only only after the user allows it, and a caller without the bridge token is refused.
- [x] Agents edit a folder directly only after a snapshot and consent, and undo restores the snapshot without touching excluded files or anything outside the folder.
- [x] A command from agent output runs only after a confirmation, without a shell, and shell syntax is refused.
- [ ] Signed-in Agent-mode run with permission cards, a check by Codex, and undo.
- [ ] Signed-in implementation run from the chat with plan approval, verification commands, review, and apply.
- [ ] First tagged release published to the Marketplace and Open VSX by the release workflow.

## Known risks

1. Provider CLI JSON schemas can evolve independently. The parsers tolerate unknown events, but incompatible final-result or error-event changes need maintenance. `codex debug models` is a debugging command whose format may change; the picker then offers only the default and a custom model.
2. Subscription usage endpoints are not normalized across providers. The ledger is observational, not authoritative.
3. Claude's tool allowlist and plan/accept-edits modes are enforced by Claude Code, not an operating-system sandbox, and they inherit the user's own Claude policies, hooks, and managed settings. Repository settings are excluded. Once a rule grants Bash, Claude Code also runs commands it judges read-only.
4. Codex applies project configuration according to its own trust settings; the extension only warns about a `.codex` directory.
5. Agents with read access can open files the CLI's own sandbox allows, including secrets that are excluded from prompts.
6. Verdicts are model output and can be wrong or influenced by repository content or attachments. They decide only fix rounds, revisions, and labels.
7. Setup and verification commands run repository code, including agent-edited code, with the user's permissions outside any sandbox. They require explicit configuration and consent.
8. Worktrees lack ignored files and submodules, so checks may need setup commands, and very deep paths under workspace storage may exceed tool path limits on Windows.
9. Codex stages always start a new session and stream no text; the chat shows Codex's steps as they complete.
10. Everything attached is sent to both providers. The chat says so, and asks again for files whose names suggest secrets.
11. The webview relies on VS Code's webview isolation, in addition to its own CSP and message validation.
12. Model output can be wrong even after reciprocal review and passing checks. Human diff review remains mandatory.
13. Full workflows and fix rounds are intentionally expensive; a chat message costs two or three agent calls.
14. In solo mode one agent checks its own answer, which is weaker than an independent check. Stages are labelled as standing in, and `dualAgent.fallbackOnQuota` turns it off.
15. Reset times are parsed from provider wording that can change; unrecognized wording falls back to estimated retries.
16. An automatic continuation can run an edit and its verification commands without a new prompt, limited to unchanged commands; `dualAgent.limits.autoContinue` turns it off.
17. Secret masking recognizes known credential formats only.
18. Retry checkpoints are unreferenced Git objects that `git gc` can remove after its prune period; a retry whose checkpoint is gone stops without changing anything.
19. Agent mode runs allowed commands on the real machine with the user's permissions. Installs and other effects outside the folder cannot be undone, Claude Code's read-only judgement decides what runs without a prompt, and allowing a tool for a message allows every later call of it in that run.
20. In Agent mode Codex cannot ask, so it is bounded only by its sandbox, which reaches the network unless `dualAgent.codex.agentNetwork` is off.
21. Direct edits are not isolated: the agents write the folder during the run, and undo leaves excluded files such as `node_modules` and `.env`, and changes inside nested repositories, as they are.
22. Codex rate limits are read from its session log, whose location and format Codex can change; the meter then stays empty for Codex.
23. The Gemini referee is another provider, whose CLI configuration the extension does not disable; its ruling is advisory.
24. The machine-wide reader depends on the CLIs' log formats, which can change, and counts whatever sessions those folders hold; a limit message there can send work to the other agent until its stated reset. `dualAgent.usage.readLocalLogs` turns it off.
25. The connectivity check tells offline from a single outage by reaching a provider host or the proxy; a network that blocks those hosts but not the CLIs, or the reverse, is misjudged, which costs a fallback or a pause, not a permission.

## Next verification action

With signed-in CLIs, install the VSIX and test in a disposable Git repository:

1. In the chat, attach an image and a PDF, ask about them, and send a follow-up.
2. Send an Edit message, allow it, review the changes card's diff, and apply it.
3. In Implement mode, approve the plan with guidance from the card, with `dualAgent.verification.commands` set, then review and apply the changes.
4. Stop a message while a stage runs, then resume it from the chat.
5. Apply a second edit over a conflicting change, and confirm that nothing is written.
6. Check the chat in a light theme and in the right-hand side bar.
7. Queue a message during a run, and retry an earlier Edit message; confirm the worktree matches the checkpoint.
8. When a real usage limit is reached, confirm the banner shows the provider's reset time and that the other agent carries on.
9. In a disposable folder without Git, send an Agent message that installs a package; answer the permission cards in the chat and, with the chat hidden, in the dialog; then undo and confirm the folder matches the snapshot apart from `node_modules`.
10. Send Edit and Test first messages in a folder without Git, and keep the changes of one and undo the other.
11. Try **Codex + Claude**, **Claude only**, and Compare with signed-in CLIs, and confirm the outcome labels.
12. Turn on the Gemini referee, make a check fail, and confirm the ruling appears before the revision.
13. Confirm the limits meter shows both accounts' windows after a message, and that **On this machine** counts a session run in a terminal.
14. Disconnect the network during a message, confirm the **Waiting for the network** card, and that it continues once the connection is back.
15. Set up trusted publishing on both registries, push the `v2.4.0` tag, and verify the release's attestation with `gh attestation verify`.
