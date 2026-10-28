import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as vscode from 'vscode';

import { runChecks } from './adapters/checkRunner.js';
import { ClaudeCliAdapter, CodexCliAdapter } from './adapters/cliAdapters.js';
import { listCodexModels, type CodexModel } from './adapters/models.js';
import { readConfiguration, type ExtensionConfiguration } from './config.js';
import { extractPdfTextInWorker } from './core/attachments.js';
import { checkGit } from './core/git.js';
import { canResume, editsFiles, WorkflowOrchestrator, type OrchestratorDependencies } from './core/orchestrator.js';
import { renderRunReport } from './core/report.js';
import { FileRunStore } from './core/store.js';
import type { AgentStreamEvent, OrchestratorEvent, RunRecord, WorkflowKind, WorktreeInfo } from './core/types.js';
import {
  applyWorktree,
  createWorktree,
  listWorktreeChanges,
  removeWorktree,
  worktreeExists,
  WorktreeError,
  type WorktreeChange,
} from './core/worktree.js';
import { ApprovalCoordinator, RunStatusBar } from './ui/approvals.js';
import { ChatController, type ChatHost } from './ui/chat/chatController.js';
import { CHAT_VIEW, ChatViewProvider } from './ui/chat/chatProvider.js';
import type { ChatState } from './ui/chat/protocol.js';
import { BASE_SCHEME, baseUri, BaseFileProvider, reportUri, RUN_SCHEME, RunDocumentProvider, stageUri } from './ui/documents.js';
import {
  applyDetail,
  consentDetail,
  OBJECTIVE_LIMIT,
  runDescription,
  runLabel,
  statusBarText,
} from './ui/presentation.js';
import { AgentsView, isRunNode, RunsView, type ToolRow } from './ui/views.js';

const ALLOW = 'Allow and Start';
/** Agent messages are shown whole in stage documents; the output channel gets a readable excerpt. */
const LOG_EXCERPT = 400;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localFolders(): vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}

/** Picks the folder agents run in; in a multi-root workspace the active editor's folder is offered first. */
async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running agents in it.');
  const folders = localFolders();
  if (!folders.length) throw new Error('Open a local folder before starting a run.');
  if (folders.length === 1) return folders[0];
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const current = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  const ordered = current ? [current, ...folders.filter((folder) => folder.uri.toString() !== current.uri.toString())] : folders;
  const picked = await vscode.window.showQuickPick(
    ordered.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { title: 'Dual Agent', placeHolder: 'Which folder should the agents work in?' },
  );
  return picked?.folder;
}

/** Reads the objective from the selection in the active editor, or from an input box. */
async function askObjective(kind: WorkflowKind): Promise<string | undefined> {
  const title = kind === 'implementation' ? 'Dual Agent: Implementation Run' : 'Dual Agent: Brainstorming Run';
  const editor = vscode.window.activeTextEditor;
  const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : '';
  if (selected) {
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(selection) Use the selected text', description: `${selected.length.toLocaleString('en-US')} characters`, useSelection: true },
        { label: '$(edit) Type an objective', description: '', useSelection: false },
      ],
      { title, placeHolder: 'What should the agents work on?' },
    );
    if (!picked) return undefined;
    if (picked.useSelection) return selected.slice(0, OBJECTIVE_LIMIT);
  }
  const typed = await vscode.window.showInputBox({
    title,
    prompt: 'Describe the outcome, constraints, and acceptance criteria. For a longer brief, select it in an editor first.',
    ignoreFocusOut: true,
    validateInput: (value) => (value.length > OBJECTIVE_LIMIT ? `Keep the objective under ${OBJECTIVE_LIMIT} characters.` : undefined),
  });
  return typed?.trim() || undefined;
}

/** What the extension exposes to its own smoke test; not a supported API. */
export interface DualAgentTestApi {
  chatReady(): boolean;
  chatState(): ChatState;
  chatMessage(message: unknown): Promise<void>;
}

