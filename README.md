# Dual Agent Orchestrator for VS Code

> Claude-led implementation, Codex-led review, reciprocal verification, and deterministic quality gates, built into the VS Code sidebar.

## Project status

- **Release:** 2.0.0 (native VS Code interface, isolated worktrees, verification gate; see [CHANGELOG.md](CHANGELOG.md))
- **Lifecycle:** production-oriented local release
- **Last updated:** 2026-10-28
- **Implementation:** complete
- **Verification:** lint, type checking, unit and integration tests, and an automated smoke test inside a real VS Code; see [PROJECT_STATUS.md](PROJECT_STATUS.md) for the verified results and known limitations.

This project is a desktop VS Code extension that coordinates the locally installed Claude Code and Codex CLIs. It is designed for developers who have subscriptions for both products and want them to work as a disciplined pair without copying credentials, merging private reasoning, or letting two agents overwrite the same files.

It is a regular extension: an activity-bar icon with tree views, commands in the Command Palette, a status bar item, an output channel, and the built-in diff editor. There is no web page or embedded web view.

The extension does not merge subscription quotas. It observes the usage events each CLI reports, keeps a local ledger, routes bounded fallback work when a provider is unavailable, and keeps an auditable record of every stage.

## The complete idea in one minute

For implementation work, Claude leads and Codex reviews:

```text
Claude plan
    -> Codex plan review
    -> you approve the plan (optional, on by default)
    -> Claude reconciliation and implementation      -> extension runs your checks
    -> Codex independent code review
    -> Claude finding adjudication and fixes         -> extension runs your checks
    -> Codex final verification (the gate)
         fail? -> Claude fix round -> checks -> Codex re-verification (bounded)
    -> Claude completion report (read-only)
    -> you review the diff, then apply or discard it
```

Implementation runs edit an isolated Git worktree in the extension's private storage, never your working tree. When the run ends you open the changes in VS Code's diff editor and apply them with one command, or discard them.

For brainstorming, the same reciprocal pattern stays read-only:

```text
Claude proposal
    -> Codex challenge
    -> Claude synthesis
    -> Codex final challenge
    -> Claude final recommendation
```

Each stage receives the objective, the current Git status and diff, the contents of small new untracked files, the latest check results, and bounded outputs from completed stages. Agent output and repository content are fenced in blocks marked with a random per-prompt boundary and treated as untrusted evidence, not instruction. Only implementation and fix stages can write, and only with the run's explicit consent. Codex review stages stay read-only.

Reviewers end with a machine-readable verdict. The final gate passes only with a "pass" verdict and passing verification commands; otherwise Claude gets a bounded number of fix rounds, and a run that still fails ends as **completed with unresolved findings** rather than as a success.

## Why this exists

Running two coding agents independently creates avoidable problems:

- duplicated work consumes both subscriptions;
- the agents lose each other's decisions and test evidence;
- simultaneous edits conflict;
- review feedback is applied without adjudication;
- a review that fails is easy to overlook;
- provider limits interrupt work without a clean handoff;
- chat history becomes the only state store;
- there is no durable record of what happened.

Dual Agent Orchestrator turns that ad-hoc interaction into a fixed, inspectable workflow with explicit roles, permissions, checkpoints, gates, usage observations, fallback rules, and exportable reports.

## Design principles

1. **Roles before model preference.** Claude is the default implementation lead; Codex is the independent reviewer.
2. **One writer at a time, in isolation.** A stage is read-only or workspace-write, stages run one after another, and implementation edits an isolated worktree that you apply deliberately.
3. **Reciprocal review.** Codex reviews Claude's plan and code. Claude must accept, reject with a reason, or escalate each finding.
4. **Deterministic evidence over narrative.** Commands the extension runs itself (tests, builds) are reported to reviewers with reliable exit codes, and a failing command blocks the gate.
5. **A gate that means something.** The run's final status comes from the final verdict and checks, not from the last stage merely finishing.
6. **Checkpoint synchronization.** Agents share compact stage artifacts, not hidden reasoning or a mirrored transcript. Claude continues its own session within a run, so it is not sent its own earlier output again.
7. **Subscription-safe defaults.** Agents receive an allowlisted environment. API-key, auth-token, alternate-endpoint, and Bedrock/Vertex routing variables are removed unless you explicitly choose environment billing.
8. **Bounded autonomy.** Timeouts, cancellation of the whole process tree, finite stages and fix rounds, minimal permissions, plan approval, and explicit consent are enforced outside prompts.
9. **Private local state.** Run records and worktrees stay in VS Code's private workspace storage unless you export a report or apply changes.

