# Security and threat model

## Protected assets

- source code and uncommitted user changes;
- agent subscription credentials and API keys;
- command execution authority;
- private prompts, diffs, and run history;
- billing choice and usage limits;
- integrity of review and approval records.

## Threats and controls

### Credential theft

The extension never reads provider credential files. Official CLIs own sign-in and renewal. In subscription mode, API-key environment variables are removed from child processes. Executable settings are machine-scoped so repository configuration cannot replace the binary.

Residual risk: a malicious binary already selected by the user has the authority of the extension host process. Users must install CLIs from official sources and should prefer absolute paths in high-assurance environments.

### Prompt injection from repository or agent output

Repository text, diffs, logs, and prior model responses are explicitly labeled untrusted. Stage authority is restated after the shared context, and permissions remain outside model control.

Residual risk: models can still follow adversarial content. Sandbox boundaries, human review, and deterministic validation are required.

### Conflicting writes

Stages are sequential. Only implementation/fix stage contracts receive workspace-write permission. Claude owns those stages normally; if bounded fallback is enabled, Codex can inherit the same explicit stage permission after an eligible quota, availability, or timeout failure, and that reassignment is persisted. Normal Codex review stages use read-only sandboxing.

Residual risk: provider tools, hooks, or external processes may behave outside the extension's assumptions. Review local CLI configuration and managed policies.

### Command injection

Commands and arguments are passed as arrays with `shell: false`; prompts are sent through stdin. The extension does not interpolate user prompts into a shell command.

### Accidental API charges

Subscription mode removes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CODEX_API_KEY`. Environment billing is an explicit machine-level choice.

Residual risk: provider-specific credential configuration outside these variables can affect billing. Confirm account status in each official CLI.

### Data leakage

There is no extension-owned server. Run records remain in private VS Code storage. Export requires an explicit save action.

Residual risk: each provider receives the context sent to its CLI according to that provider's account and data policies. Do not use repositories or accounts that are not authorized for the data involved.

### Denial of service and runaway usage

Stages have timeouts; Claude has a maximum turn count; workflows have finite stage lists; cancellation terminates the child process; fallback is attempted once.

## Security review checklist

- [ ] CLI binaries come from official distributions.
- [ ] `billingMode` matches the intended account/billing source.
- [ ] Workspace is trusted and local.
- [ ] No secrets are visible in the diff or prompt.
- [ ] Write consent is appropriate for the objective.
- [ ] Git working tree has been reviewed before and after the run.
- [ ] Hooks, MCP servers, skills, and agent configuration are understood.
- [ ] Exported reports are stored in an approved location.

## Reporting vulnerabilities

See the repository-level [SECURITY.md](../SECURITY.md). Do not include tokens, credentials, private prompts, or proprietary repository content in a report.
