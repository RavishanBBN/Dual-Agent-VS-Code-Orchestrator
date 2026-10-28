# Dual Agent Orchestrator for VS Code

> A Claude Code–style chat in which Claude answers and Codex checks the answer, plus reciprocal brainstorming and implementation workflows with isolated edits, verification gates, and subscription-safe execution.

## Project status

- **Release:** 2.2.0 (Research mode with web access and source checking, leaner context, and first-shot edits; see [CHANGELOG.md](CHANGELOG.md))
- **Lifecycle:** production-oriented local release
- **Last updated:** 2026-10-28
- **Implementation:** complete
- **Verification:** lint, type checking, unit and integration tests, an automated smoke test inside a real VS Code, and a live check with the real CLIs; see [PROJECT_STATUS.md](PROJECT_STATUS.md) for the verified results and known limitations.

This project is a desktop VS Code extension that coordinates the locally installed Claude Code and Codex CLIs. It is designed for developers who have subscriptions for both products and want them to work as a disciplined pair, so that the result is better than either agent alone, without copying credentials or letting two agents overwrite the same files.

You talk to it in a chat panel like Claude Code's. Behind each message, Claude does the work and Codex independently checks it; when Codex finds a real problem, Claude corrects the answer before you rely on it. Larger tasks use fixed multi-stage workflows with plan approval and a final gate. Edits always happen in an isolated copy of the repository that you review in VS Code's diff editor and apply deliberately.

The extension does not merge subscription quotas. It observes the usage events each CLI reports, keeps a local ledger, routes bounded fallback work when a provider is unavailable, and keeps an auditable record of every stage.

## The complete idea in one minute

Every chat message runs in one of four modes, chosen in the composer:

| Mode | What happens | Agent calls | Files |
|---|---|---|---|
| **Chat** (default) | Claude answers → Codex checks the answer → Claude revises only if the check fails | 2–3 | read-only |
| **Research** | Claude researches on the web with cited sources → Codex opens every source and looks for missing or contrary work → Claude revises if needed | 2–3 | read-only, web on |
| **Edit** | Claude edits an isolated copy → your checks run → Codex reviews the diff → bounded fix rounds | 2–4 | isolated copy, applied by you |
| **Brainstorm** | Claude proposal → Codex challenge → Claude synthesis → Codex final challenge → Claude recommendation | 5 | read-only |
| **Implement** | the full implementation workflow below, with your approval of the plan | 7+ | isolated copy, applied by you |

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

## Quality and token use

The workflows are built for answers you can rely on, without paying for the same work twice:

- **Independent checking.** Codex checks every Chat and Research answer and reviews every edit. A finding of medium severity or higher makes Claude revise; low-severity notes are shown without another call.
- **Sources that hold up.** In Research, Claude reads every source before citing it, and Codex opens each one to confirm it exists and supports its claim, and searches for what was missed. Both reason at high effort unless you choose otherwise.
- **Targeted reviews.** Each reviewer sees the previous agent's steps (files read, searches, commands), so it checks specific claims and looks at what was not examined instead of re-exploring.
- **Lean context.** Chat, Research, and Brainstorm get a summary of the workspace and read the files they need. Every agent step re-reads its prompt, so this saves tokens on every step. Reviews of edits still get the full diff.
- **Right the first time.** In Edit and Implement, Claude may run your configured test commands while it works, and if the checks still fail, it repairs once before Codex reviews.

**Web access.** Research mode always uses the web. In other modes, the **Web** toggle in the composer lets the agents search and read pages for that message. Search terms and page requests leave your machine, and page content is treated as untrusted.

Follow-up messages continue the conversation. Claude continues its own session, so it is sent only what is new; Codex starts fresh on every message, with a summary of the conversation, so its checks stay independent. Edit messages in one conversation keep working on the same isolated copy until you apply or discard it.

Each stage receives the message or objective, the conversation so far, the attachments, the current Git status and diff, the latest check results, and bounded outputs from earlier stages. Agent output, attachments, and repository content are fenced in blocks marked with a random per-prompt boundary and treated as untrusted evidence, not instruction. Only editing stages can write, and only with your explicit consent. Reviewers end with a machine-readable verdict, shown in the chat as a badge.

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

Dual Agent Orchestrator turns that ad-hoc interaction into a conversation backed by fixed, inspectable workflows with explicit roles, permissions, checkpoints, gates, usage observations, fallback rules, and exportable reports.

## Design principles