## Architecture

```text
VS Code: activity bar ─ Runs view · Agents view · status bar · output channel · diff editor
          |
          v
extension.ts (commands, prompts, consent, apply/discard)
          |
          v
Workflow orchestrator ──── private run history / exported report
  |    |    |    |
  |    |    |    +── isolated Git worktree (create, list, apply, remove)
  |    |    +─────── check runner (your setup and verification commands)
  |    +──────────── Git snapshot and bounded context builder
  +───────────────── gate, fix rounds, approval, fallback, resume
          |
     +----+----+
     |         |
     v         v
Claude CLI   Codex CLI
stream-json  JSONL events
```

The extension host is the coordinator. No background service, shared API key, or separate database is required. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Capabilities

- **Native VS Code interface:** Runs and Agents tree views in the activity bar, a welcome view, status bar progress, an output channel, Command Palette commands, and read-only documents for every stage output, check log, and report.
- Claude-led seven-stage implementation workflow and five-stage brainstorming workflow.
- Independent Codex plan, code, and final reviews with a parsed verdict and findings by severity.
- Final gate with bounded fix rounds and a "completed with unresolved findings" outcome.
- Setup and verification commands run by the extension itself, with results given to reviewers.
- Isolated Git worktree per implementation run, reviewed in VS Code's multi-file diff editor and applied with a conflict check.
- Optional plan approval, with guidance you can add for the rest of the run.
- Claude session continuity within a run, with automatic fallback to a new session.
- Resume a failed, cancelled, or interrupted run from its first unfinished stage.
- Multi-root workspaces: choose which folder the agents work in.
- Quota, timeout, and provider-unavailable fallback, classified from provider-reported errors.
- Cancellation and per-stage timeouts that terminate the agent's whole process tree.
- Cross-agent prompt-injection boundary with random per-prompt block boundaries.
- Visible run warnings when Git or repository configuration weakens a run.
- Private, capped, durable run history; runs with unapplied changes are never pruned.
- Markdown run-report export.
- Executables (agent CLIs, Git, and your commands) resolved to absolute paths, never from the workspace or worktree.
- Git runs with hooks, filesystem monitors, external diff, and textconv drivers disabled.
- Allowlisted child-process environment; subscription mode removes billing variables.
- All settings machine-scoped, so a repository cannot change them.

## Requirements

- Desktop VS Code 1.105 or newer.
- Node.js 20 or newer for development.
- A local Git repository with at least one commit (for implementation runs).
- Codex CLI installed and signed in.
- Claude Code CLI installed and signed in.

Confirm the tools manually:

```powershell
codex --version
claude.cmd --version
codex login status
```

On Windows with a restrictive PowerShell execution policy, use `claude.cmd` instead of the `claude.ps1` shim. The extension starts processes directly rather than through PowerShell.

## Install

Build and install the extension package:

```powershell
cd F:\Works\Projects\16-dual-agent-vscode-orchestrator
npm.cmd install
npm.cmd run package
code --install-extension .\dual-agent-orchestrator-2.0.0.vsix
```

Then reload VS Code and select the **Dual Agent** icon in the activity bar.

To work on the extension itself, open this folder in VS Code and press `F5`; an Extension Development Host window opens with the extension loaded. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Use

1. Open a local Git repository and trust the workspace. The extension does not run in Restricted Mode.
2. Select the **Dual Agent** icon in the activity bar. Expand **Agents** to confirm Claude Code, Codex, and Git are ready, or run **Dual Agent: Check Agent Setup**.
3. Start a run with the ▶ (implementation) or 💡 (brainstorming) button in the **Runs** view title, its welcome links, or the Command Palette (**Dual Agent: Start Implementation Run**).
4. Type the objective, or select a longer brief in any editor first and choose **Use the selected text**. In a multi-root workspace, choose the folder.
5. For implementation, read the consent dialog. It says where agents edit, whether you approve the plan, and which commands the extension will run, then choose **Allow and Start**.
6. Watch progress in the **Runs** view and the status bar. Click any stage to open its full output; expand an editing stage to see its check results. **Dual Agent: Show Output** shows live agent activity.
7. When the plan is ready, the status bar asks for approval. Choose **Review Plan** to open Claude's plan beside Codex's review, then **Approve**, **Approve with Guidance…**, or **Reject**.
8. When the run ends, choose **Review Changes** to open every changed file in the diff editor, then **Apply Changes** to write them to your working tree (nothing is staged or committed) or **Discard Changes**.
9. Review the diff in Source Control before committing. Right-click a run for its report, export, or the worktree folder.

