# Project status

This document is the maintained implementation ledger for Dual Agent Orchestrator. Update it whenever behavior, verification, risk, or release readiness changes.

## Snapshot

| Field | Value |
|---|---|
| Release | 2.0.0 (native VS Code interface, isolation, verification gate) |
| Last updated | 2026-10-28 |
| Product scope | Desktop VS Code extension, trusted local workspaces only |
| Interface | Activity-bar tree views, commands, status bar, output channel, read-only documents, diff editors; no webview |
| Primary workflow | Claude-led implementation with reciprocal Codex review, plan approval, and a verified final gate |
| Secondary workflow | Claude-led reciprocal brainstorming |
| Runtime integration | Local Claude Code and Codex CLIs, resolved to absolute paths outside the workspace and worktree |
| Authentication | Existing CLI sign-ins; credentials are not read by the extension |
| Agent environment | Allowlisted; billing variables removed in subscription mode |
| State | Private VS Code workspace storage (run history and worktrees) |
| Network service | None |

## Delivery progress

| Area | Status | Evidence |
|---|---|---|
| Project structure and build | Complete | TypeScript, esbuild, strict configuration |
| Native VS Code interface | Complete | Runs and Agents views, welcome view, menus, status bar, output channel, documents, diff review; smoke test in VS Code 1.143.1 |
| Claude CLI adapter | Complete | Stream-JSON parser, error results, user-only settings, no MCP, write-stage tool rules, `--resume` with fresh-session retry |
| Codex CLI adapter | Complete | JSONL parser, `turn.failed` handling, sandbox modes, `.codex` warning |
| Executable resolution | Complete | Absolute paths only; workspace, worktree, and relative `PATH` entries excluded |
| Process lifecycle | Complete | Bounded capture, pre-aborted signals, process-tree termination, no indefinite waits |
| Reciprocal implementation workflow | Complete | Seven stages plus bounded fix rounds; requires a working Git repository |
| Reciprocal brainstorming workflow | Complete | Five read-only stages with recorded verdicts |
| Verdict parsing and final gate | Complete | Fenced JSON verdict; gate needs a pass verdict and passing checks; `completed-with-findings` |
| Extension-run checks | Complete | Setup and verification commands as argument vectors, allowlisted environment, consent |
| Worktree isolation | Complete | Base includes uncommitted and untracked work; review, conflict-checked apply, discard; hooks disabled |
| Plan approval | Complete | Notification, status bar, view, and palette; guidance carried into later prompts |
| Session continuity and resume | Complete | Claude session reuse; resume from first unfinished stage; interrupted runs recovered |
| Multi-root workspaces | Complete | Folder picker, active editor's folder first |
| Shared checkpoint context | Complete | Per-section budgets including check output, random block boundaries, restated contract |
| Durable run state | Complete | Serialized saves, locked-file retry, unreadable history set aside, unapplied runs never pruned |
| Usage observation | Complete | Per-provider totals including failed attempts |
| Bounded provider fallback | Complete | Classified from provider errors and stderr only; fresh snapshot |
| Report export | Complete | Markdown report with verdicts, checks, isolation, approval, warnings |
| Unit and integration tests | Complete | Fake-CLI adapter and check tests, real-Git snapshot and worktree tests, regression tests |
| CI and packaging | Complete | Windows/Linux checks and VSIX artifact workflow |
| Documentation | Complete | README, architecture, workflow, security, operations, development, roadmap, ADRs 0001 to 0006 |

## Verification record

Results of the 2.0.0 verification on Windows 11 with Node.js 22.13.0, Git 2.49.0, and VS Code 1.143.1:

