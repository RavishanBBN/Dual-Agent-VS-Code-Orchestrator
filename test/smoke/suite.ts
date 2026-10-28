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
  await chatConversation(extension.exports as DualAgentTestApi);
}

interface ChatTurnState {
  id: string;
  status: string;
  stages: { id: string; label: string; activities: { tool: string; title: string; input?: string; output?: string }[] }[];
  outcome?: { text: string };
  attachments: unknown[];
  changes?: { files: { path: string }[]; state: string };
  usage?: Record<'claude' | 'codex', { input: number; output: number }>;
}

interface DualAgentTestApi {
  chatReady(): boolean;
  chatState(): { usage: { label: string; usage: Record<'claude' | 'codex', { input: number; output: number }> }[]; turns: ChatTurnState[]; consent?: { turnId: string }; composer: { pending: unknown[]; choices: { codex: { models: { id: string }[] } } } };
  chatMessage(message: unknown): Promise<void>;
}

function recordedCalls(name: string): { args: string[]; cwd: string }[] {
  const bin = process.env.DUAL_AGENT_SMOKE_BIN ?? '';
  const file = path.join(bin, `${name}-calls.jsonl`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; cwd: string }) : [];
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = read();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Talks to Claude and Codex through the chat: a checked answer, a follow-up, an attachment, and an edit. */
async function chatConversation(api: DualAgentTestApi): Promise<void> {
  // The chat page must load its script under its Content-Security-Policy and ask for the state.
  await vscode.commands.executeCommand('dualAgent.chat.focus');
  await waitFor(() => api.chatReady() || undefined, 'the chat webview to load');
  await waitFor(() => (api.chatState().composer.choices.codex.models.some((model) => model.id === 'fake-codex-model') ? true : undefined), 'the Codex model list');

  await api.chatMessage({ type: 'newConversation' });
  await api.chatMessage({ type: 'setOptions', agent: 'claude', model: 'opus', effort: 'high' });
  await api.chatMessage({ type: 'setOptions', agent: 'codex', model: 'fake-codex-model', effort: 'low' });
  await api.chatMessage({ type: 'attachData', name: 'notes.txt', data: Buffer.from('remember the empty list').toString('base64') });
  assert.equal(api.chatState().composer.pending.length, 1, 'the attachment is waiting for the next message');

  await api.chatMessage({ type: 'send', text: 'What does the README say?', mode: 'chat' });
  const [answer] = api.chatState().turns.slice(-1);
  assert.equal(answer?.status, 'completed');
  assert.deepEqual(answer?.stages.map((stage) => stage.id), ['claude-answer', 'codex-check']);
  assert.equal(answer?.outcome?.text, 'Codex agreed');
  assert.equal(answer?.attachments.length, 1);
  assert.equal(answer?.stages[0]?.label, 'Claude · fake-claude-model', "the model Claude reported is shown");
  // Each agent's steps stay in the transcript after the run, with what went in and came out.
  assert.deepEqual(answer?.stages[0]?.activities.map((step) => [step.tool, step.input]), [['Read', 'README.md']]);
  assert.deepEqual(answer?.stages[1]?.activities.map((step) => [step.tool, step.input, step.output]), [['Shell', 'cat README.md', 'original readme']]);
  const claudeCall = recordedCalls('claude').at(-1)?.args ?? [];
  for (const expected of ['--model', 'opus', '--effort', 'high', '--add-dir', '--include-partial-messages']) assert.ok(claudeCall.includes(expected), `Claude got ${expected}`);
  assert.equal(claudeCall[claudeCall.indexOf('--tools') + 1], 'Read,Grep,Glob', 'a chat answer is read-only');
  const codexCall = recordedCalls('codex').at(-1)?.args ?? [];
  for (const expected of ['--model', 'fake-codex-model', 'model_reasoning_effort=low', '--skip-git-repo-check']) assert.ok(codexCall.includes(expected), `Codex got ${expected}`);

  // The fake CLIs report 10 + 5 tokens for Claude and 8 + 4 for Codex per stage.
  assert.deepEqual(answer?.usage, { claude: { input: 10, cached: 0, output: 5, reasoning: 0 }, codex: { input: 8, cached: 0, output: 4, reasoning: 0 } });
  const conversationUsage = api.chatState().usage[0];
  assert.equal(conversationUsage?.label, 'This conversation');
  assert.equal(conversationUsage?.usage.claude.input, 10);
  await vscode.commands.executeCommand('dualAgent.showUsage');

  await api.chatMessage({ type: 'send', text: 'And for an empty list?', mode: 'chat' });
  const followUp = recordedCalls('claude').at(-1)?.args ?? [];
  assert.equal(followUp[followUp.indexOf('--resume') + 1], 'smoke-claude-session', "the follow-up continues Claude's session");

  // An edit asks for consent in the chat, then edits an isolated copy, never the workspace.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const sending = api.chatMessage({ type: 'send', text: 'Add a note file.', mode: 'edit' });
  const consent = await waitFor(() => api.chatState().consent, 'the consent card');
  await api.chatMessage({ type: 'consent', turnId: consent.turnId, decision: 'once' });
  await sending;
  const [edit] = api.chatState().turns.slice(-1);
  assert.equal(edit?.status, 'completed');
  assert.deepEqual(edit?.stages.map((stage) => stage.id), ['claude-edit', 'codex-change-review']);
  assert.equal(edit?.changes?.state, 'active');
  assert.deepEqual(edit?.changes?.files.map((file) => file.path), ['chat-edit.txt']);
  assert.equal(existsSync(path.join(folder, 'chat-edit.txt')), false, 'the workspace is untouched until the change is applied');
  const editCall = recordedCalls('claude').at(-1);
  assert.ok(editCall && path.resolve(editCall.cwd) !== path.resolve(folder), 'Claude edited in the worktree');

  await vscode.commands.executeCommand('dualAgent.openChatInEditor');
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
