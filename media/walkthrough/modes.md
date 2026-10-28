# Modes

| Mode | What happens | Edits files |
|---|---|---|
| **Chat** | Claude answers, Codex checks | No |
| **Research** | Claude researches the web with cited sources; Codex opens each source and looks for missing or contrary work | No |
| **Agent** | Claude runs commands, installs, and edits the folder, asking you before each command; Codex checks the result | The folder itself, after a snapshot |
| **Edit** | Claude edits an isolated copy, your checks run, Codex reviews the diff, Claude fixes | Copy only |
| **Test first** | Codex writes failing tests, Claude makes them pass, Codex reviews both | Copy only |
| **Compare** | Both answer independently, then Claude merges and names where they differed | No |
| **Brainstorm** | Five rounds of proposal and challenge | No |
| **Implement** | Plan, review, your approval, edit, review, fix, final check | Copy only |

Type `/` in the message box for slash commands: `/agent install the linter`, for example, sends one message in Agent mode.

The **agents** menu chooses who works: Claude + Codex, Codex + Claude (Codex leads and Claude checks), or either one alone. The **Web** toggle lets agents search and read the web in any mode. The pills under the message box choose each agent's model and reasoning effort.
