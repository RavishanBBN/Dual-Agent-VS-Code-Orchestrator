/**
 * Runs inside a real VS Code extension host (see scripts/smoke.mjs). It checks that the extension
 * activates, contributes its views and commands, and completes a brainstorming run against fake CLIs
 * through the same commands and prompts a user would use.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as vscode from 'vscode';

import { createWorktree } from '../../src/core/worktree.js';

interface StoredRun {
  id: string;
  status: string;
  stages: { status: string; verdict?: { outcome: string }; result?: { text: string; resumedSession?: boolean } }[];
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function findFile(directory: string, name: string): string | undefined {
  if (!existsSync(directory)) return undefined;
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    if (statSync(candidate).isDirectory()) {
      const found = findFile(candidate, name);
      if (found) return found;
    } else if (entry === name) {
      return candidate;
    }
  }
  return undefined;
}

function storedRuns(userData: string): StoredRun[] {
  const file = findFile(path.join(userData, 'User', 'workspaceStorage'), 'runs.json');
  return file ? (JSON.parse(readFileSync(file, 'utf8')) as { runs: StoredRun[] }).runs : [];
}

export async function run(): Promise<void> {
  const userData = process.env.DUAL_AGENT_SMOKE_USER_DATA;
  assert.ok(userData, 'DUAL_AGENT_SMOKE_USER_DATA is set by scripts/smoke.mjs');

  const extension = vscode.extensions.getExtension('local.dual-agent-orchestrator');
  assert.ok(extension, 'the extension is installed in the development host');
  await extension.activate();
  assert.ok(vscode.workspace.isTrusted, 'the smoke workspace is trusted');

  const manifest = extension.packageJSON as { contributes: { commands: { command: string }[] } };
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const { command } of manifest.contributes.commands) assert.ok(registered.has(command), `${command} is registered`);

  // The views exist only if the manifest contributes them correctly.
  await vscode.commands.executeCommand('workbench.view.extension.dualAgent');
  await vscode.commands.executeCommand('dualAgent.runs.focus');
  await vscode.commands.executeCommand('dualAgent.agents.focus');
  await vscode.commands.executeCommand('dualAgent.doctor');
  await vscode.commands.executeCommand('dualAgent.showOutput');

  const missing = await vscode.workspace.openTextDocument(vscode.Uri.parse('dual-agent-run:/missing/report.md'));
  assert.match(missing.getText(), /no longer in the history/);

  // Start a brainstorming run the way a user would: select the objective in an editor and run the command.
  const objective = 'Design a cache for the search results page.';
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: objective, language: 'markdown' }));
  editor.selection = new vscode.Selection(0, 0, 0, objective.length);
  const started = vscode.commands.executeCommand('dualAgent.runBrainstorming');
  // Accept "Use the selected text" once the quick pick is showing.
  for (let attempt = 0; attempt < 40 && storedRuns(userData).length === 0; attempt += 1) {
    await sleep(500);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  }
  await started;

  const [latest] = storedRuns(userData);
  assert.ok(latest, 'the run was saved to workspace storage');
  assert.equal(latest.status, 'completed');
  assert.equal(latest.stages.length, 5);
  assert.ok(latest.stages.every((stage) => stage.status === 'completed'));
  assert.equal(latest.stages[1]?.verdict?.outcome, 'pass', "Codex's verdict block was parsed");
  assert.equal(latest.stages[2]?.result?.resumedSession, true, "Claude's later stage continued its session");

  const report = await vscode.workspace.openTextDocument(vscode.Uri.parse(`dual-agent-run:/${latest.id}/report.md`));
  assert.match(report.getText(), /Status: \*\*completed\*\*/);
  assert.match(report.getText(), new RegExp(objective.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const stage = await vscode.workspace.openTextDocument(vscode.Uri.parse(`dual-agent-run:/${latest.id}/01-claude-proposal.md`));
  assert.match(stage.getText(), /Claude output for claude-proposal/);

  await reviewWorktreeChanges(userData);
}

/** Records a finished implementation run with real worktree changes and opens them in the diff editors. */
async function reviewWorktreeChanges(userData: string): Promise<void> {
  const runsFile = findFile(path.join(userData, 'User', 'workspaceStorage'), 'runs.json');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(runsFile && folder);
  const { info } = await createWorktree(folder, path.join(path.dirname(runsFile), 'worktrees', 'smoke-review'));
  await writeFile(path.join(info.path, 'README.md'), 'readme changed by an agent\n');
  await writeFile(path.join(info.path, 'added.txt'), 'new file\n');

  const now = new Date().toISOString();
  const empty = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  const record = {
    schemaVersion: 1,
    id: 'smoke-review-run',
    kind: 'implementation',
    objective: 'Review the worktree',
    workspacePath: folder,
    status: 'completed',
    allowWrites: true,
    createdAt: now,
    updatedAt: now,
    stages: [],
    usage: { claude: empty, codex: empty },
    isolation: 'worktree',
    worktree: info,
  };
  const history = JSON.parse(readFileSync(runsFile, 'utf8')) as { runs: unknown[] };
  writeFileSync(runsFile, JSON.stringify({ ...history, runs: [record, ...history.runs] }));
  await vscode.commands.executeCommand('dualAgent.refreshRuns');

  await vscode.commands.executeCommand('dualAgent.reviewChanges', record.id);
  // VS Code adds the file count to the multi-file diff editor's title.
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'Dual Agent: Review the worktree (2 files)');

  await vscode.commands.executeCommand('dualAgent.openChange', record.id, { path: 'README.md', status: 'modified', symlink: false });
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(input instanceof vscode.TabInputTextDiff, 'a diff editor opened');
  assert.equal(input.original.scheme, 'dual-agent-base');
  assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), 'original readme\n');
  assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), 'readme changed by an agent\n');
  // The user's working tree is untouched until changes are applied.
  assert.equal(readFileSync(path.join(folder, 'README.md'), 'utf8'), 'original readme\n');
}