1. **Roles before model preference.** Claude is the default lead; Codex is the independent checker and reviewer.
2. **One writer at a time, in isolation.** A stage is read-only or workspace-write, stages run one after another, and edits happen in an isolated worktree that you apply deliberately.
3. **Reciprocal review.** Codex checks Claude's answers, plans, and code. Claude must weigh each finding, accepting it or saying why not.
4. **Deterministic evidence over narrative.** Commands the extension runs itself (tests, builds) are reported to reviewers with reliable exit codes, and a failing command blocks the gate.
5. **A gate that means something.** A run's final status comes from the final verdict and checks, not from the last stage merely finishing.
6. **Checkpoint synchronization.** Agents share compact stage artifacts, not hidden reasoning or a mirrored transcript.
7. **Subscription-safe defaults.** Agents receive an allowlisted environment. API-key, auth-token, alternate-endpoint, and Bedrock/Vertex routing variables are removed unless you explicitly choose environment billing.
8. **Bounded autonomy.** Timeouts, cancellation of the whole process tree, finite stages and fix rounds, explicit tool allowlists, plan approval, and explicit consent are enforced outside prompts.
9. **Private local state.** Conversations, attachments, run records, and worktrees stay in VS Code's private workspace storage unless you export a report or apply changes.

## Architecture

```text
VS Code: Chat (webview, right side bar) · Runs and Agents views (activity bar) · status bar · diff editor
          |
          v
extension.ts ── chat controller (conversations, attachments, consent, models)
          |
          v
Workflow orchestrator ──── private run history / conversations / exported report
  |    |    |    |    |
  |    |    |    |    +── attachments (stored privately, archives unpacked, PDF and Office text extracted)
  |    |    |    +─────── isolated Git worktree (create, list, apply, remove)
  |    |    +──────────── check runner (your setup and verification commands)
  |    +───────────────── Git snapshot and bounded context builder
  +────────────────────── chat check, gate, fix rounds, approval, fallback, resume
          |
     +----+----+
     |         |
     v         v
Claude CLI   Codex CLI
stream-json  JSONL events
```

The extension host is the coordinator. No background service, shared API key, or separate database is required. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Capabilities

- **Chat panel like Claude Code's:** streamed answers, a timeline of each agent's steps (Read, Grep, Bash, Edit, Shell) with IN/OUT boxes that stay after the message finishes, Codex's verdict as a badge, Markdown with tables and code blocks with a Copy button, file references that open at the right line, usage per message, and conversation history.
- **Attachments:** paste, drop, or pick images (PNG, JPEG, GIF, WebP), PDFs, ZIP archives, Word, Excel, and PowerPoint files, Jupyter notebooks, and any text or code file; type `@` to mention a workspace file.
- **Models and effort:** choose each agent's model and reasoning effort in the composer, or leave either on the CLI default. The Codex list comes from your installed Codex CLI.
- **Quick edits:** Edit mode changes an isolated copy, checks it, has Codex review the diff, and shows a card to review, apply, or discard the changes.
- Claude-led seven-stage implementation workflow and five-stage brainstorming workflow, from the chat or the Command Palette.
- Independent Codex checks and reviews with a parsed verdict and findings by severity.
- Final gate with bounded fix rounds and a "completed with unresolved findings" outcome.
- Setup and verification commands run by the extension itself, with results given to reviewers.
- Isolated Git worktree, reviewed in VS Code's multi-file diff editor and applied with a conflict check.
- Optional plan approval, from a card in the chat, with guidance you can add for the rest of the run.
- Claude session continuity across stages and messages, with automatic fallback to a new session.
- Resume a failed, cancelled, or interrupted message or run from its first unfinished stage.
- Native Runs and Agents views, status bar progress, an output channel, and read-only documents for every stage output, check log, and report.
- Quota, timeout, and provider-unavailable fallback, classified from provider-reported errors.
- Cancellation and per-stage timeouts that terminate the agent's whole process tree.
- Cross-agent prompt-injection boundary with random per-prompt block boundaries.
- Private, capped, durable history; conversations and runs with unapplied changes are never pruned.
- Executables (agent CLIs, Git, and your commands) resolved to absolute paths, never from the workspace or worktree.
- Git runs with hooks, filesystem monitors, external diff, and textconv drivers disabled.
- Allowlisted child-process environment; subscription mode removes billing variables.
- All settings machine-scoped, so a repository cannot change them.

## Requirements

