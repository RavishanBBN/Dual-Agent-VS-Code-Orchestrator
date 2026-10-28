# Dual Agent Orchestrator

**Claude answers. Codex checks the answer.** A chat for VS Code in which two coding agents work as a disciplined pair: one does the work, the other independently verifies it, and you see both. It drives the Claude Code and Codex CLIs you already have, with their own sign-in.

![The chat in the secondary side bar: Claude reads the code and answers, Codex checks the answer and agrees](media/screenshots/chat-dark.png)

## Why two agents

One agent can sound right and be wrong. Here every answer gets a second opinion before you rely on it:

- **Chat:** Claude answers with read-only tools, then Codex checks the answer against the code. If Codex finds a material problem, Claude revises, and you see both.
- **Research:** Claude searches the web and cites what it read. Codex opens every source to confirm it exists and supports the claim, then looks for work Claude missed or that contradicts it.
- **Edit:** Claude edits an isolated copy of your repository and runs your tests. Codex reviews the diff, and Claude fixes what it finds. Nothing reaches your files until you apply the change.

![An edit in an isolated copy: the tests pass, Codex approves, and the changes card offers Review all, Apply, and Discard](media/screenshots/edit-light.png)

## Quick start

1. Install [Claude Code](https://code.claude.com/docs/en/setup) and the [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), and sign in to both (`claude`, then `codex login`).
2. Install this extension, open a folder, and trust it.
3. Press **Ctrl+Alt+D** (**Cmd+Alt+D** on macOS) to open the chat in the secondary side bar.
4. Run **Dual Agent: Check Agent Setup** if anything looks wrong. The **Get started** walkthrough covers the rest.

## Modes

Choose a mode in the composer for each message.

| Mode | What happens | Agent calls | Your files |
|---|---|---|---|
| **Chat** | Claude answers → Codex checks → Claude revises only if needed | 2–3 | read-only |
| **Research** | Claude researches with cited sources → Codex verifies every source and searches for what is missing | 2–3 | read-only |
| **Edit** | Claude edits a copy and runs your checks → Codex reviews the diff → bounded fix rounds | 2–4 | applied by you |
| **Brainstorm** | Proposal → challenge → synthesis → final challenge → recommendation | 5 | read-only |
| **Implement** | Plan → review → **your approval** → implement → review → fix → final gate → report | 7+ | applied by you |

Follow-up messages continue the conversation. Claude resumes its own session, so it is sent only what is new. Codex starts fresh on every message with a summary, so its checks stay independent.

## Features

- **A chat like Claude Code's.** Streamed answers, a timeline of every tool call with its input and output, Codex's verdict as a badge, Markdown with code blocks you can copy, and file references that open at the right line.
- **Attachments.** Paste, drop, or pick images, PDFs, ZIP archives, Word, Excel, and PowerPoint files, notebooks, and any text or code. Type `@` to mention a workspace file.
- **Models and effort per agent.** Pick each agent's model and reasoning effort from the composer, or leave them on the CLI default. The Codex list comes from your installed CLI.
- **Web access when you want it.** Research mode always uses the web. The **Web** toggle enables it for one message in any other mode.
- **Reviews that mean something.** A finding of medium severity or higher makes Claude revise. Low-severity notes are shown without another call. A failing test blocks the gate.
- **Isolated edits.** Edits happen in a Git worktree in private storage. Review them in VS Code's multi-file diff editor, then apply them (checked with `git apply --check`; nothing is staged or committed) or discard them.
- **Token usage you can see.** Every stage and message shows its tokens. The chart button shows totals for the conversation, today, the last 7 days, and all time.

  ![Token usage by agent for this conversation, today, the last 7 days, and all time](media/screenshots/usage-dark.png)

- **Lean prompts.** Chat and Research get a workspace summary and read only the files they need. Each reviewer sees the steps the previous agent took, so it checks specific claims instead of exploring again.
- **Queue messages.** Type the next message while one runs; it waits in a queue you can edit, and runs when the current one finishes.
- **Retry or edit any message.** Run an earlier message again, or change it first. The messages after it are removed, and their file changes in the isolated copy are undone from a checkpoint.
- **Resume anything.** A failed, cancelled, or interrupted message continues from its first unfinished stage.

## When a usage limit is hit

Work keeps going when one subscription runs out:

1. **One agent at its limit.** The other agent does its stages too, marked as standing in, so the conversation continues. The extension reads when the limit resets from the provider's message.
2. **The limit resets.** The agent rejoins on its own. Claude is given the messages it missed, so it picks up where the conversation is.
3. **Both agents at their limits.** The message pauses with the reset time, then continues by itself a minute after the first reset, from the stage where it stopped. Queued messages follow. **Continue now** and **Do not continue** are on the card.

![Claude at its usage limit: Codex answers alone and checks its answer, while the next message waits in the queue](media/screenshots/solo-dark.png)

A stand-in that checks its own answer is not an independent check, and the timeline says so. Turn off `dualAgent.fallbackOnQuota` to wait for the limited agent instead, or `dualAgent.limits.autoContinue` to continue paused work only by hand.

## Privacy and security

This extension runs local programs that can read your code, so its safety rules are enforced in code, not in prompts.

- **Your sign-in stays with the CLIs.** The extension never reads credential files. By default it removes API keys and alternate endpoints from the agents' environment, so you are not billed per token by accident.
- **Only an allowlisted environment** reaches the agents: `PATH`, home and temp folders, locale, and proxy settings. Tokens such as `GITHUB_TOKEN` and cloud credentials are withheld.
- **Secrets are masked in prompts.** API keys, tokens, and private keys (AWS, GitHub, OpenAI, Anthropic, Google, Slack, Stripe, npm, Azure, JWTs, PEM keys) in the diffs, files, attachments, history, and check output the extension sends are replaced with `[redacted …]`. The same applies to the output log and exported reports. Files whose names suggest secrets, such as `.env`, are never read into prompts.
- **Read-only means read-only.** Reviewers and Chat answers get only file-reading tools: no shell, no writes, no web unless you turn it on.
- **A repository cannot reconfigure the extension.** Every setting is machine-scoped. Executables are never taken from the workspace, Git runs with hooks disabled, and Claude loads only your user settings and no MCP servers.
- **Edits need your consent** on every message, and reach your files only when you apply them.
- **The chat page is locked down.** A strict Content-Security-Policy with Trusted Types: nothing loads from the network, only the bundled script runs, and agent text never becomes HTML.
- **No telemetry.** Conversations, attachments, and run records stay in VS Code's private storage. **Dual Agent: Delete All History** removes them for the workspace.

What each agent receives is governed by Anthropic's and OpenAI's own account terms. See the [threat model](docs/SECURITY.md) for every control and its residual risk.

## Requirements

- Desktop VS Code 1.105 or newer. Web and virtual workspaces are not supported, because the agents need a local file system.
- Claude Code, recent enough for `--tools`, `--effort`, and `--include-partial-messages` (verified with 2.1.312), and the Codex CLI, both signed in.
- A Git repository with at least one commit for Edit and Implement. Chat, Research, and Brainstorm work in any folder.

On Windows with a restrictive PowerShell execution policy, the extension still works: it starts the CLIs directly, not through PowerShell.

## Settings

All settings are in your **user** settings; a repository's `.vscode/settings.json` cannot change them.

| Setting | Default | Purpose |
|---|---:|---|
| `dualAgent.verification.commands` | empty | Your checks, run after every edit, such as `[["npm", "test"]]` |
| `dualAgent.isolation.setupCommands` | empty | Run once in a new worktree, such as `[["npm", "ci"]]` |
| `dualAgent.claude.model`, `dualAgent.codex.model` | empty | Default models; the composer can override them per message |
| `dualAgent.claude.effort`, `dualAgent.codex.effort` | empty | Default reasoning effort |
| `dualAgent.billingMode` | `subscription` | `environment` passes API keys through, which may incur API charges |
| `dualAgent.privacy.redactSecrets` | `true` | Mask credentials in prompts, logs, and exported reports |
| `dualAgent.fallbackOnQuota` | `true` | Let the other agent work alone while one is at its usage limit |
| `dualAgent.limits.autoContinue` | `true` | Continue paused work once the usage limits reset |
| `dualAgent.workflow.maxFixRounds` | `1` | Fix rounds after a failing final gate (0–3) |
| `dualAgent.workflow.approvePlan` | `true` | Pause Implement runs for your approval before any edit |
| `dualAgent.isolation.mode` | `worktree` | `none` edits the workspace directly |
| `dualAgent.claude.allowedTools` | empty | Extra Claude permission rules for editing stages, such as `Bash(npm run lint:*)` |
| `dualAgent.environment.passthrough` | empty | Extra environment variable names for the agents |
| `dualAgent.timeoutMinutes` | `30` | Maximum duration of one stage |

Commands are argument lists, run without a shell, and resolved from `PATH`: `["npx", "vitest", "run"]`, not `"npx vitest run"`. They run code the agents changed, with your permissions, so they are listed in the consent card. The [operations guide](docs/OPERATIONS.md) covers every setting and troubleshooting.

## Usage and limits

Token counts come from what each CLI reports; neither CLI reports how much of your plan remains, so the extension learns about a limit only when an agent reports reaching it. Checking every answer costs more than one agent alone: expect two to three agent calls per chat message. Fix rounds add calls when a check fails; set `dualAgent.workflow.maxFixRounds` to `0` to turn them off. A retried message starts fresh sessions, so it costs more than a follow-up.

## Known limitations

- The verdict is model output. It decides revisions and the run's label, never permissions, and a reviewer can be wrong.
- Claude's tool limits are enforced by Claude Code itself, not an operating-system sandbox. Your user-level Claude hooks still apply.
- Codex reads the text the extension extracts from PDFs and Office files. Scanned PDFs without a text layer give Codex no text, though Claude still reads the pages.
- Attachments: 25 MB per file, 100 MB and 20 files per message.
- Worktrees do not contain ignored files such as `node_modules`; use `dualAgent.isolation.setupCommands` to install dependencies.
- CLI event formats evolve. Unknown events are tolerated, but a provider change can need an update.

## Learn more

- [Workflows and stage contracts](docs/WORKFLOWS.md)
- [Security and threat model](docs/SECURITY.md)
- [Operations and troubleshooting](docs/OPERATIONS.md)
- [Architecture](docs/ARCHITECTURE.md) and [decisions](docs/adr/README.md)
- [Development, testing, and releasing](docs/DEVELOPMENT.md)
- [Changelog](CHANGELOG.md) · [Project status](PROJECT_STATUS.md) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

To build from source: `npm ci`, then `npm run package`, then install the `.vsix` with **Extensions: Install from VSIX…**.

## Disclaimer

This is an independent project, not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic. Codex is a trademark of OpenAI. You need your own accounts with both, and their terms apply to everything the agents receive.

## License

MIT. See [LICENSE](LICENSE).
