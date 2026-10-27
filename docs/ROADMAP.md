# Roadmap

The 1.0 release contains the complete local reciprocal workflow. Future work should improve integration depth without weakening local safety.

## Planned candidates

### Deterministic verification and gates

- parse a structured verdict from Codex's final verification instead of free-text PASS, with a bounded fix loop and a "completed with findings" status;
- optional extension-run verification commands whose output is passed to reviewers as trusted evidence. This needs a design that does not run agent-edited scripts outside every sandbox: in an implementation run, `npm test` executes whatever the agents last wrote;
- use Claude Code's `--restricted` mode for review stages once the minimum supported CLI version includes it.

### Codex app-server adapter

- interactive approval requests;
- live account/rate-limit reads;
- model catalog discovery;
- durable thread resume;
- richer event fidelity.

This must remain an adapter behind the existing core contract so CLI mode stays available.

### Claude session controls

- explicit resume by captured session ID;
- normalized account usage status when an official machine-readable surface is available;
- surfaced permission requests instead of relying only on non-interactive policy modes.

### Isolated parallel work

- one Git worktree per independent agent task;
- patch preview and deterministic merge;
- conflict detection before applying changes;
- no parallel writes to the user's primary working tree.

### Evaluation-driven routing

- repository-specific task benchmarks;
- correctness, latency, token, and review-yield metrics;
- configurable role weights learned from verified outcomes;
- no automatic model preference changes without explainable evidence.

### Recovery

- resume a workflow from the last completed checkpoint;
- state schema migrations;
- import/export of signed run artifacts;
- crash-safe process reconciliation.

## Explicitly not planned

- scraping browser sessions or provider credentials;
- pooling or transferring subscription quota;
- exposing hidden chain-of-thought;
- unrestricted autonomous background editing;
- infinite agent debate loops;
- silently switching to paid API billing.
