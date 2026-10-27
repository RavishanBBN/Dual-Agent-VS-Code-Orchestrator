# Contributing

## Principles

- Preserve the Claude-led, Codex-reviewed default unless an architecture decision explicitly changes it.
- Keep permissions and billing choices enforceable outside prompts.
- Do not read or persist provider credentials.
- Keep provider-specific formats inside adapters.
- Add tests and documentation with every behavioral change.
- Never add a retry loop without a strict attempt and time bound.

## Pull requests

1. Open an issue or short design note for workflow, persistence, authentication, or permission changes.
2. Add an ADR for decisions that change a system boundary.
3. Run `npm.cmd run check`.
4. Include screenshots for dashboard changes.
5. Document security and quota impact.
6. Keep generated bundles and VSIX files out of commits unless a release process explicitly requires them.

## Commit guidance

Use focused commits with imperative subjects. Do not mix formatting-only changes with behavior. Never commit provider authentication state, exported private run reports, `.env` files, or workspace data.