/** The folder new conversations work in: the active editor's folder first, then the first local folder. */
function chatFolder(): { path: string; name: string } | { blocked: string } {
  if (!vscode.workspace.isTrusted) return { blocked: 'Trust this workspace to chat with agents about it.' };
  const folders = localFolders();
  if (!folders.length) return { blocked: 'Open a local folder to chat with Claude and Codex about it.' };
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const folder = (activeUri && vscode.workspace.getWorkspaceFolder(activeUri)) || folders[0];
  return folder ? { path: folder.uri.fsPath, name: folder.name } : { blocked: 'Open a local folder.' };
}

export async function activate(context: vscode.ExtensionContext): Promise<DualAgentTestApi> {
  const storagePath = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const worktreeRoot = path.join(storagePath, 'worktrees');
  const output = vscode.window.createOutputChannel('Dual Agent', { log: true });
  let configuration = readConfiguration();
  let store = new FileRunStore(storagePath, configuration.maxRuns);
  let busy = false;
  let reconfigurePending = false;
  let detach = (): void => undefined;

  const runsView = new RunsView({
    activeRunId: () => orchestrator.activeRun?.id,
    listChanges: (run) => (run.worktree ? listWorktreeChanges(run.worktree) : Promise.resolve([])),
  });
  const lookup = (runId: string): RunRecord | undefined => runsView.get(runId);
  const documents = new RunDocumentProvider(lookup);
  const statusBar = new RunStatusBar();
  async function openPlan(runId: string): Promise<void> {
    const run = lookup(runId);
    if (!run) return;
    // Claude's plan beside Codex's review of it.
    const [plan, review] = run.stages;
    if (plan) await openDocument(stageUri(run, plan), vscode.ViewColumn.One);
    if (review) await openDocument(stageUri(run, review), vscode.ViewColumn.Two);
  }
  // The chat shows its own approval card, so the notification is only needed while the chat is hidden.
  const approvals = new ApprovalCoordinator(openPlan, () => !chat.hasVisibleView);
  const agentsView = new AgentsView(() => checkTools());
  let codexModels: Promise<CodexModel[]> | undefined;

  function dependencies(): OrchestratorDependencies {
    return {
      prepareWorktree: (workspacePath, runId, signal) => createWorktree(workspacePath, path.join(worktreeRoot, runId.slice(0, 12)), signal),
      worktreeExists,
      runChecks: (request) => runChecks(configuration.checks, request),
      requestApproval: (run, stage, signal) => approvals.request(run, stage, signal),
    };
  }
  let orchestrator = createOrchestrator(configuration, store, dependencies());

  async function findRun(runId: string): Promise<RunRecord | undefined> {
    return lookup(runId) ?? (await store.list()).find((run) => run.id === runId);
  }

  const chatHost: ChatHost = {
    storagePath,
    folder: chatFolder,
    isBusy: () => busy || orchestrator.activeRun !== undefined,
    exclusive: (task) => exclusive(task),
    start: async (kind, objective, folder, allowWrites, options) => {
      // Settings are read at the last moment so the run uses exactly what the user just confirmed.
      if (!orchestrator.activeRun) reconfigure();
      output.info(`Starting ${kind} run in ${folder}.`);
      return orchestrator.start(kind, objective, folder, allowWrites, options);
    },
    resume: async (runId, allowWrites) => {
      if (!orchestrator.activeRun) reconfigure();
      output.info(`Resuming run ${runId}.`);
      return orchestrator.resume(runId, allowWrites);
    },
    cancel: () => void orchestrator.cancel(),
    consentDetails: (folder, kind) => consentDetail(readConfiguration(), folder, false, kind).split('\n\n'),
    commandsSignature: () => {
      const current = readConfiguration();
      return JSON.stringify([current.isolation, current.setupCommands, current.verificationCommands]);
    },
    maxContextCharacters: () => configuration.maxContextCharacters,
    loadRuns: () => store.list(),
    listChanges: (worktree) => listWorktreeChanges(worktree),
    worktreeExists,
    codexModels: () => (codexModels ??= listCodexModels(readConfiguration().codex)),
    extractPdfText: (data) => extractPdfTextInWorker(path.join(context.extensionPath, 'dist', 'pdfWorker.js'), data),
    pendingApprovalRunId: () => approvals.pendingRunId,
    approve: (notes) => approvals.approve(notes),
    reject: () => approvals.reject(),
    openPlan,
    openStage: async (runId, index) => {
      const run = await findRun(runId);
      const stage = run?.stages[index];
      if (run && stage) await openDocument(stageUri(run, stage));
    },
    openReport: async (runId) => {
      const run = await findRun(runId);
      if (run) await openDocument(reportUri(run));
    },
    log: (text) => output.warn(text),
  };
  const chat = new ChatController(chatHost, { global: context.globalState, workspace: context.workspaceState });
  const chatProvider = new ChatViewProvider(context.extensionUri, chat);

  /** Records that a worktree's changes were applied or discarded on every run that shared it. */
  async function markWorktree(worktree: WorktreeInfo, state: 'applied' | 'discarded'): Promise<void> {
    for (const run of await store.list()) {
      if (run.worktree?.path !== worktree.path || run.worktree.state !== 'active') continue;
      await orchestrator.updateRun(run.id, (record) => {
        if (record.worktree) record.worktree.state = state;
      });
    }
    await chat.runsChanged();
  }

  function attach(): void {
    detach();
    detach = orchestrator.onEvent(handleEvent);
  }

  function reconfigure(): void {
    configuration = readConfiguration();
    reportProblems(configuration);
    store = new FileRunStore(storagePath, configuration.maxRuns);
    orchestrator = createOrchestrator(configuration, store, dependencies());
    reconfigurePending = false;
    attach();
  }

  function updateContext(run?: RunRecord): void {
    const active = orchestrator.activeRun;
    void vscode.commands.executeCommand('setContext', 'dualAgent.running', active !== undefined);
    void vscode.commands.executeCommand('setContext', 'dualAgent.awaitingApproval', approvals.pendingRunId !== undefined);
    const shown = run && active?.id === run.id ? run : active;
    if (!shown) {
      statusBar.hide();
      return;
    }
    const { text, tooltip, attention } = statusBarText(shown);
    statusBar.show(text, tooltip, attention);
  }

  function handleEvent(event: OrchestratorEvent): void {
    chat.handleEvent(event);
    switch (event.type) {
      case 'run-updated':
        runsView.upsert(event.run);
        documents.refresh(event.run.id);
        updateContext(event.run);
        break;
      case 'agent-event':
        if (event.agentEvent) logAgentEvent(event.agentEvent);
        break;
      case 'log':
        if (event.message) output.info(event.message);
        break;
    }
  }

  function logAgentEvent(agentEvent: AgentStreamEvent): void {
    const text = agentEvent.message.replace(/\s+/g, ' ').trim();
    const excerpt = text.length > LOG_EXCERPT ? `${text.slice(0, LOG_EXCERPT)}…` : text;
    const line = `[${agentEvent.agent}] ${excerpt}`;
    if (agentEvent.category === 'diagnostic') output.warn(line);
    else if (agentEvent.category === 'message' || agentEvent.category === 'usage') output.info(line);
    else output.debug(line);
  }

  async function checkTools(): Promise<ToolRow[]> {
    const current = readConfiguration();
    const folders = localFolders().map((folder) => folder.uri.fsPath);
    const workspace = folders[0];
    const health = await Promise.all([
      new ClaudeCliAdapter(current.claude).doctor(undefined, workspace),
      new CodexCliAdapter(current.codex).doctor(undefined, workspace),
    ]);
    const git = await checkGit(workspace);
    return [
      ...health.map(
        (item): ToolRow => ({
          id: item.agent,
          label: item.agent === 'claude' ? 'Claude Code' : 'Codex',
          state: item.available ? 'ready' : 'unavailable',
          description: item.available ? (item.version ?? 'installed') : 'not available',
          detail: item.detail,
        }),
      ),
      {
        id: 'git',
        label: 'Git',
        state: !git.available ? 'unavailable' : git.repository || !workspace ? 'ready' : 'warning',
        description: !git.available ? 'not available' : git.repository || !workspace ? (git.version ?? 'installed') : 'workspace not usable',
        detail: git.detail,
      },
    ];
  }

  async function openDocument(uri: vscode.Uri, column?: vscode.ViewColumn): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, ...(column ? { viewColumn: column } : {}) });
  }

  async function resolveRun(argument: unknown, filter: (run: RunRecord) => boolean, placeHolder: string): Promise<RunRecord | undefined> {
    const id = typeof argument === 'string' ? argument : isRunNode(argument) ? argument.runId : undefined;
    if (id) return lookup(id) ?? (await store.list()).find((run) => run.id === id);
    const candidates = runsView.all().filter(filter);
    if (!candidates.length) {
      void vscode.window.showInformationMessage('Dual Agent: no run in the history matches this command.');
      return undefined;
    }
    if (candidates.length === 1) return candidates[0];
    const picked = await vscode.window.showQuickPick(
      candidates.map((run) => ({ label: runLabel(run), description: runDescription(run, Date.now(), false), run })),
      { title: 'Dual Agent', placeHolder },
    );
    return picked?.run;
  }

  async function confirmWrites(folder: string, resuming: boolean, kind: WorkflowKind = 'implementation'): Promise<boolean> {
    const current = readConfiguration();
    const choice = await vscode.window.showWarningMessage(
      resuming ? 'Resume this run? Agents will edit files again.' : 'Start an implementation run that lets agents edit files?',
      { modal: true, detail: consentDetail(current, folder, resuming, kind) },
      ALLOW,
    );
    return choice === ALLOW;
  }

  /** Holds `busy` from the first prompt until the run ends, so a second run cannot start in between. */
  async function exclusive(task: () => Promise<RunRecord | undefined>): Promise<void> {
    if (busy || orchestrator.activeRun) {
      void vscode.window.showWarningMessage('Dual Agent: a run is already in progress.');
      return;
    }
    busy = true;
    let finished: RunRecord | undefined;
    try {
      finished = await task();
    } catch (error) {
      void vscode.window.showErrorMessage(`Dual Agent: ${message(error)}`);
    } finally {
      busy = false;
      // Settings changed during the run take effect once it ends.
      if (reconfigurePending && !orchestrator.activeRun) reconfigure();
      updateContext();
    }
    // Announced after `busy` is released: an unanswered notification must not block the next run.
    if (finished) void announce(finished).catch((error: unknown) => output.error(message(error)));
  }

  async function startRun(kind: WorkflowKind): Promise<void> {
    await exclusive(async () => {
      const folder = await pickFolder();
      if (!folder) return undefined;
      const objective = await askObjective(kind);
      if (!objective) return undefined;
      const allowWrites = kind === 'implementation' && (await confirmWrites(folder.name, false));
      if (kind === 'implementation' && !allowWrites) return undefined;
      // Settings are read at the last moment so the run uses exactly what the user just confirmed.
      if (!orchestrator.activeRun) reconfigure();
      output.info(`Starting ${kind} run in ${folder.uri.fsPath}.`);
      void vscode.commands.executeCommand('dualAgent.runs.focus');
      return orchestrator.start(kind, objective, folder.uri.fsPath, allowWrites);
    });
  }

  async function resumeRun(argument: unknown): Promise<void> {
    await exclusive(async () => {
      const run = await resolveRun(argument, canResume, 'Which run should continue?');
      if (!run) return undefined;
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running agents in it.');
      const allowWrites = editsFiles(run.kind) && (await confirmWrites(path.basename(run.workspacePath), true, run.kind));
      if (editsFiles(run.kind) && !allowWrites) return undefined;
      if (!orchestrator.activeRun) reconfigure();
      output.info(`Resuming run ${run.id}.`);
      return orchestrator.resume(run.id, allowWrites);
    });
  }

  async function changesOf(run: RunRecord): Promise<WorktreeChange[]> {
    if (!run.worktree || run.worktree.state !== 'active') throw new Error('This run has no isolated changes waiting for review.');
    if (orchestrator.activeRun?.id === run.id) throw new Error('Wait for the run to finish before reviewing its changes.');
    return listWorktreeChanges(run.worktree);
  }

  async function announce(run: RunRecord): Promise<void> {
    if (run.conversationId) {
      // The chat shows the result; a hidden chat gets a single nudge.
      if (chat.hasVisibleView) return;
      const choice = await vscode.window.showInformationMessage('Dual Agent: Claude and Codex have answered your message.', 'Show Chat');
      if (choice) await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
      return;
    }
    const report = async (): Promise<void> => openDocument(reportUri(run));
    if (run.status === 'failed' || run.status === 'cancelled') {
      const text = `Dual Agent run ${run.status}: ${run.error ?? 'no reason recorded'}`;
      const actions = ['Resume', 'Show Output', 'Open Report'];
      const choice =
        run.status === 'failed'
          ? await vscode.window.showErrorMessage(text, ...actions)
          : await vscode.window.showInformationMessage(text, ...actions);
      if (choice === 'Resume') await vscode.commands.executeCommand('dualAgent.resumeRun', run.id);
      else if (choice === 'Show Output') output.show();
      else if (choice === 'Open Report') await report();
      return;
    }
    const finding = run.status === 'completed-with-findings' ? ` with unresolved findings (${run.unresolved ?? 'see the report'})` : '';
    if (run.worktree?.state === 'active') {
      const changes = await listWorktreeChanges(run.worktree).catch(() => []);
      const text = `Dual Agent: implementation finished${finding}. ${changes.length} file(s) changed in the isolated worktree.`;
      const actions = ['Review Changes', 'Apply Changes', 'Open Report'];
      const choice = finding
        ? await vscode.window.showWarningMessage(text, ...actions)
        : await vscode.window.showInformationMessage(text, ...actions);
      if (choice === 'Review Changes') await vscode.commands.executeCommand('dualAgent.reviewChanges', run.id);
      else if (choice === 'Apply Changes') await vscode.commands.executeCommand('dualAgent.applyChanges', run.id);
      else if (choice === 'Open Report') await report();
      return;
    }
    const final = run.stages.at(-1);
    const choice = await vscode.window.showInformationMessage(`Dual Agent: ${run.kind} run finished${finding}.`, 'Open Result', 'Open Report');
    if (choice === 'Open Result' && final) await openDocument(stageUri(run, final));
    else if (choice === 'Open Report') await report();
  }

  const command = (id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await handler(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(`Dual Agent: ${message(error)}`);
      }
    });

  const hasChanges = (run: RunRecord): boolean => run.worktree?.state === 'active' && orchestrator.activeRun?.id !== run.id;

  context.subscriptions.push(
    output,
    runsView,
    agentsView,
    documents,
    statusBar,
    approvals,
    vscode.window.createTreeView('dualAgent.runs', { treeDataProvider: runsView, showCollapseAll: true }),
    vscode.window.createTreeView('dualAgent.agents', { treeDataProvider: agentsView }),
    vscode.workspace.registerTextDocumentContentProvider(RUN_SCHEME, documents),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseFileProvider(lookup)),
    chat,
    chatProvider,
    vscode.window.registerWebviewViewProvider(CHAT_VIEW, chatProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    approvals.onDidChange(() => {
      updateContext();
      chat.refresh();
    }),

    command('dualAgent.openChat', async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
      chat.focusComposer();
    }),
    command('dualAgent.newConversation', async () => {
      await chat.newConversation();
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
      chat.focusComposer();
    }),
    command('dualAgent.openChatInEditor', () => chatProvider.openInEditor()),

    command('dualAgent.runImplementation', () => startRun('implementation')),
    command('dualAgent.runBrainstorming', () => startRun('brainstorming')),
    command('dualAgent.resumeRun', (argument) => resumeRun(argument)),
    command('dualAgent.cancel', () => {
      if (!orchestrator.cancel()) void vscode.window.showInformationMessage('Dual Agent: no run is active.');
    }),
    command('dualAgent.approvePlan', () => approvals.decide()),
    command('dualAgent.rejectPlan', () => approvals.reject()),
    command('dualAgent.doctor', async () => {
      void vscode.commands.executeCommand('dualAgent.agents.focus');
      const rows = await agentsView.refresh();
      const summary = rows.map((row) => `${row.state === 'ready' ? '✓' : row.state === 'warning' ? '!' : '✗'} ${row.label}`).join('   ');
      const problems = rows.filter((row) => row.state !== 'ready');
      if (problems.length) void vscode.window.showWarningMessage(`Dual Agent: ${summary}. ${problems.map((row) => row.detail).join(' ')}`);
      else void vscode.window.showInformationMessage(`Dual Agent: ${summary}`);
    }),
    command('dualAgent.showOutput', () => output.show()),
    command('dualAgent.refreshRuns', async () => runsView.setRuns(await store.list())),
    command('dualAgent.openDocument', (uri) => (uri instanceof vscode.Uri ? openDocument(uri) : undefined)),
    command('dualAgent.openReport', async (argument) => {
      const run = await resolveRun(argument, () => true, 'Which run?');
      if (run) await openDocument(reportUri(run));
    }),
    command('dualAgent.exportRun', async (argument) => {
      const run = await resolveRun(argument, () => true, 'Which run should be exported?');
      if (run) await exportReport(run);
    }),
    command('dualAgent.exportLatestRun', async () => {
      const latest = await store.latest();
      if (!latest) throw new Error('There is no run to export.');
      await exportReport(latest);
    }),
    command('dualAgent.reviewChanges', async (argument) => {
      const run = await resolveRun(argument, hasChanges, 'Whose changes should be reviewed?');
      if (!run?.worktree) return;
      const changes = await changesOf(run);
      if (!changes.length) {
        void vscode.window.showInformationMessage('Dual Agent: this run did not change any files.');
        return;
      }
      const worktree = run.worktree;
      const resources = changes.map((change) => {
        const modified =
          change.status === 'deleted' ? baseUri(run, change.path, true) : vscode.Uri.file(path.join(worktree.path, change.path));
        const original = change.status === 'added' ? baseUri(run, change.path, true) : baseUri(run, change.path);
        return [modified, original, modified] as const;
      });
      try {
        await vscode.commands.executeCommand('vscode.changes', `Dual Agent: ${runLabel(run)}`, resources);
      } catch {
        // Older hosts without the multi-file diff editor open the first file instead.
        const [first] = changes;
        if (first) await vscode.commands.executeCommand('dualAgent.openChange', run.id, first);
      }
    }),
    command('dualAgent.openChange', async (runId, change) => {
      const run = typeof runId === 'string' ? lookup(runId) : undefined;
      const item = change as WorktreeChange | undefined;
      if (!run?.worktree || !item) return;
      const right = item.status === 'deleted' ? baseUri(run, item.path, true) : vscode.Uri.file(path.join(run.worktree.path, item.path));
      const left = baseUri(run, item.path, item.status === 'added');
      await vscode.commands.executeCommand('vscode.diff', left, right, `${item.path} (run base ↔ agent changes)`);
    }),
    command('dualAgent.applyChanges', async (argument) => {
      const run = await resolveRun(argument, hasChanges, 'Whose changes should be applied?');
      if (!run?.worktree) return;
      const worktree = run.worktree;
      const changes = await changesOf(run);
      if (!changes.length) {
        const choice = await vscode.window.showInformationMessage('Dual Agent: this run did not change any files.', 'Discard Worktree');
        if (choice) await vscode.commands.executeCommand('dualAgent.discardChanges', run.id);
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Apply ${changes.length} changed file(s) to ${path.basename(worktree.repositoryRoot)}?`,
        { modal: true, detail: applyDetail(run, changes) },
        'Apply Changes',
      );
      if (choice !== 'Apply Changes') return;
      try {
        await applyWorktree(worktree);
      } catch (error) {
        if (!(error instanceof WorktreeError)) throw error;
        if (error.detail) output.error(error.detail);
        const next = await vscode.window.showErrorMessage(`Dual Agent: ${error.message}`, 'Show Details', 'Open Worktree');
        if (next === 'Show Details') output.show();
        else if (next === 'Open Worktree') await vscode.commands.executeCommand('dualAgent.openWorktree', run.id);
        return;
      }
      await markWorktree(worktree, 'applied');
      await removeWorktree(worktree, worktreeRoot).catch((error: unknown) => output.warn(`Worktree not removed: ${message(error)}`));
      const next = await vscode.window.showInformationMessage(
        `Dual Agent: applied ${changes.length} file(s). Nothing is staged or committed; review them in Source Control.`,
        'Open Source Control',
      );
      if (next) await vscode.commands.executeCommand('workbench.view.scm');
    }),
    command('dualAgent.discardChanges', async (argument) => {
      const run = await resolveRun(argument, hasChanges, 'Whose changes should be discarded?');
      if (!run?.worktree) return;
      if (orchestrator.activeRun?.id === run.id) throw new Error('Cancel the run before discarding its changes.');
      const choice = await vscode.window.showWarningMessage(
        'Discard this run\'s changes?',
        { modal: true, detail: 'The isolated worktree and every change in it are deleted. Your workspace is not touched. This cannot be undone.' },
        'Discard Changes',
      );
      if (choice !== 'Discard Changes') return;
      const worktree = run.worktree;
      await removeWorktree(worktree, worktreeRoot);
      await markWorktree(worktree, 'discarded');
    }),
    command('dualAgent.openWorktree', async (argument) => {
      const run = await resolveRun(argument, hasChanges, 'Whose worktree should be opened?');
      if (!run?.worktree) return;
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(run.worktree.workingDirectory), { forceNewWindow: true });
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('dualAgent')) return;
      if (orchestrator.activeRun || busy) reconfigurePending = true;
      else reconfigure();
      if (event.affectsConfiguration('dualAgent.codex')) codexModels = undefined;
      void agentsView.refresh();
      chat.refresh();
    }),
    { dispose: () => detach() },
    // Stops any agent still running when the extension shuts down.
    { dispose: () => void orchestrator.cancel() },
  );

  reportProblems(configuration);
  attach();
  updateContext();
  try {
    const recovered = await orchestrator.recoverInterrupted();
    if (recovered.length) output.warn(`${recovered.length} run(s) were interrupted when VS Code closed; resume them from the Runs view.`);
    runsView.setRuns(await store.list());
  } catch (error) {
    output.error(`Run history could not be read: ${message(error)}`);
  }
  return { chatReady: () => chat.hasReadyView, chatState: () => chat.snapshot(), chatMessage: (value) => chat.receive(value) };
}

function reportProblems(configuration: ExtensionConfiguration): void {
  if (configuration.problems.length) {
    void vscode.window.showWarningMessage(`Dual Agent settings ignored: ${configuration.problems.join(' ')}`);
  }
}

function createOrchestrator(
  configuration: ExtensionConfiguration,
  runStore: FileRunStore,
  dependencies: OrchestratorDependencies,
): WorkflowOrchestrator {
  return new WorkflowOrchestrator(
    {
      claude: new ClaudeCliAdapter(configuration.claude),
      codex: new CodexCliAdapter(configuration.codex),
    },
    runStore,
    {
      maxContextCharacters: configuration.maxContextCharacters,
      fallbackOnQuota: configuration.fallbackOnQuota,
      isolation: configuration.isolation,
      maxFixRounds: configuration.maxFixRounds,
      approvePlan: configuration.approvePlan,
      resumeSessions: configuration.resumeClaudeSessions ? ['claude'] : [],
      setupCommands: configuration.setupCommands,
      verificationCommands: configuration.verificationCommands,
    },
    dependencies,
  );
}

async function exportReport(run: RunRecord): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    // Reports contain prompts and agent output; defaulting outside the repository avoids committing them.
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `dual-agent-run-${run.id.slice(0, 8)}.md`)),
    filters: { Markdown: ['md'] },
  });
  if (!target) return;
  await writeFile(target.fsPath, renderRunReport(run), 'utf8');
  await vscode.window.showTextDocument(target);
}

export function deactivate(): void {}
