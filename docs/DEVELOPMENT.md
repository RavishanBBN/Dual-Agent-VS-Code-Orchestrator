# Development and testing

## Toolchain

- Node.js 20+
- TypeScript with strict and exact-optional-property checking
- esbuild for a deterministic CommonJS extension bundle
- ESLint flat configuration with type-aware rules
- Vitest and V8 coverage
- `@vscode/vsce` for packaging

## Commands

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check
npm.cmd run package
```

No test command invokes a live provider. Fake adapters verify stage order, permission flow, usage aggregation, durable updates, and fallback behavior without spending subscription quota.

Process-level behavior is tested with fake CLIs: `test/helpers.ts` writes a small Node.js script plus a launcher, a `.cmd` shim on Windows (the same shape npm installs for the real CLIs) or an executable shell script elsewhere. The adapter tests run these through the real process runner, which covers argument escaping, stdin prompts, the environment allowlist, and provider failure reports. Git snapshot tests create temporary repositories, so Git must be on `PATH`.

Several tests reproduce specific vulnerabilities and must keep passing:

- a same-named launcher planted in the workspace, first on `PATH`, never runs (`cliAdapters.test.ts`, `executables.test.ts`);
- on Windows, a `git.exe` planted in the workspace never runs, with `NoDefaultCurrentDirectoryInExePath` removed to match a normal desktop session (`gitSnapshot.test.ts`);
- cancelling an agent started through a `.cmd` shim stops the agent itself, not only `cmd.exe` (`processRunner.test.ts`, Windows); the process-group equivalent runs everywhere;
- an abort signal raised before a process starts prevents it from starting;
- failures are classified from provider errors, not from repository text in tool output;
- untrusted text cannot close its prompt block or forge the boundary (`context.test.ts`).

Some tests run only on Windows or only on POSIX; CI covers both. Coverage is measured for every module that does not import `vscode` (`src/core`, `src/adapters`, and `src/ui/messages.ts`).

## Local extension debugging

1. Open the project in VS Code.
2. Press `F5` or run **Run Dual Agent Extension**.
3. Open a disposable Git repository in the Extension Development Host.
4. Run **Dual Agent: Check Agent Setup**.
5. Test brainstorming first because it is read-only.
6. Test implementation only after reviewing the disposable workspace and enabling write consent.

## Adding a workflow stage

1. Add the stage to `src/core/workflows.ts`.
2. Give it one provider, one permission, one purpose, and a narrow instruction.
3. Update `docs/WORKFLOWS.md` and the README diagram.
4. Update workflow-order and permission tests.
5. Consider quota impact and whether the stage materially improves quality.

## Adding a provider

Implement `AgentAdapter`, normalize output into `StageResult`, classify operational failures, and keep authentication outside the extension. Provider-specific events must not leak directly into core workflow logic.

## Compatibility policy

- Unknown provider stream events are tolerated.
- Missing final text is a stage failure.
- Parser fixtures should be added for every provider schema regression.
- Every setting remains machine-scoped and is read through `inspect().globalValue`, never from workspace settings.
- Executables are started only by absolute path from `resolveExecutable`, never by bare name.
- State schema changes require a migration or backward-compatible reader.

## Release procedure

1. Update version and `CHANGELOG.md`.
2. Update `PROJECT_STATUS.md` verification results.
3. Run `npm.cmd audit` and review transitive build-only vulnerabilities.
4. Run `npm.cmd run check`.
5. Run `npm.cmd run package`.
6. Install the VSIX in an isolated profile.
7. Smoke-test doctor, read-only brainstorming, cancellation, export, and an implementation run in a disposable repository.
8. Tag the verified commit.

The package currently overrides `@azure/msal-node` to `7.1.0` because the VSIX packager's permitted dependency range otherwise resolves to a version covered by GHSA-xcx6-jx8p-x3h5. Re-evaluate and remove the override when `@vscode/vsce` declares a fixed compatible dependency directly.