- Desktop VS Code 1.105 or newer.
- Node.js 20 or newer for development.
- Codex CLI installed and signed in.
- Claude Code CLI installed and signed in, recent enough to support `--tools`, `--effort`, and `--include-partial-messages` (verified with 2.1.312; an older version fails at the first Claude stage instead of running unrestricted).
- A local Git repository with at least one commit for Edit and Implement. Chat and Brainstorm also work in a folder without Git.

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
code --install-extension .\dual-agent-orchestrator-2.1.0.vsix --force
```

Then reload VS Code and press `Ctrl+Alt+D` to open the chat in the right-hand side bar.

To work on the extension itself, open this folder in VS Code and press `F5`; an Extension Development Host window opens with the extension loaded. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Use

1. Open a local folder and trust the workspace. The extension does not run in Restricted Mode.
2. Press `Ctrl+Alt+D`, or run **Dual Agent: Open Chat**. The chat opens in the right-hand side bar, where Claude Code's panel opens; if the right side bar is hidden, **Ctrl+Alt+B** toggles it. The **Dual Agent** icon in the activity bar on the left holds the **Runs** and **Agents** views. To use the chat as an editor tab instead, like Claude Code, click the chat button in any editor's title bar or run **Dual Agent: Open Chat in Editor**; the tab is named after the conversation. Expand **Agents** to confirm Claude Code, Codex, and Git are ready.
3. Type a message. Enter sends; Shift+Enter starts a new line. Attach files with the paperclip, by pasting, or by dropping them on the composer, and type `@` to mention a workspace file.
4. Choose the mode in the composer (**Chat**, **Edit**, **Brainstorm**, **Implement**). The sliders button chooses each agent's model and effort; **Default** leaves the choice to the CLI.
5. Watch the agents work on a timeline: Claude (orange) and Codex (blue) each get a node, text streams in, and every tool call appears with its IN and OUT, which you can click to expand. Codex's badge says whether it agrees. **Stop** cancels the message.
6. For Edit and Implement, a card asks you to allow edits and lists the commands the extension will run. Choose **Allow** for this message or **Allow for this conversation**.
7. In Implement mode, a card asks you to approve the plan: **Review plan** opens Claude's plan beside Codex's review, and you can add guidance before approving.
8. When an edit finishes, the changes card lists the changed files. Click a file for its diff, **Review all** for the multi-file diff editor, then **Apply…** to write the changes to your working tree (nothing is staged or committed) or **Discard…**.
9. Use the history button for earlier conversations and **New Conversation** to start fresh. Each message's **Report** opens the full record.

The Command Palette still has **Dual Agent: Start Implementation Run** and **Start Brainstorming Run**, which take an objective from an input box or the editor selection and show progress in the **Runs** view. A failed or cancelled message or run, including one interrupted by closing VS Code, can be continued with **Resume** from its first unfinished stage.

## Configuration

| Setting | Default | Purpose |
|---|---:|---|
| `dualAgent.codex.command` | `codex` | Codex command name on PATH, or an absolute path |
| `dualAgent.claude.command` | `claude` | Claude Code command name on PATH, or an absolute path |
| `dualAgent.billingMode` | `subscription` | Strip billing variables or pass environment billing through |
| `dualAgent.timeoutMinutes` | `30` | Maximum duration of each stage |
| `dualAgent.claude.maxTurns` | `24` | Claude agentic-turn ceiling per stage |
| `dualAgent.claude.model` | empty | Default Claude model; the chat composer can choose another per message |
| `dualAgent.claude.effort` | empty | Default Claude effort (`low` to `max`); empty uses the CLI default |
| `dualAgent.codex.model` | empty | Default Codex model; the chat composer can choose another per message |
| `dualAgent.codex.effort` | empty | Default Codex reasoning effort; empty uses the CLI default |
| `dualAgent.claude.allowedTools` | empty | Claude permission rules, such as `Bash(npm test:*)`, granted to write stages only |
| `dualAgent.claude.resumeSessions` | `true` | Continue Claude's session across its stages in a run |
| `dualAgent.context.maxCharacters` | `90000` | Maximum normalized context for a stage |
| `dualAgent.fallbackOnQuota` | `true` | Allow bounded cross-provider fallback |
| `dualAgent.history.maxRuns` | `100` | Private workspace run-history cap (conversations keep their answers when old runs are pruned) |
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

Each Claude stage gets an explicit tool list. Read-only stages can only read and search files. Write stages can also edit files, and get a shell or any other tool only when a rule in `dualAgent.claude.allowedTools` names it, so Claude cannot run tests without one. Verification commands give reviewers reliable results either way.

## Billing and quota behavior

Agent processes and your commands receive only an allowlisted environment: `PATH`, home, profile, and temp locations, locale, proxy and TLS settings, and the CLIs' own configuration directories. Tokens such as `GITHUB_TOKEN`, cloud credentials, and SSH agent sockets are not passed unless listed in `dualAgent.environment.passthrough`.

In the default `subscription` mode, billing variables are removed even when listed there: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, and `AZURE_OPENAI_API_KEY`. Matching ignores case on Windows. The CLIs therefore use their saved interactive sign-ins.

### Seeing token usage

- **Per step:** each Claude or Codex stage in the chat shows its tokens; hover for input, cached input, output, and reasoning.
- **Per message:** the footer line under a message ("Claude 31.4k · Codex 18.4k tokens") opens a table per agent, with the Claude CLI's API-equivalent cost estimate.
- **Overall:** the chart button in the chat's header shows the conversation's total; click it, or run **Dual Agent: Show Token Usage**, for this conversation, today, the last 7 days, and all runs in the workspace.
- **Per run:** hover a run in the **Runs** view, or open its report.

Input counts every input token, including cached input, for both agents. The numbers are observations from provider events, useful for comparing workload distribution but not authoritative subscription balances: neither CLI reports how much of your plan's limit remains.

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
- Edit and Implement work in an isolated worktree; changes reach your working tree only when you apply them, after a conflict check.
- Prior model output, earlier conversation turns, attachments, repository text, diffs, and check logs are fenced with random per-prompt boundaries, and the stage contract is restated after them.
- Every message or run that edits files, and every resume of one, requires explicit consent; plan approval is on by default.
- Codex review stages use its read-only sandbox. Claude review stages get only Claude's Read, Grep, and Glob tools, so they cannot run commands, write files, or fetch web pages.
- The chat is a webview with a strict Content-Security-Policy: nothing is loaded from the network, only its own bundled script runs, every message from it is validated, and agent Markdown is rendered with raw HTML escaped, images disabled, and links that open only after a check. Elsewhere, agent text appears in tree items, plain-text tooltips with Markdown escaped, and read-only documents.
- Attachments are stored in private storage, archives are unpacked with path, size, count, and compression-ratio limits, and PDFs are parsed in a worker thread with a timeout. Files whose names suggest secrets need an extra confirmation.
- No network server is opened.

Read [docs/SECURITY.md](docs/SECURITY.md) before enabling environment billing, verification commands, or distributing the extension.

## Failure and recovery semantics

- Every stage is persisted before and after execution.
- A stage has one assigned provider and at most one fallback attempt.
- Cancellation and timeouts terminate the agent's whole process tree (`taskkill /T` on Windows, the process group elsewhere) and mark later stages skipped.
- Runs that were active when VS Code closed are marked cancelled on the next start and can be resumed.
- **Resume** keeps completed stages, their outputs, and an earlier plan approval, and asks for consent again.
- A failed run remains exportable and inspectable, and its worktree is kept so its partial changes can be reviewed.
- A new run cannot start while another is active, and a storage failure never leaves a run stuck as active.
- A corrupted run-history file is set aside as `runs.json.unreadable-<time>` instead of blocking new runs.

## Repository map

```text
src/
  adapters/       CLI execution, provider event parsing, environment, check runner
  core/           workflows, orchestration, gate, context, conversations, attachments, Git, worktrees, state, reports
  ui/             tree views, documents, approvals, status bar, presentation
  ui/chat/        chat controller, webview host, message protocol, transcript
  webview/        the chat page (Preact), its Markdown renderer and styles
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

