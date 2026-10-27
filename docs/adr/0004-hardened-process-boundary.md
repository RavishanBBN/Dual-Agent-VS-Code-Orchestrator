# ADR-0004: Hardened process boundary

**Status:** accepted

**Date:** 2026-10-28

## Context

A security review of 1.0.0 found that the boundary between the extension and the processes it starts was weaker than the threat model assumed:

- Windows command lookup searches the current directory first, and agents run in the workspace, so a repository could supply `codex.cmd` or `git.exe`.
- `child.kill()` does not reach an agent launched through an npm `.cmd` shim, so cancellation and timeouts did not stop it.
- Agents inherited the whole extension-host environment.
- Claude Code's print mode loads repository settings and hooks without its usual trust prompt.
- Failure classification read the agent's output stream, which contains repository text.

## Decision

- Every child process is started by an absolute path from `resolveExecutable`, which never uses the current directory, relative `PATH` entries, or anything inside the workspace.
- Every child process is started so that its whole tree can be terminated, and is terminated with `terminateProcessTree`.
- Agents receive an allowlisted environment; billing variables are removed in subscription mode regardless of user passthrough.
- Claude stages load only user settings and no MCP servers.
- Failures are classified from provider error reports and stderr only.
- The extension runs only in trusted workspaces, and every setting is read from user settings only.

## Consequences

- A CLI installed only inside the repository (for example in its `node_modules/.bin`) cannot be used.
- Tools that need extra environment variables must be listed in `dualAgent.environment.passthrough`.
- Project-level Claude settings and all Claude MCP servers are unavailable during orchestrated stages; Claude needs `dualAgent.claude.allowedTools` to run shell commands.
- Codex project configuration remains under Codex's own trust settings; the extension can only warn about it.
- Tests must cover each of these properties on both Windows and POSIX.
