# Project status

This document is the maintained implementation ledger for Dual Agent Orchestrator. Update it whenever behavior, verification, risk, or release readiness changes.

## Snapshot

| Field | Value |
|---|---|
| Release | 2.3.0 (Marketplace-ready: solo mode at usage limits, automatic continuation, message queue, retry and edit, secret masking, Trusted Types, signed releases) |
| Last updated | 2026-10-28 |
| Product scope | Desktop VS Code extension, trusted local workspaces only |
| Interface | Chat webview (side bar or editor tab); native Runs and Agents views, commands, status bar, output channel, read-only documents, diff editors |
| Primary workflow | Chat: Claude answers, Codex checks the answer, Claude revises when the check fails; one agent carries on alone while the other is at its usage limit |
| Other workflows | Research (web research, Codex source verification, revision); Edit (worktree edit, Codex review gate, fix rounds); Claude-led implementation with plan approval and a verified final gate; reciprocal brainstorming |
| Runtime integration | Local Claude Code and Codex CLIs, resolved to absolute paths outside the workspace and worktree |
| Authentication | Existing CLI sign-ins; credentials are not read by the extension |
| Agent environment | Allowlisted; billing variables removed in subscription mode |
| State | Private VS Code workspace storage: conversations, attachments, run history, worktrees |
| Network service | None; the chat page loads nothing from the network, and there is no telemetry |
| Distribution | Visual Studio Marketplace and Open VSX as `NileshRavishan.dual-agent-orchestrator`, published by tag through OpenID Connect trusted publishing (first Marketplace version uploaded by hand until the Marketplace accepts it) |

## Delivery progress

| Area | Status | Evidence |
|---|---|---|
| Project structure and build | Complete | TypeScript, esbuild (extension, PDF worker, and webview bundles), strict configuration |
| Chat panel | Complete | Webview view and editor tab (title-bar button, named after the conversation), nonce CSP, validated protocol, streamed text, a timeline of agent steps with IN/OUT kept after the run, verdict badges, consent, approval, changes and check cards, history; smoke test in VS Code 1.143.1 |
| Research workflow and web access | Complete | Claude WebSearch and WebFetch, Codex `--search`, source verification, high effort by default, Web toggle per message |
| Quality and token controls | Complete | Lean context, evidence trail, economical-work guidance, answers for the reader, minor-notes rule, verification commands available to editing stages, one repair before review |
| Chat and Edit workflows | Complete | Chat check with a single revision; Edit with a gate and fix rounds in a conversation-scoped worktree |
| Conversations | Complete | One file per conversation, budgeted history, Claude sessions across messages, answers kept after run pruning |
| Attachments | Complete | Images, PDFs, ZIP, Word, Excel, PowerPoint, notebooks, text; private storage, content detection, safe unpacking, PDF worker with timeout |
| Models and effort | Complete | Composer pickers, Codex catalog from `codex debug models`, default settings, validation at every entry point |
| Native VS Code views | Complete | Runs and Agents views, welcome view, menus, status bar, output channel, documents, diff review |
| Claude CLI adapter | Complete | Stream-JSON parser with deltas and tool activity, error results, user-only settings, no MCP, explicit tool allowlist, `--add-dir`, `--model`, `--effort`, `--resume` with fresh-session retry |
| Codex CLI adapter | Complete | JSONL parser with activity, `turn.failed` handling, sandbox modes, `--image`, `--model`, reasoning effort, `--skip-git-repo-check` for read-only stages, `.codex` warning |
| Executable resolution | Complete | Absolute paths only; workspace, worktree, and relative `PATH` entries excluded |
| Process lifecycle | Complete | Bounded capture, pre-aborted signals, process-tree termination, no indefinite waits |
| Reciprocal implementation workflow | Complete | Seven stages plus bounded fix rounds; requires a working Git repository |
| Reciprocal brainstorming workflow | Complete | Five read-only stages with recorded verdicts |
| Verdict parsing and final gate | Complete | Fenced JSON verdict; gate needs a pass verdict and passing checks; `completed-with-findings` |
| Extension-run checks | Complete | Setup and verification commands as argument vectors, allowlisted environment, consent |
| Worktree isolation | Complete | Base includes uncommitted and untracked work; review, conflict-checked apply, discard; hooks disabled; shared by a conversation's edits |
| Plan approval | Complete | Chat card, notification, status bar, view, and palette; guidance carried into later prompts |
| Session continuity and resume | Complete | Claude session reuse within runs and across messages; resume from first unfinished stage; interrupted runs recovered |
| Shared checkpoint context | Complete | Per-section budgets including checks, attachments, and history; random block boundaries; restated contract |
| Durable state | Complete | Serialized saves, locked-file retry, unreadable files set aside, unapplied work never pruned |
| Usage observation | Complete | Per-provider totals including failed attempts, with input counted the same way for both agents; shown per stage, per message, and for the conversation, today, 7 days, and all runs |
| Bounded provider fallback | Complete | Classified from provider errors and stderr only; fresh snapshot |
| Usage limits and solo mode | Complete | Reset times parsed from provider messages, estimates with backoff, limited agent skipped until reset, catch-up for continued sessions, answers by role |
| Automatic continuation | Complete | Paused runs continue after the reset, survive restarts, retry while busy, and edit runs continue only with unchanged commands |
| Message queue | Complete | Persisted, bounded, removable items; drained when the lock is free and the agents can work |
| Retry and edit | Complete | Later turns removed, worktree restored from a Git-tree checkpoint or discarded, fresh sessions, confirmation when rewinding past later messages |
| Secret masking | Complete | Credentials masked in prompts, the output log, and exported reports |
| Marketplace readiness | Complete | Publisher, icon, screenshots from the real bundle, walkthrough, categories, repository links, clean `vsce package`, Delete All History command |
| Supply chain and release | Complete | SHA-pinned actions, `npm audit` and `npm audit signatures`, CodeQL, Dependabot with cooldown, tag release with checksums, build provenance, and OIDC publishing |
| Report export | Complete | Markdown report with verdicts, checks, isolation, approval, attachments, warnings |
| Unit and integration tests | Complete | Fake-CLI adapter and check tests, real-Git snapshot, worktree, and checkpoint tests, attachment tests with real pdf.js, chat protocol, Markdown, Trusted Types, and transcript tests, limit parsing, solo mode, continuation, and masking tests |
| CI and packaging | Complete | Windows/Linux checks, supply-chain job, CodeQL, VSIX artifact, and tag-triggered release workflow |
| Documentation | Complete | Marketplace README, walkthrough, architecture, workflow, security, operations, development and release, roadmap, ADRs 0001 to 0009, issue and pull-request templates |

## Verification record

Results of the 2.3.0 verification on Windows 11 with Node.js 22.13.0 and VS Code 1.143.1:

| Check | Result | Notes |
|---|---|---|
| Dependency audit | Passed | `npm audit`: 0 vulnerabilities; `npm audit signatures` on a clean `npm ci`: 282 packages with verified registry signatures, 62 with verified attestations |
| TypeScript and ESLint | Passed | Strict `tsc --noEmit`; type-aware ESLint with zero findings |
| Unit and integration tests | Passed | 241 passed, 1 skipped (POSIX-only symlink test), 21 files, coverage thresholds met |
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
9. Set up trusted publishing on both registries, push the `v2.3.0` tag, and verify the release's attestation with `gh attestation verify`.