`npm run smoke` launches an installed VS Code with a temporary profile and, against fake CLIs inside the real extension host, completes a brainstorming run and a chat conversation with an attachment, a follow-up, and an edit. CI repeats the checks on Windows and Linux and packages the VSIX. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Known limitations

- Desktop VS Code only; web extensions cannot launch local CLIs.
- Subscription limits are estimated from events, not pooled or transferred.
- Full reciprocal workflows intentionally use more quota than a single-agent run.
- CLI event formats can evolve; unknown events are tolerated, but provider changes may require parser updates.
- The verdict is model output. It decides fix rounds and the run's label, never permissions, and a reviewer can be wrong.
- Codex stages always start a fresh session, so its checks stay independent; it gets the conversation as a summary instead.
- Codex cannot open PDFs or Office files itself; it reads the text the extension extracts. Scanned PDFs without a text layer yield no text for Codex, though Claude still reads their pages.
- Attachments are limited to 25 MB per file, 100 MB and 20 files per message; ZIP archives are unpacked up to 5,000 entries and 200 MB.
- Token-by-token streaming is shown for Claude only; Codex reports each step when it completes.
- Worktrees do not contain ignored files or initialized submodules.
- Claude's tool limits are enforced by Claude Code itself (its tool list and permission modes), not by an operating-system sandbox. Project settings and MCP servers are excluded, but your user-level Claude hooks and managed policies still apply, and user-level MCP servers are disabled during runs.
- Codex applies its own project configuration according to its trust settings; the extension warns about a `.codex` folder but cannot disable it.
- Untracked file contents are included for at most 40 small text files; files whose names suggest secrets are never read into prompts or copied into worktrees.
- Automated tests use fake agents; they do not consume live model quota. The live check is a separate, manual step (see PROJECT_STATUS.md).

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
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)

## License

MIT. See [LICENSE](LICENSE).
