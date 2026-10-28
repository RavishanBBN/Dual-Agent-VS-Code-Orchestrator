# Roadmap

Release 2.0 delivered the native VS Code interface, the verification gate with bounded fix rounds, extension-run setup and verification commands, isolated worktrees with review and apply, plan approval, Claude session continuity, resuming runs, and multi-root folder selection. Release 2.1 added the chat panel with Chat and Edit modes, conversations, attachments, and model and effort pickers. Future work should deepen integration without weakening local safety.

## Planned candidates

### Chat

- streamed Codex text, through the app-server adapter below;
- an optional parallel mode in which both agents answer and Claude merges the answers;
- a per-message choice to skip the Codex check when speed matters more than verification;
- slash commands for switching modes, models, and conversations from the keyboard;
- dragging files from the VS Code Explorer onto the composer (today: paste, drop from the operating system, the paperclip, or `@`);
- applying selected files or hunks from the changes card.

### Gates and verification

- use structured-output flags (Claude `--json-schema`, Codex `--output-schema`) for verdicts once both are verified against supported CLI versions, instead of parsing a fenced block;
- let the user decide on `needs-user-decision` findings from the Runs view and feed the decision into the next fix round;
- use Claude Code's `--restricted` mode for review stages once the minimum supported CLI version includes it;
- run verification commands inside an operating-system sandbox where one is available.

### Codex app-server adapter

- interactive approval requests;
- live account/rate-limit reads;
- durable thread resume, so Codex stages can continue their own session the way Claude stages do;
- richer event fidelity.

This must remain an adapter behind the existing core contract so CLI mode stays available.

### Claude session controls

- normalized account usage status when an official machine-readable surface is available;
- surfaced permission requests instead of relying only on non-interactive policy modes.

### Isolated parallel work

- several independent agent tasks, each in its own worktree;
- deterministic merge of several worktrees with conflict detection before applying;
- partial apply of selected files or hunks from the review;
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