A failed or cancelled run, including one interrupted by closing VS Code, can be continued with **Resume Run** from its first unfinished stage.

## Configuration

| Setting | Default | Purpose |
|---|---:|---|
| `dualAgent.codex.command` | `codex` | Codex command name on PATH, or an absolute path |
| `dualAgent.claude.command` | `claude` | Claude Code command name on PATH, or an absolute path |
| `dualAgent.billingMode` | `subscription` | Strip billing variables or pass environment billing through |
| `dualAgent.timeoutMinutes` | `30` | Maximum duration of each stage |
| `dualAgent.claude.maxTurns` | `24` | Claude agentic-turn ceiling per stage |
| `dualAgent.claude.model` | empty | Use account/CLI default unless explicitly set |
| `dualAgent.codex.model` | empty | Use account/CLI default unless explicitly set |
| `dualAgent.claude.allowedTools` | empty | Claude permission rules, such as `Bash(npm test:*)`, granted to write stages only |
| `dualAgent.claude.resumeSessions` | `true` | Continue Claude's session across its stages in a run |
| `dualAgent.context.maxCharacters` | `90000` | Maximum normalized context for a stage |
| `dualAgent.fallbackOnQuota` | `true` | Allow bounded cross-provider fallback |
| `dualAgent.history.maxRuns` | `50` | Private workspace run-history cap |
| `dualAgent.environment.passthrough` | empty | Extra environment variable names passed to agents and commands |
| `dualAgent.isolation.mode` | `worktree` | Edit an isolated worktree (`worktree`) or the workspace directly (`none`) |
| `dualAgent.isolation.setupCommands` | empty | Commands run once in a new worktree, such as `[["npm", "ci"]]` |
| `dualAgent.verification.commands` | empty | Commands run after every editing stage, such as `[["npm", "test"]]` |
| `dualAgent.verification.timeoutMinutes` | `10` | Maximum duration of each setup or verification command |
| `dualAgent.workflow.maxFixRounds` | `1` | Fix rounds after a failing final gate (0 to 3) |
| `dualAgent.workflow.approvePlan` | `true` | Pause for your approval before the first editing stage |

Every setting is machine-scoped and read only from user settings, so a cloned repository's `.vscode/settings.json` cannot change executables, billing, commands, limits, or fallback. Numeric values are clamped to their documented ranges, and invalid model names, tool rules, and commands are ignored with a warning.

Commands are argument lists without a shell: `["npx", "vitest", "run"]`, not `"npx vitest run"`. Their executables, like the agent CLIs, are resolved to an absolute path from `PATH` and must not live inside the workspace or its worktree, so use `npm` or `npx` rather than `node_modules/.bin/...`. Windows normally runs a same-named program from the current folder first, so without this a repository could plant `codex.cmd`, `npm.cmd`, or `git.exe` and have it run instead of the real tool.

A worktree contains tracked files plus your uncommitted and untracked changes, but not ignored files such as `node_modules`, build output, or `.env`. If your checks need dependencies, add an install step to `dualAgent.isolation.setupCommands`. Setup and verification commands run repository code, including code the agents changed, with your permissions and outside any agent sandbox; the consent dialog lists them for every run.

Claude Code's print mode cannot ask for approval, so Claude cannot run shell commands such as tests unless `dualAgent.claude.allowedTools` allows them. Verification commands give reviewers reliable results either way.

## Billing and quota behavior

Agent processes and your commands receive only an allowlisted environment: `PATH`, home, profile, and temp locations, locale, proxy and TLS settings, and the CLIs' own configuration directories. Tokens such as `GITHUB_TOKEN`, cloud credentials, and SSH agent sockets are not passed unless listed in `dualAgent.environment.passthrough`.

In the default `subscription` mode, billing variables are removed even when listed there: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, and `AZURE_OPENAI_API_KEY`. Matching ignores case on Windows. The CLIs therefore use their saved interactive sign-ins.

The displayed numbers are observations from provider events, useful for comparing workload distribution but not authoritative subscription balances.

If a stage fails with a recognized quota, availability, or timeout condition and fallback is enabled, the other agent attempts that stage once with a fresh Git snapshot. The condition is classified from the provider's structured error or the process's stderr, never from the agent's output stream. Authentication errors, invalid requests, policy failures, and unknown failures are not rerouted. Tokens spent by a failed attempt still count.

Continuing Claude's session saves tokens: later Claude stages receive only what is new, not their own earlier output. Fix rounds add stages, so a failing gate costs more quota; set `dualAgent.workflow.maxFixRounds` to `0` to disable them.

## Security model

