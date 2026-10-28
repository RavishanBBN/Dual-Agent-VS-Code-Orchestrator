# Verification commands

Add your test command to `dualAgent.verification.commands` in your **user** settings, as a list of arguments:

```json
"dualAgent.verification.commands": [["npm", "test"]]
```

The extension runs these after every edit, without a shell, and gives the result to Codex as evidence. Claude may run the same commands itself while it edits. The commands are listed in the consent card before any edit starts.

Settings are machine-scoped, so a repository's `.vscode/settings.json` can never change what runs.
