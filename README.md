# Dual Agent Orchestrator for VS Code

> Claude-led implementation, Codex-led review, reciprocal verification, and deterministic quality gates in one local VS Code workflow.

## Project status

- **Release:** 1.0.0
- **Lifecycle:** production-oriented local release
- **Last updated:** 2026-10-27
- **Implementation:** complete
**Verification:** type checking and unit tests are implemented; see [PROJECT_STATUS.md](PROJECT_STATUS.md) for the current verified results and known limitations.

This project is a desktop VS Code extension that coordinates the locally installed Claude Code and Codex CLIs. It is designed for developers who have subscriptions for both products and want them to work as a disciplined pair without copying credentials, merging private reasoning, or allowing two agents to overwrite the same files simultaneously.

The extension does not merge subscription quotas. It observes the usage events each CLI reports, keeps a local ledger, routes bounded fallback work when a provider is unavailable, and preserves an auditable record of every stage.

## The complete idea in one minute

For implementation work, Claude leads and Codex reviews:

```text
Claude plan
    -> Codex plan review
    -> Claude reconciliation and implementation
    -> Codex independent code review
    -> Claude finding adjudication and fixes
    -> Codex final verification
    -> Claude final bounded repair and completion report
```

For brainstorming, the same reciprocal pattern stays read-only:

```text
Claude proposal
    -> Codex challenge
    -> Claude synthesis
    -> Codex final challenge
    -> Claude final recommendation
```

Each stage receives the objective, current Git status and diff, and compact outputs from completed stages. Previous agent output is explicitly treated as untrusted evidence rather than instruction. Only implementation/fix stage contracts receive workspace-write permission; Claude owns them normally, while a recorded best-effort fallback may assign Codex after an eligible operational failure. Normal Codex review stages remain read-only. A workflow stops on an unhandled failure, can be cancelled, and never retries forever.

## Why this exists

Running two coding agents independently creates avoidable problems:

- duplicated work consumes both subscriptions;
- the agents lose each other's decisions and test evidence;
- simultaneous edits conflict;
- review feedback is applied without adjudication;
- provider limits interrupt work without a clean handoff;
- chat history becomes the only state store;
- there is no durable record of what happened.

Dual Agent Orchestrator converts that ad-hoc interaction into a fixed, inspectable workflow with explicit roles, permissions, checkpoints, usage observations, fallback rules, and exportable reports.

## Design principles

1. **Roles before model preference.** Claude is the default implementation lead; Codex is the independent reviewer. Routing weights do not randomly change responsibilities.
2. **One writer at a time.** A stage has either read-only or workspace-write permission. Claude owns write stages by default, a fallback is always recorded, and the flow has no concurrent writers.
3. **Reciprocal review.** Codex reviews Claude's plan and code. Claude must accept, reject with a reason, or escalate Codex findings before fixing them.
4. **Repository truth over conversation.** Git status, the current diff, tests, and build results are stronger evidence than either model's narrative.
5. **Checkpoint synchronization.** Agents share compact stage artifacts, not hidden reasoning or an ever-growing mirrored transcript.
6. **Subscription-safe defaults.** API-key environment variables are stripped from child processes unless the user explicitly selects environment billing.
7. **Bounded autonomy.** Timeouts, cancellation, finite stages, minimal permissions, and explicit write consent are enforced outside prompts.
8. **Private local state.** Run records stay in VS Code's private workspace storage unless the user explicitly exports a Markdown report.

## Architecture

```text
VS Code activity-bar view
          |
          v
Dashboard controller -----> private run history / exported report
          |
          v
Workflow orchestrator
  |       |        |
  |       |        +---- Git snapshot and bounded context builder
  |       +------------- permission and fallback policy
  +--------------------- durable stage state and usage ledger
          |
     +----+----+
     |         |
     v         v
Claude CLI   Codex CLI
stream-json  JSONL events
```

The extension host is the coordinator. No background cloud service, shared API key, or separate database is required. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component and state details.

## Capabilities

- Dedicated VS Code activity-bar dashboard.
- Claude-led seven-stage implementation workflow.
- Claude-led five-stage brainstorming workflow.
- Independent Codex plan, code, and final reviews.
- Claude adjudication of every review pass.
- Read-only versus workspace-write enforcement at the CLI boundary.
- Explicit per-run write consent.
- Structured JSONL/stream-JSON parsing.
- Normalized token and reported-cost observations.
- Provider session/thread ID capture when emitted.
- Quota, timeout, and provider-unavailable fallback.
- Cancellation and per-stage timeouts.
- Git status, diff summary, and bounded diff context.
- Cross-agent prompt-injection boundary.
- Private, capped, durable run history.
- Markdown run-report export.
- Machine-scoped executable settings to prevent a repository replacing agent binaries.
- Subscription-only mode that removes API-key variables from child processes.
- Unit-tested orchestration, parsers, state, workflows, context, and reports.

## Requirements

- Desktop VS Code 1.105 or newer.
- Node.js 20 or newer for development.
- A local Git workspace.
- Codex CLI installed and signed in.
- Claude Code CLI installed and signed in.

Confirm the tools manually:

```powershell
codex --version
claude.cmd --version
codex login status
```

On Windows with a restrictive PowerShell execution policy, use `claude.cmd` instead of the `claude.ps1` shim. The extension uses process spawning rather than PowerShell, so the standard command shim is resolved independently.

