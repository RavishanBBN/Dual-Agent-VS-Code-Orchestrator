import { writeFile } from 'node:fs/promises';

import * as vscode from 'vscode';

import { ClaudeCliAdapter, CodexCliAdapter } from './adapters/cliAdapters.js';
import { readConfiguration } from './config.js';
import { WorkflowOrchestrator } from './core/orchestrator.js';
import { renderRunReport } from './core/report.js';
import { FileRunStore } from './core/store.js';
import type { AgentHealth, WorkflowKind } from './core/types.js';
import { DashboardProvider, type DashboardController } from './ui/dashboardProvider.js';

function workspacePath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a workspace folder before starting a workflow.');
  if (folder.uri.scheme !== 'file') throw new Error('This release supports local desktop workspaces only.');
  return folder.uri.fsPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const storagePath = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const initial = readConfiguration();
  const store = new FileRunStore(storagePath, initial.maxRuns);
  let orchestrator = createOrchestrator(store);
  let detach = (): void => undefined;

  const controller: DashboardController = {
    start: async (kind, objective, allowWrites) => orchestrator.start(kind, objective, workspacePath(), allowWrites),
    cancel: () => orchestrator.cancel(),
    doctor: async () => {
      const configuration = readConfiguration();
      const adapters = [new ClaudeCliAdapter(configuration.claude), new CodexCliAdapter(configuration.codex)];
      return Promise.all(adapters.map((adapter) => adapter.doctor()));
    },
    latest: () => store.latest(),
    exportLatest: async () => exportLatest(store),
  };

  const dashboard = new DashboardProvider(context.extensionUri, controller);
  const attach = (): void => {
    detach();
    detach = orchestrator.onEvent((event) => dashboard.publish(event));
  };
  attach();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dualAgent.runImplementation', () => promptAndStart('implementation', controller)),
    vscode.commands.registerCommand('dualAgent.runBrainstorming', () => promptAndStart('brainstorming', controller)),
    vscode.commands.registerCommand('dualAgent.cancel', () => controller.cancel()),
    vscode.commands.registerCommand('dualAgent.doctor', async () => showHealth(await controller.doctor())),
    vscode.commands.registerCommand('dualAgent.exportLatestRun', () => controller.exportLatest()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('dualAgent') || orchestrator.activeRun) return;
      orchestrator = createOrchestrator(store);
      attach();
    }),
    { dispose: detach },
  );

  function createOrchestrator(runStore: FileRunStore): WorkflowOrchestrator {
    const configuration = readConfiguration();
    return new WorkflowOrchestrator(
      {
        claude: new ClaudeCliAdapter(configuration.claude),
        codex: new CodexCliAdapter(configuration.codex),
      },
      runStore,
      {
        maxContextCharacters: configuration.maxContextCharacters,
        fallbackOnQuota: configuration.fallbackOnQuota,
      },
    );
  }
}

async function promptAndStart(kind: WorkflowKind, controller: DashboardController): Promise<void> {
  const objective = await vscode.window.showInputBox({
    title: `Dual Agent ${kind}`,
    prompt: 'Describe the desired outcome, constraints, and acceptance criteria.',
    ignoreFocusOut: true,
  });
  if (!objective) return;
  const allowWrites =
    kind === 'implementation'
      ? (await vscode.window.showWarningMessage(
          'Allow Claude-led implementation stages to modify files in this workspace?',
          { modal: true },
          'Allow workspace edits',
        )) === 'Allow workspace edits'
      : false;
  if (kind === 'implementation' && !allowWrites) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Dual Agent ${kind} workflow`, cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => controller.cancel());
      const run = await controller.start(kind, objective, allowWrites);
      if (run.status === 'completed') void vscode.window.showInformationMessage('Dual Agent workflow completed.');
      else void vscode.window.showErrorMessage(`Dual Agent workflow ${run.status}: ${run.error ?? 'unknown error'}`);
    },
  );
}

async function showHealth(health: AgentHealth[]): Promise<void> {
  const message = health
    .map((item) => `${item.available ? '✓' : '✗'} ${item.agent}: ${item.version ?? item.detail}`)
    .join(' · ');
  await vscode.window.showInformationMessage(message);
}

async function exportLatest(store: FileRunStore): Promise<void> {
  const latest = await store.latest();
  if (!latest) throw new Error('There is no run to export.');
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${latest.workspacePath}/dual-agent-run-${latest.id.slice(0, 8)}.md`),
    filters: { Markdown: ['md'] },
  });
  if (!target) return;
  await writeFile(target.fsPath, renderRunReport(latest), 'utf8');
  await vscode.window.showTextDocument(target);
}

export function deactivate(): void {}