| Check | Result | Notes |
|---|---|---|
| Dependency install | Not re-run | Dependencies unchanged; lockfile changed only in its version field |
| Dependency audit | Passed | `npm audit`: 0 known vulnerabilities |
| TypeScript | Passed | Strict `tsc --noEmit` |
| ESLint | Passed | Type-aware rules; zero findings |
| Unit and integration tests | Passed | 145 passed, 1 skipped (POSIX-only symlink test), 15 files |
| Coverage | Passed | 93.5% lines, 79.7% branches, 88.7% statements, 91.2% functions across every module that does not import `vscode` |
| Smoke test in VS Code | Passed | `npm run smoke`, VS Code 1.143.1: activation, all contributed commands registered, both views, agent check, a brainstorming run started from a selection through the real QuickPick, verdict parsed, Claude session continued, report and stage documents, and a worktree's changes in the multi-file and single-file diff editors |
| Smoke test detects failures | Passed | With one assertion deliberately broken, `npm run smoke` exited with code 1 |
| Git hooks disabled | Passed | Planted `post-checkout` and `reference-transaction` hooks never ran during the worktree lifecycle; a control `git worktree add` ran them |
| Worktree apply | Passed | Applies to the working tree only, refuses conflicts without writing, works with `core.autocrlf=true` checkouts on Windows |
| Production bundle | Passed | esbuild output to `dist/extension.js` |
| VSIX package | Passed | `dual-agent-orchestrator-2.0.0.vsix`, 23 files, 93 KB, no packaging warnings |
| Claude CLI flags | Passed | `--resume` present in Claude Code 2.1.304; an unknown session fails before any model call with "No conversation found", which the adapter retries as a new session |
| Codex CLI discovery | Not run | Codex was not on `PATH` for the verifying account; Codex arguments are unchanged from 1.1.0 and Codex sessions are not resumed |
| Linux test run | Pending | POSIX-only paths (process-group termination, symlink handling) run in CI |
| Live model workflow | Not run | Intentionally avoids spending user quota during build verification |

## Release acceptance criteria

- [x] A first-time reader can understand the product and safety boundary from README.
- [x] The extension uses native VS Code UI only.
- [x] Claude leads implementation and final synthesis; Codex independently reviews planning, implementation, and final state.
- [x] Claude adjudicates Codex findings before applying fixes.
- [x] Brainstorming applies the same reciprocal challenge/synthesis pattern.
- [x] Only explicitly authorized stages can write, by default to an isolated worktree that the user applies.
- [x] A run is marked completed only when its final gate passed.
- [x] Commands the extension runs come only from user settings and are listed in the consent dialog.
- [x] Agent credentials remain owned by official CLIs.
- [x] API billing cannot be selected accidentally in the default configuration.
- [x] Run state survives extension UI closure and VS Code restart, and interrupted runs can be resumed.
- [x] Failures, fallbacks, verdicts, and checks remain visible in the exported record.
- [x] A repository cannot supply the executables or Git hooks the extension runs.
- [x] Cancellation stops the agent's whole process tree.
- [x] Final `npm run check` passes.
- [x] `npm run smoke` passes in a real VS Code.
- [x] VSIX packaging passes.
- [ ] CI passes on Linux for 2.0.0.
- [ ] Signed-in test with live CLIs: brainstorming, cancellation, resume, and an implementation run with plan approval, verification commands, review, and apply.

## Known risks

1. Provider CLI JSON schemas can evolve independently. The parsers tolerate unknown events, but incompatible final-result or error-event changes need maintenance.
2. Subscription usage endpoints are not normalized across providers. The ledger is observational, not authoritative.
3. Claude plan/accept-edits modes inherit the user's own Claude policies, hooks, and managed settings. Repository settings are excluded. Accept-edits is not an operating-system sandbox.
4. Codex applies project configuration according to its own trust settings; the extension only warns about a `.codex` directory.
5. Agents with read access can open files the CLI's own sandbox allows, including secrets that are excluded from prompts.
6. Verdicts are model output and can be wrong or influenced by repository content. They decide only fix rounds and the run's label.
7. Setup and verification commands run repository code, including agent-edited code, with the user's permissions outside any sandbox. They require explicit configuration and per-run consent.
8. Worktrees lack ignored files and submodules, so checks may need setup commands, and very deep paths under workspace storage may exceed tool path limits on Windows.
9. Codex stages always start a new session; Codex's `exec resume` flags are unverified.
10. Model output can be wrong even after reciprocal review and passing checks. Human diff review remains mandatory.
11. Full workflows and fix rounds are intentionally expensive. Use them for consequential work rather than trivial edits.

## Next verification action

Push to CI to confirm the Linux run. Then, with signed-in CLIs, install the VSIX and test in a disposable Git repository:

1. Run a read-only brainstorming run.
2. Cancel a run during a stage, then resume it.
3. Run an implementation with `dualAgent.verification.commands` and `dualAgent.isolation.setupCommands` set: approve the plan with guidance, then review and apply the changes.
4. Apply a second run's changes over a conflicting edit, and confirm that nothing is written.
