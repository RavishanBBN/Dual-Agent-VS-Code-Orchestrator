# Project status

This document is the maintained implementation ledger for Dual Agent Orchestrator. Update it whenever behavior, verification, risk, or release readiness changes.

## Snapshot

| Field | Value |
|---|---|
| Release | 1.1.0 (security hardening) |
| Last updated | 2026-10-28 |
| Product scope | Desktop VS Code extension, trusted local workspaces only |
| Primary workflow | Claude-led implementation with reciprocal Codex review |
| Secondary workflow | Claude-led reciprocal brainstorming |
| Runtime integration | Local Claude Code and Codex CLIs, resolved to absolute paths outside the workspace |
| Authentication | Existing CLI sign-ins; credentials are not read by the extension |
| Agent environment | Allowlisted; billing variables removed in subscription mode |
| State | Private VS Code workspace storage |
| Network service | None |

## Delivery progress

| Area | Status | Evidence |
|---|---|---|
| Project structure and build | Complete | TypeScript, esbuild, strict configuration |
| VS Code activity-bar dashboard | Complete | Webview view, CSP with cryptographic nonce, validated messages, run warnings |
| Claude CLI adapter | Complete | Stream-JSON parser, error results, user-only settings, no MCP, write-stage tool rules |
| Codex CLI adapter | Complete | JSONL parser, `turn.failed` handling, sandbox modes, `.codex` warning |
| Executable resolution | Complete | Absolute paths only; workspace and relative `PATH` entries excluded |
| Process lifecycle | Complete | Bounded capture, pre-aborted signals, process-tree termination, no indefinite waits |
| Reciprocal implementation workflow | Complete | Seven explicit stages; requires a working Git repository |
| Reciprocal brainstorming workflow | Complete | Five read-only stages |
| Shared checkpoint context | Complete | Staged/unstaged diff, untracked files, per-section budgets, random block boundaries, restated contract |
| Durable run state | Complete | Serialized saves, locked-file retry, unreadable history set aside |
| Usage observation | Complete | Per-provider totals including failed attempts |
| Bounded provider fallback | Complete | Classified from provider errors and stderr only; fresh snapshot |
| Report export | Complete | Markdown report with warnings; defaults outside the repository |
| Write consent | Complete | UI checkbox, modal command confirmation, read-only downgrade without consent |
| Unit and integration tests | Complete | Fake-CLI adapter tests, Git repository tests, vulnerability regression tests |
| CI and packaging | Complete | Windows/Linux checks and VSIX artifact workflow |
| Documentation | Complete | README, architecture, workflow, security, operations, development, ADRs 0001 to 0004 |

## Verification record

Results of the 1.1.0 verification on Windows 11 with Node.js 22.13.0:

| Check | Result | Notes |
|---|---|---|
| Dependency install | Not re-run | Dependencies unchanged; lockfile changed only in its version field |
| TypeScript | Passed | Strict `tsc --noEmit` |
| ESLint | Passed | Type-aware rules; zero findings |
| Unit and integration tests | Passed | 93 passed, 1 skipped (POSIX-only symlink test) |
| Coverage | Passed | 93.2% lines, 79.2% branches, 88.5% statements, 91.7% functions across every module that does not import `vscode` |
| Regression tests are meaningful | Passed | With the fixes temporarily reverted, the planted `git.exe` and `.cmd` cancellation tests fail |
| Production bundle | Passed | esbuild output to `dist/extension.js` |
| Dependency audit | Not re-run | No dependency changes since the 1.0.0 audit (0 known vulnerabilities) |
| VSIX package | Passed | `dual-agent-orchestrator-1.1.0.vsix` created successfully |
| Claude CLI flags | Passed | `--setting-sources`, `--strict-mcp-config`, and `--allowedTools` present in Claude Code 2.1.304 |
| Codex CLI discovery | Not run | Codex was not on `PATH` for the verifying account; Codex arguments are unchanged from 1.0.0 |
| Linux test run | Pending | POSIX-only paths (process-group termination, symlink handling) run in CI |
| Live model workflow | Not run | Intentionally avoids spending user quota during build verification |

## Release acceptance criteria

- [x] A first-time reader can understand the product and safety boundary from README.
- [x] Claude leads implementation and final synthesis.
- [x] Codex independently reviews planning, implementation, and final state.
- [x] Claude adjudicates Codex findings before applying fixes.
- [x] Brainstorming applies the same reciprocal challenge/synthesis pattern.
- [x] Only explicitly authorized stages can write to the workspace.
- [x] Agent credentials remain owned by official CLIs.
- [x] API billing cannot be selected accidentally in the default configuration.
- [x] Run state survives extension UI closure and VS Code restart.
- [x] Failures and fallbacks remain visible in the exported record.
- [x] A repository cannot supply the executables the extension runs.
- [x] Cancellation stops the agent's whole process tree.
- [x] Final `npm run check` passes.
- [x] VSIX packaging passes.
- [ ] CI passes on Linux for 1.1.0.
- [ ] Manual Extension Development Host smoke test completed by a signed-in user.

## Known risks

1. Provider CLI JSON schemas can evolve independently. The parsers tolerate unknown events, but incompatible final-result or error-event changes need maintenance.
2. Subscription usage endpoints are not normalized across providers. The ledger is observational, not authoritative.
3. Claude plan/accept-edits modes inherit the user's own Claude policies, hooks, and managed settings. Repository settings are excluded.
4. Codex applies project configuration according to its own trust settings; the extension only warns about a `.codex` directory.
5. Agents with read access can open files the CLI's own sandbox allows, including secrets that are excluded from prompts.
6. Codex's PASS verdict is not parsed; a run with unresolved final findings is still marked completed after Claude's finalization stage.
7. Model output can be wrong even after reciprocal review. Deterministic tests and human diff review remain mandatory.
8. Full workflows are intentionally expensive. Users should choose them for consequential work rather than trivial edits.

## Next verification action

Push to CI to confirm the Linux run, then launch the extension in an Extension Development Host and perform an authenticated smoke test in a disposable Git repository: doctor, read-only brainstorming, cancellation during a stage, export, and an implementation run with `dualAgent.claude.allowedTools` set for the repository's test command.
