# Roadmap

Release 2.0 delivered the native VS Code interface, the verification gate with bounded fix rounds, extension-run setup and verification commands, isolated worktrees with review and apply, plan approval, Claude session continuity, resuming runs, and multi-root folder selection. Release 2.1 added the chat panel with Chat and Edit modes, conversations, attachments, and model and effort pickers. Release 2.2 added Research mode and web access. Release 2.3 prepared Marketplace publishing, and added solo mode at usage limits, automatic continuation, the message queue, retry and edit with worktree checkpoints, and secret masking. Release 2.4 added Agent mode with permission prompts, editing folders without Git after a snapshot, the agents selector, Compare and Test first modes, slash commands, editor integration, per-file apply, the disagreement view, the subscription limits meter with handover before a limit, and the optional Gemini referee. Future work should deepen integration without weakening local safety.

## Planned candidates

### Chat

- streamed Codex text, through the app-server adapter below;
- dragging files from the VS Code Explorer onto the composer (today: paste, drop from the operating system, the paperclip, the folder button, or `@`);
- applying selected hunks from the changes card itself (today: per-file **Apply**, and undoing single changes in the diff editor before applying).

### Gates and verification

- use structured-output flags (Claude `--json-schema`, Codex `--output-schema`) for verdicts once both are verified against supported CLI versions, instead of parsing a fenced block;
- let the user decide on `needs-user-decision` findings from the Runs view and feed the decision into the next fix round;
- use Claude Code's `--restricted` mode for review stages once the minimum supported CLI version includes it;
- run verification commands inside an operating-system sandbox where one is available.

### Codex app-server adapter

- interactive approval requests, so Codex can ask before commands in Agent mode instead of working only inside its sandbox;
- live account and rate-limit reads without reading Codex's session log;
- durable thread resume, so Codex stages can continue their own session the way Claude stages do;
- richer event fidelity.

This must remain an adapter behind the existing core contract so CLI mode stays available.

### Isolated parallel work

- several independent agent tasks, each in its own worktree;
- deterministic merge of several worktrees with conflict detection before applying;
- optional reuse of ignored dependency folders in worktrees (for example a linked `node_modules`) where that is safe.

### Evaluation-driven routing

- repository-specific task benchmarks;
- correctness, latency, token, and review-yield metrics;
- configurable role weights learned from verified outcomes;
- no automatic model preference changes without explainable evidence.

### Recovery

- state schema migrations when a change cannot stay backward compatible;
- import/export of signed run artifacts;
- crash-safe reconciliation of agent processes left running by a crashed extension host.

## Explicitly not planned

- scraping browser sessions or provider credentials;
- pooling or transferring subscription quota;
- exposing hidden chain-of-thought;
- unrestricted autonomous background editing;
- infinite agent debate loops or unbounded fix rounds;
- silently switching to paid API billing;
- remotely hosted UI, or webview content loaded from the network;
- webviews other than the chat panel.
