# Operations and troubleshooting

## Doctor checks

Use **Dual Agent: Check Agent Setup**. A healthy result shows a version for both providers.

### Codex unavailable

Run:

```powershell
codex --version
codex login status
```

If the command works only from a specific path, set `dualAgent.codex.command` to that absolute path in user settings.

### Claude unavailable on Windows

PowerShell may block the `claude.ps1` shim while `claude.cmd` works:

```powershell
claude.cmd --version
```

Set `dualAgent.claude.command` to `claude.cmd` or its absolute path.

### Unexpected API billing

1. Confirm `dualAgent.billingMode` is `subscription`.
2. Run the provider's status/login command outside the extension.
3. Verify the intended subscription account is selected.
4. Review provider billing dashboards. The extension's ledger is not authoritative billing data.

### Workflow stops at a review stage

Export the run report and inspect the stage error. Authentication, invalid request, and policy failures intentionally do not fall back. Correct the underlying provider configuration and start a new workflow.

### Context truncation

Increase `dualAgent.context.maxCharacters` cautiously. Large diffs and repeated full outputs consume both subscriptions. Prefer smaller objectives and clean checkpoints.

### Cancellation takes time

The process receives a graceful termination signal and is force-terminated after a short grace period. A provider may need time to stop a child command it launched.

## Recovery

Completed and failed records remain in private workspace storage. The current release does not resume a partially completed run automatically. Export the failed report and start a new objective such as:

```text
Continue the previous Dual Agent run using the attached report. Preserve the existing working-tree changes and begin by validating their current state.
```

## Logs

User-visible normalized events appear in the dashboard. Provider stderr is treated as diagnostics and is not automatically persisted in the repository. Use VS Code's Extension Host log and Developer Tools for extension failures.