## Install for development

```powershell
cd F:\Works\Projects\16-dual-agent-vscode-orchestrator
npm.cmd install
npm.cmd run check
```

Then open this folder in VS Code and press `F5`. A new Extension Development Host opens. Select the **Dual Agent** icon in the Activity Bar.

To create an installable package:

```powershell
npm.cmd run package
code --install-extension .\dual-agent-orchestrator-1.0.0.vsix
```

## Use

1. Open a local Git repository in VS Code.
2. Open the **Dual Agent** activity-bar view.
3. Click **Check** and confirm both CLIs are available.
4. Choose **Implementation** or **Brainstorming**.
5. Write an outcome-oriented objective with constraints and acceptance criteria.
6. For implementation, explicitly enable workspace edits.
7. Start the workflow and watch each stage progress.
8. Review the Git diff and exported report before committing.

Implementation can also be started from the Command Palette with **Dual Agent: Run Implementation Workflow**. Command-palette execution uses a modal write-consent confirmation.

## Configuration

| Setting | Default | Purpose |
|---|---:|---|
| `dualAgent.codex.command` | `codex` | Machine-scoped Codex executable/path |
| `dualAgent.claude.command` | `claude` | Machine-scoped Claude executable/path |
| `dualAgent.billingMode` | `subscription` | Strip API keys or pass environment billing through |
| `dualAgent.timeoutMinutes` | `30` | Maximum duration of each stage |
| `dualAgent.claude.maxTurns` | `24` | Claude agentic-turn ceiling per stage |
| `dualAgent.claude.model` | empty | Use account/CLI default unless explicitly set |
| `dualAgent.codex.model` | empty | Use account/CLI default unless explicitly set |
| `dualAgent.context.maxCharacters` | `90000` | Maximum normalized context for a stage |
| `dualAgent.fallbackOnQuota` | `true` | Allow bounded cross-provider fallback |
| `dualAgent.history.maxRuns` | `50` | Private workspace run-history cap |

Executable and billing settings are machine-scoped. A cloned repository cannot silently change them through workspace settings.

## Billing and quota behavior

In the default `subscription` mode, the extension removes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CODEX_API_KEY` from each child process. The CLIs therefore use their saved interactive sign-ins rather than accidentally preferring environment API keys.

The displayed numbers are observations from provider events. They are useful for comparing workload distribution but are not authoritative remaining-subscription balances. Provider limits can depend on model, context, rolling windows, policy, and workload complexity.

If a stage fails with a recognized quota, availability, or timeout condition and fallback is enabled, the other agent attempts that stage once. Authentication errors, invalid requests, policy failures, and unknown deterministic failures are not silently rerouted.

## Security model

- The extension never reads `~/.codex/auth.json`, Claude credential files, cookies, or OAuth tokens.
- Authentication is owned by the official installed CLIs.
- API keys are removed by default rather than persisted.
- The webview uses a restrictive Content Security Policy and loads only packaged local assets.
- Agent executable settings are machine-scoped.
- Prior model output, repository text, diffs, and logs are marked untrusted inside handoff prompts.
- Implementation requires explicit write consent for every run.
- Codex review stages use its read-only sandbox; an eligible fallback inherits the failed stage's explicit permission and is recorded.
- Claude review stages use plan permission mode; write stages use accept-edits mode.
- No network server is opened by this release.

Read [docs/SECURITY.md](docs/SECURITY.md) before enabling environment billing or distributing the extension.

## Failure and recovery semantics

- Every stage is persisted before and after execution.
- A stage has one assigned provider and at most one fallback attempt.
- Cancellation terminates the active child process and marks later stages skipped.
- A failed run remains exportable and inspectable.
- The extension never retries invalid requests or authentication failures indefinitely.
- A new workflow cannot start while another is active.
- Provider outputs are evidence; Git and deterministic checks remain the source of truth.

This release records provider session identifiers but deliberately uses explicit checkpoint prompts between providers. Automatic mid-stage resume is reserved for the app-server integration described in [docs/ROADMAP.md](docs/ROADMAP.md).

## Repository map

```text
src/
  adapters/       CLI execution and provider event normalization
  core/           workflows, orchestration, context, state, usage, reports
  ui/             VS Code webview provider
  config.ts       validated extension settings
  extension.ts    activation, commands, and composition root
media/            CSP-restricted dashboard assets
test/             unit and orchestration tests
docs/             architecture, workflows, security, operations, decisions
scripts/          deterministic extension bundle
```

## Quality gates

`npm run check` executes:

1. ESLint with type-aware TypeScript rules.
2. Strict TypeScript checking.
3. Vitest unit tests with coverage thresholds.
4. esbuild production bundling.

CI repeats these checks on Windows and Linux and packages the VSIX artifact. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Known limitations

- Desktop VS Code only; web extensions cannot launch local CLIs.
- One workspace folder is used in a multi-root window.
- Subscription limits are estimated from events, not pooled or transferred.
- Full reciprocal workflows intentionally use more quota than a single-agent run.
- CLI event formats can evolve; unknown events are tolerated, but provider changes may require parser updates.
- Claude read-only enforcement depends on its documented plan permission mode; review the tool's own configured hooks and managed policies.
- The extension coordinates agents sequentially. Parallel isolated Git worktrees are not enabled in this release.
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
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)

## License

MIT. See [LICENSE](LICENSE).