- The extension never reads `~/.codex/auth.json`, Claude credential files, cookies, or OAuth tokens.
- Authentication is owned by the official installed CLIs.
- API keys are removed by default rather than persisted.
- Agent CLIs, Git, and your commands are resolved to absolute paths and never taken from the workspace or worktree.
- All settings are machine-scoped and read from user settings only; the extension runs only in trusted workspaces.
- Agents and commands receive an allowlisted environment.
- Claude stages load only the user's own Claude settings (`--setting-sources user`) and no MCP servers (`--strict-mcp-config`). The extension warns when a repository contains Codex project configuration.
- Every Git command the extension runs disables hooks, filesystem monitors, external diff, and textconv drivers.
- Implementation runs edit an isolated worktree; changes reach your working tree only when you apply them, after a conflict check.
- Prior model output, repository text, diffs, and check logs are fenced with random per-prompt boundaries, and the stage contract is restated after them.
- Implementation and every resume require explicit consent; plan approval is on by default.
- Codex review stages use its read-only sandbox; Claude review stages use plan permission mode.
- UI text from agents is shown in tree items, plain-text tooltips with Markdown escaped, and read-only documents; nothing from a run is rendered as HTML or trusted Markdown.
- No network server is opened.

Read [docs/SECURITY.md](docs/SECURITY.md) before enabling environment billing, verification commands, or distributing the extension.

## Failure and recovery semantics

- Every stage is persisted before and after execution.
- A stage has one assigned provider and at most one fallback attempt.
- Cancellation and timeouts terminate the agent's whole process tree (`taskkill /T` on Windows, the process group elsewhere) and mark later stages skipped.
- Runs that were active when VS Code closed are marked cancelled on the next start and can be resumed.
- **Resume Run** keeps completed stages, their outputs, and an earlier plan approval, and asks for consent again.
- A failed run remains exportable and inspectable, and its worktree is kept so its partial changes can be reviewed.
- A new run cannot start while another is active, and a storage failure never leaves a run stuck as active.
- A corrupted run-history file is set aside as `runs.json.unreadable-<time>` instead of blocking new runs.

## Repository map

```text
src/
  adapters/       CLI execution, provider event parsing, environment, check runner
  core/           workflows, orchestration, gate, context, Git, worktrees, state, reports
  ui/             tree views, documents, approvals, status bar, presentation
  config.ts       validated extension settings
  extension.ts    activation, commands, and composition root
media/            activity-bar icon
test/             unit and integration tests; test/smoke runs inside VS Code
docs/             architecture, workflows, security, operations, decisions
scripts/          extension bundle and VS Code smoke test
```

## Quality gates

`npm run check` executes:

1. ESLint with type-aware TypeScript rules.
2. Strict TypeScript checking.
3. Vitest unit and integration tests with coverage thresholds.
4. esbuild production bundling.

`npm run smoke` launches an installed VS Code with a temporary profile and completes a run against fake CLIs inside the real extension host. CI repeats the checks on Windows and Linux and packages the VSIX. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Known limitations

- Desktop VS Code only; web extensions cannot launch local CLIs.
- Subscription limits are estimated from events, not pooled or transferred.
- Full reciprocal workflows intentionally use more quota than a single-agent run.
- CLI event formats can evolve; unknown events are tolerated, but provider changes may require parser updates.
- The verdict is model output. It decides fix rounds and the run's label, never permissions, and a reviewer can be wrong.
- Codex stages always start a fresh session: Codex's `exec resume` flags could not be verified, and fresh sessions keep reviews independent.
- Worktrees do not contain ignored files or initialized submodules.
- Claude read-only enforcement depends on its plan permission mode. Project settings and MCP servers are excluded, but your user-level Claude hooks and managed policies still apply, and user-level MCP servers are disabled during runs.
- Codex applies its own project configuration according to its trust settings; the extension warns about a `.codex` folder but cannot disable it.
- Untracked file contents are included for at most 40 small text files; files whose names suggest secrets are never read into prompts or copied into worktrees.
- Automated tests use fake agents; they do not consume live model quota.

## Documentation index

- [Project status and progress](PROJECT_STATUS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Workflow contracts](docs/WORKFLOWS.md)
- [Security and threat model](docs/SECURITY.md)
- [Development and testing](docs/DEVELOPMENT.md)
- [Operations and troubleshooting](docs/OPERATIONS.md)
- [Roadmap](docs/ROADMAP.md)
- [Architecture decisions](docs/adr/README.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Upstream integration references

- [Official OpenAI Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Official OpenAI Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [VS Code Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view)

## License

MIT. See [LICENSE](LICENSE).
