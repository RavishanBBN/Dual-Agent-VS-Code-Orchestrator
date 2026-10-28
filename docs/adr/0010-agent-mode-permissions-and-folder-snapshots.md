# ADR-0010: Agent mode with permission prompts, folder snapshots, and choosing the agents

**Status:** accepted

**Date:** 2026-10-28

## Context

Users asked the pair to do what they would do in a terminal with Claude Code: install a package, run a build, set up a tool, or fix the environment. Every mode refused, because Chat and Research are read-only and Edit works in an isolated copy whose only shell is the user's verification commands. Claude Code runs in print mode, which cannot show its own permission prompt, so it either denies a command or runs it without asking.

Many users also work in folders that are not Git repositories, such as notes, papers, and scripts. Edit and Implement refused them, because an isolated worktree needs a commit to check out.

Users also wanted to choose who does the work: Codex leading when Claude is near its limit, or one agent alone when a second check is not worth its cost. And when the two agents disagree, the user had only the revision, with no independent view of who was right.

## Decision

- **Agent mode through Claude Code's permission-prompt tool.**
  - **Tools.** The working stage gets Claude Code's full toolset in the folder itself: reading, editing, Bash, TodoWrite, and the web.
  - **Asking.** It runs with `--permission-mode default` and `--permission-prompt-tool mcp__dualagent__approve`. Claude Code runs what it judges read-only, and the calls the user's own allow rules match, and asks that tool about everything else.
  - **The bridge.** The tool is a local MCP server bundled with the extension (`dist/permissionServer.js`) and run on VS Code's own runtime (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`). It forwards each request over a named pipe or Unix socket to a broker in the extension host, proving with a random token that it is the server the broker configured. The MCP configuration holding the token is written to private storage with mode 0600, and `--strict-mcp-config` keeps every other server out unless the user turned on `dualAgent.claude.userMcpServers`.
  - **The decision.** The broker asks the user in the chat, or in a modal dialog when the chat is hidden. **Allow *tool* for this message** stops asking about that tool until the run ends. A request that cannot reach the user is denied.
  - **Codex leading.** `codex exec` cannot ask, so when Codex does the work it runs in its workspace-write sandbox, with network access unless `dualAgent.codex.agentNetwork` is off.
  - **The check.** The other agent then checks the outcome read-only, and a failed check adds one follow-up stage with the same permission.
- **Direct edits after a snapshot,** for Agent mode, and for Edit, Test first, and Implement in a folder without Git or without a commit.
  - **The snapshot.** `createFolderSnapshot` records the folder in a bare repository in the extension's worktree storage, used through `GIT_DIR` and `GIT_WORK_TREE`. Dependency and build folders, files whose names suggest secrets, and the folder's own ignored files are excluded, and folders of more than 20,000 files are refused. Line-ending conversion and filters are off, so undo restores the exact bytes.
  - **Diffs.** Snapshots, change lists, and checkpoints use the same Git commands as a worktree, so reviewers, the changes card, and retry work unchanged.
  - **Keep and undo.** **Keep** deletes the snapshot repository. **Undo** restores the snapshot with `restoreWorktree`, or one file with `revertWorktreeFiles`.
- **Choosing the agents.**
  - **Selections.** A message records its `AgentSelection`: Claude + Codex, Codex + Claude, Claude only, or Codex only.
  - **Swapping.** `arrangeStage` swaps the agents and their names in each stage written for the usual roles. Stage IDs name the role, so the gate, revision, repair, and fix-round logic is unchanged.
  - **One agent.** A single agent runs each workflow's working stages only, with nothing that needs a second agent.
- **Gemini as an optional referee.**
  - **When.** After a failed check that leads to a revision, Gemini CLI rules on each finding in its read-only plan mode.
  - **Its weight.** The ruling is fenced as untrusted evidence for the revision. It decides no verdict, gate, or permission, and a referee that cannot rule only adds a warning.

## Consequences

- **Agent mode runs on the real machine.** File changes inside the folder can be undone from the snapshot. Installed software, global configuration, network requests, and files outside the folder cannot, and the consent card says so. Claude Code's read-only judgement and the user's own allow rules decide what runs without a prompt; this is the same trust the user gives Claude Code in a terminal.
- **"Allow for this message" is broad.** Allowing Bash for a message allows every later command in that run. It ends with the run, and the per-call prompt remains the default.
- **Codex in Agent mode is bounded by its sandbox, not by prompts.** With network access on, a prompt-injected Codex can send data out; `dualAgent.codex.agentNetwork` turns that off.
- **The bridge is required.** If it cannot start, Claude cannot work in Agent mode, and the stage fails with a clear error rather than running without prompts.
- **Direct edits are less isolated than a worktree.** The agents write the user's files during the run, so a change made outside the excluded folders is visible at once, and setup and verification commands run in the folder itself. Excluded folders such as `node_modules` and nested repositories are not restored by undo. A Git repository with a commit still gets an isolated worktree for Edit, Test first, and Implement.
- **A swapped or single agent changes what "checked" means.** With one agent there is no independent check, and the outcome says so. With Codex leading, Claude's check is as independent as Codex's was.
- **The referee costs a call and adds latency only when a check fails.** It is off by default, needs its own sign-in, and its judgement is advisory.
- **Limits and outages without failing first.** The same release reads the CLIs' own logs for usage across the machine (`dualAgent.usage.readLocalLogs`) and pauses a run while the machine is offline. `AgentLimits.observe` holds one handover rule for every reading, so a window used up in a terminal also hands Dual Agent's work to the other agent. The logs hold full conversations, so the reader keeps only counts, limit messages, and rate limits; the connectivity check sends no data. Both change only which agent works and when, never permissions.
