import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as vscode from 'vscode';

import { runChecks } from './adapters/checkRunner.js';
import { ClaudeCliAdapter, CodexCliAdapter } from './adapters/cliAdapters.js';
import {
  accountEnvironment,
  accountExecutable,
  accountStatus,
  PROVIDER_NAMES,
  SIGN_IN_METHODS,
  signInWithKey,
  signOut,
  terminalLaunch,
  type AccountOptions,
  type AccountProvider,
  type AccountStatus,
} from './adapters/accounts.js';
import { isOnline } from './adapters/connectivity.js';
import { GeminiReferee } from './adapters/gemini.js';
import { localUsageHomes, LocalUsageScanner, type LocalUsageReport } from './adapters/localUsage.js';
import { PermissionBroker } from './adapters/permissionBroker.js';
import { listCodexModels, type CodexModel } from './adapters/models.js';
import { readConfiguration, type ExtensionConfiguration } from './config.js';
import { extractPdfTextInWorker } from './core/attachments.js';
import { describeOutcome, titleFor } from './core/conversation.js';
import { checkGit } from './core/git.js';
import { AgentLimits, formatReset, type AgentLimit } from './core/limits.js';
import { redactSecrets } from './core/redact.js';
import { canResume, editsFiles, WorkflowOrchestrator, type OrchestratorDependencies } from './core/orchestrator.js';
import { renderRunReport } from './core/report.js';
import { FileRunStore } from './core/store.js';
import type { AgentId, AgentStreamEvent, OrchestratorEvent, QuotaReading, RunRecord, WorkflowKind, WorktreeInfo } from './core/types.js';
import { isFinished } from './core/types.js';
import {
  applyWorktree,
  applyWorktreeFiles,
  checkpointWorktree,
  createFolderSnapshot,
  createWorktree,
  listWorktreeChanges,
  removeWorktree,
  restoreWorktree,
  revertWorktreeFiles,
  worktreeExists,
  WorktreeError,
  type WorktreeChange,
} from './core/worktree.js';
import { ApprovalCoordinator, RunStatusBar } from './ui/approvals.js';
import { ChatController, type ChatHost } from './ui/chat/chatController.js';
import { CHAT_VIEW, ChatViewProvider } from './ui/chat/chatProvider.js';
import { fileReference, type ChatState } from './ui/chat/protocol.js';
import { continueAt, ContinuationScheduler, NETWORK_RETRY_MS, type Continuation, type ContinuationOutcome } from './ui/continuations.js';
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
/** Usage limits are per account, so they are kept in global state; paused runs belong to the workspace. */
const LIMITS_KEY = 'dualAgent.agentLimits';
const CONTINUATIONS_KEY = 'dualAgent.continuations';
const QUOTAS_KEY = 'dualAgent.quotas';
/** How often a terminal sign-in is checked, and for how long. */
const SIGN_IN_POLL_MS = 3_000;
const SIGN_IN_WAIT_MS = 10 * 60_000;
/** The prompt of the small call that asks an agent for its current limits. */
const LIMITS_PROMPT = 'Reply with the single word OK. Do not use any tools.';
/** How often the CLIs' logs are read again when no change was noticed, and how long changes settle first. */
const LOCAL_USAGE_POLL_MS = 120_000;
const LOCAL_USAGE_SETTLE_MS = 3_000;
const BRIEF_TEMPLATE = `# Project brief

Write here what both agents should always know about this project: its purpose, conventions, commands, and
anything they must not touch. Every message includes this brief. It is stored privately, not in the repository.
`;

/** A folder that Git does not track, or one without a commit, is edited directly after a snapshot instead. */
function needsFolderSnapshot(error: unknown): boolean {
  return error instanceof WorktreeError && /not a git repository|at least one commit/i.test(error.message);
}
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
  /** Script errors and blocked content the chat webviews reported. */
  chatErrors(): readonly string[];
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
  // Shared by every run, so an agent at its usage limit is skipped until the limit resets.
  const limits = new AgentLimits(context.globalState.get<AgentLimit[]>(LIMITS_KEY) ?? []);
  // The accounts' usage windows as the CLIs last reported them, for the quota meter.
  const quotas = new Map<AgentId, QuotaReading>((context.globalState.get<QuotaReading[]>(QUOTAS_KEY) ?? []).map((reading) => [reading.agent, reading]));
  const briefPath = path.join(storagePath, 'brief.md');

  /** Keeps the newest reading of each account's limits, whether from a run or from the CLIs' own logs. */
  function noteQuota(reading: QuotaReading): void {
    const known = quotas.get(reading.agent);
    // A Claude reading from its logs only says a limit was reached; it does not replace measured windows.
    if (known && Date.parse(known.observedAt) > Date.parse(reading.observedAt)) return;
    if (known?.windows.length && !reading.windows.length) quotas.set(reading.agent, { ...known, limited: reading.limited, ...(reading.resetsAt ? { resetsAt: reading.resetsAt } : {}) });
    else quotas.set(reading.agent, reading);
    void context.globalState.update(QUOTAS_KEY, [...quotas.values()]);
    chat.refresh();
  }

  // Each CLI's sign-in, as its own status command last reported it.
  const accounts = new Map<AccountProvider, AccountStatus>();

  function accountOptions(provider: AccountProvider): AccountOptions {
    const current = readConfiguration();
    const agent = provider === 'gemini' ? current.claude : current[provider];
    return {
      command: provider === 'gemini' ? current.gemini.command : agent.command,
      billingMode: agent.billingMode,
      ...(agent.environmentPassthrough ? { environmentPassthrough: agent.environmentPassthrough } : {}),
      untrustedDirectories: localFolders().map((folder) => folder.uri.fsPath),
    };
  }

  async function refreshAccount(provider: AccountProvider): Promise<AccountStatus> {
    const status = await accountStatus(provider, accountOptions(provider));
    accounts.set(provider, status);
    chat.refresh();
    return status;
  }

  /** Signs in with the CLI's own flow: in a terminal for a browser or device code, or with a typed API key. */
  async function signIn(provider?: AccountProvider): Promise<void> {
    const chosen =
      provider ??
      (
        await vscode.window.showQuickPick(
          (['claude', 'codex', 'gemini'] as const).map((id) => ({ label: `Sign in to ${PROVIDER_NAMES[id]}`, description: accounts.get(id)?.detail ?? '', id })),
          { title: 'Dual Agent: Sign In' },
        )
      )?.id;
    if (!chosen) return;
    const name = PROVIDER_NAMES[chosen];
    const methods = SIGN_IN_METHODS[chosen];
    const method =
      methods.length === 1
        ? methods[0]
        : (await vscode.window.showQuickPick(methods.map((item) => ({ label: item.label, description: item.description, method: item })), { title: `Sign in to ${name}`, placeHolder: 'How do you want to sign in?' }))?.method;
    if (!method) return;
    const options = accountOptions(chosen);
    if (method.readsKey) {
      const key = await vscode.window.showInputBox({
        title: `Sign in to ${name} with an API key`,
        prompt: `Paste the key. It goes straight to ${name}, which stores it; Dual Agent does not keep it.`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length >= 20 && !/\s/.test(value.trim()) ? undefined : 'That does not look like an API key.'),
      });
      if (!key) return;
      await signInWithKey(chosen, method, key, options);
      const status = await refreshAccount(chosen);
      void agentsView.refresh();
      void vscode.window.showInformationMessage(status.signedIn ? `Dual Agent: ${name} is signed in. ${status.detail}` : `Dual Agent: ${name} did not accept the key. ${status.detail}`);
      return;
    }
    const before = accounts.get(chosen)?.signedIn ?? (await refreshAccount(chosen)).signedIn;
    const environment = accountEnvironment(options);
    const terminal = vscode.window.createTerminal({
      name: `Sign in to ${name}`,
      ...terminalLaunch(accountExecutable(options), method.args, environment),
      cwd: os.homedir(),
      // The agents' own environment, so the sign-in lands where they look for it.
      env: environment,
      strictEnv: true,
      iconPath: new vscode.ThemeIcon('account'),
    });
    terminal.show();
    output.info(`Signing in to ${name} in a terminal (${method.label}).`);
    watchSignIn(chosen, terminal, before === true);
  }

  /** Follows a terminal sign-in until the CLI reports it, the terminal closes, or ten minutes pass. */
  function watchSignIn(provider: AccountProvider, terminal: vscode.Terminal, wasSignedIn: boolean): void {
    const started = Date.now();
    let done = false;
    const finish = async (): Promise<void> => {
      if (done) return;
      done = true;
      clearInterval(timer);
      closed.dispose();
      const status = await refreshAccount(provider);
      void agentsView.refresh();
      if (status.signedIn) void vscode.window.showInformationMessage(`Dual Agent: ${PROVIDER_NAMES[provider]} is signed in. ${status.detail}`);
    };
    const timer = setInterval(() => {
      if (Date.now() - started > SIGN_IN_WAIT_MS) void finish();
      // Re-signing in changes nothing visible until the terminal closes; a first sign-in shows as soon as it lands.
      else if (!wasSignedIn) void accountStatus(provider, accountOptions(provider)).then((status) => (status.signedIn ? finish() : undefined));
    }, SIGN_IN_POLL_MS);
    const closed = vscode.window.onDidCloseTerminal((item) => {
      if (item === terminal) void finish();
    });
    context.subscriptions.push(closed, { dispose: () => clearInterval(timer) });
  }

  async function signOutOf(provider?: AccountProvider): Promise<void> {
    const signedIn = (['claude', 'codex'] as const).filter((id) => accounts.get(id)?.signedIn);
    const chosen =
      provider ??
      (await vscode.window.showQuickPick(signedIn.map((id) => ({ label: `Sign out of ${PROVIDER_NAMES[id]}`, description: accounts.get(id)?.detail ?? '', id })), { title: 'Dual Agent: Sign Out' }))?.id;
    if (!chosen) return;
    const name = PROVIDER_NAMES[chosen];
    const choice = await vscode.window.showWarningMessage(
      `Sign out of ${name}?`,
      { modal: true, detail: `${name} signs out everywhere on this machine that uses the same configuration, including your terminal.` },
      'Sign Out',
    );
    if (choice !== 'Sign Out') return;
    await signOut(chosen, accountOptions(chosen));
    await refreshAccount(chosen);
    void agentsView.refresh();
  }

  /** Asks each agent for its current limits with one small call; the providers report them with every call. */
  async function refreshLimits(): Promise<void> {
    const current = readConfiguration();
    const folder = path.join(context.globalStorageUri.fsPath, 'limits-check');
    await mkdir(folder, { recursive: true });
    const signal = new AbortController().signal;
    const ask = async (adapter: ClaudeCliAdapter | CodexCliAdapter, options: { model?: string; effort?: string }): Promise<void> => {
      const result = await adapter.run({
        prompt: LIMITS_PROMPT,
        cwd: folder,
        untrustedDirectories: [folder],
        permission: 'read-only',
        signal,
        options,
        onEvent: (event) => {
          if (event.quota) noteQuota(event.quota);
        },
      });
      if (result.quota) {
        noteQuota(result.quota);
        limits.observe(result.quota);
      }
    };
    const results = await Promise.allSettled([
      ask(new ClaudeCliAdapter(current.claude), { model: 'haiku' }),
      ask(new CodexCliAdapter(current.codex), { effort: 'low' }),
    ]);
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') output.warn(`${index === 0 ? 'Claude' : 'Codex'} did not report its limits: ${message(result.reason)}`);
    }
  }

  // Usage of Claude Code and Codex anywhere on this machine, read from their own logs, so the totals and limits
  // also reflect work done in a terminal or another editor.
  const localUsage = new LocalUsageScanner(localUsageHomes());
  let machine: LocalUsageReport | undefined;
  let localTimer: ReturnType<typeof setTimeout> | undefined;
  const localWatchers: FSWatcher[] = [];
  async function scanLocalUsage(): Promise<void> {
    if (!readConfiguration().readLocalLogs) {
      machine = undefined;
      return;
    }
    try {
      machine = await localUsage.scan();
      for (const reading of machine.quotas) {
        noteQuota(reading);
        limits.observe(reading);
      }
      chat.refresh();
    } catch (error) {
      output.debug(`The CLIs' usage logs could not be read: ${message(error)}`);
    }
  }
  function scheduleLocalScan(delay = LOCAL_USAGE_SETTLE_MS): void {
    if (localTimer) clearTimeout(localTimer);
    localTimer = setTimeout(() => {
      localTimer = undefined;
      void scanLocalUsage().finally(() => scheduleLocalScan(LOCAL_USAGE_POLL_MS));
    }, delay);
  }
  function watchLocalUsage(): void {
    for (const watcher of localWatchers.splice(0)) watcher.close();
    if (!readConfiguration().readLocalLogs) return;
    const homes = localUsageHomes();
    for (const folder of [path.join(homes.claude, 'projects'), path.join(homes.codex, 'sessions')]) {
      try {
        // Only that something changed is used; the scan then reads what was appended.
        const watcher = watch(folder, { recursive: true }, () => scheduleLocalScan());
        watcher.on('error', () => watcher.close());
        localWatchers.push(watcher);
      } catch {
        // A CLI that was never used has no folder yet; the periodic scan still finds it later.
      }
    }
  }
  // Agent mode asks the user before commands and edits through this bridge.
  const broker = new PermissionBroker({
    storagePath: context.globalStorageUri.fsPath,
    serverScript: path.join(context.extensionPath, 'dist', 'permissionServer.js'),
    // The extension host runs on VS Code's own runtime, which acts as Node with this variable.
    runtime: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
    decide: (request) => chat.askPermission(request),
  });
  let permissionBridge: { configFile: string; tool: string } | undefined;
  try {
    permissionBridge = await broker.start();
  } catch (error) {
    output.warn(`Agent mode cannot ask before commands, so it is unavailable: ${message(error)}`);
  }

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
      prepareWorktree: async (workspacePath, runId, signal, direct) => {
        const snapshot = (purpose: 'agent' | 'folder'): ReturnType<typeof createFolderSnapshot> =>
          createFolderSnapshot(workspacePath, path.join(worktreeRoot, `direct-${runId.slice(0, 12)}.git`), signal, purpose);
        // In a folder without Git, Agent mode's snapshot is the same as any mode's, so later edits can share it.
        if (direct) return snapshot((await checkGit(workspacePath).catch(() => undefined))?.repository ? 'agent' : 'folder');
        try {
          return await createWorktree(workspacePath, path.join(worktreeRoot, runId.slice(0, 12)), signal);
        } catch (error) {
          // A folder without Git cannot have an isolated copy; it is edited directly after a snapshot.
          if (needsFolderSnapshot(error)) return snapshot('folder');
          throw error;
        }
      },
      worktreeExists,
      runChecks: (request) => runChecks(configuration.checks, request),
      requestApproval: (run, stage, signal) => approvals.request(run, stage, signal),
      limits,
      online: () => isOnline(),
      onQuota: (reading) => noteQuota(reading),
      ...(configuration.gemini.enabled
        ? {
            referee: new GeminiReferee({
              command: configuration.gemini.command,
              timeoutMs: configuration.claude.timeoutMs,
              billingMode: configuration.claude.billingMode,
              ...(configuration.claude.environmentPassthrough ? { environmentPassthrough: configuration.claude.environmentPassthrough } : {}),
              ...(configuration.gemini.model ? { model: configuration.gemini.model } : {}),
            }),
          }
        : {}),
    };
  }

  /** Changes when the setup or verification commands change, so consent is asked again. */
  function commandsSignature(): string {
    const current = readConfiguration();
    return JSON.stringify([current.isolation, current.setupCommands, current.verificationCommands]);
  }
  let orchestrator = createOrchestrator(configuration, store, dependencies(), permissionBridge);

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
    commandsSignature,
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
    limits: () => limits.all(),
    continuation: (runId) => continuations.get(runId)?.at,
    pendingContinuations: () => continuations.size,
    scheduleContinuation: (runId) => void scheduleContinuation(runId),
    cancelContinuation: (runId) => {
      if (continuations.cancel(runId)) output.info(`Automatic continuation of run ${runId} cancelled.`);
    },
    checkpointWorktree,
    rewindWorktree: async (worktree, tree) => {
      if (tree) {
        await restoreWorktree(worktree, tree);
        output.info(`Worktree put back to an earlier checkpoint for a retry: ${worktree.path}`);
        await chat.runsChanged();
        return;
      }
      // A folder edited directly is put back to its snapshot before the snapshot is removed.
      if (worktree.gitDir) await restoreWorktree(worktree, worktree.baseCommit);
      await removeWorktree(worktree, worktreeRoot);
      await markWorktree(worktree, 'discarded');
    },
    editorContext: (folder) => editorContext(folder),
    readBrief: () => readFile(briefPath, 'utf8').catch(() => ''),
    editBrief: async () => {
      await mkdir(path.dirname(briefPath), { recursive: true });
      await readFile(briefPath).catch(() => writeFile(briefPath, BRIEF_TEMPLATE, { encoding: 'utf8', mode: 0o600 }));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(briefPath));
    },
    quotas: () => [...quotas.values()],
    runCommand: async (folder, argv) => {
      const choice = await vscode.window.showWarningMessage(
        `Run \`${argv.join(' ')}\`?`,
        {
          modal: true,
          detail: `It runs in ${folder} with your permissions, outside any agent sandbox, without a shell. Its output is attached to your next message. The command came from agent output, so read it first.`,
        },
        'Run',
      );
      if (choice !== 'Run') return undefined;
      const [result] = await runChecks(configuration.checks, {
        commands: [argv],
        cwd: folder,
        signal: new AbortController().signal,
        untrustedDirectories: [folder],
        onLine: (line) => output.info(`  ${line}`),
      });
      return result ? { exitCode: result.exitCode, output: result.error ?? result.output, durationMs: result.durationMs } : undefined;
    },
    pasteToTerminal: (folder, command) => {
      // A line break would make the shell run the text at once, so only a single line is pasted.
      if (/[\r\n]/.test(command.trim())) {
        void vscode.window.showWarningMessage('Dual Agent: only a one-line command can be pasted into the terminal. Copy the block instead.');
        return;
      }
      const terminal = vscode.window.terminals.find((item) => item.name === 'Dual Agent') ?? vscode.window.createTerminal({ name: 'Dual Agent', cwd: folder });
      terminal.show();
      // Not executed: the user reads it and presses Enter.
      terminal.sendText(command.replace(/^(?:\$|>)\s+/, ''), false);
    },
    saveFile: async (defaultName, content, filters) => {
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)), filters });
      if (!target) return;
      await writeFile(target.fsPath, configuration.redactSecrets ? redactSecrets(content).text : content, 'utf8');
      const open = await vscode.window.showInformationMessage(`Dual Agent: saved ${path.basename(target.fsPath)}.`, 'Open');
      if (open) await vscode.window.showTextDocument(target);
    },
    applyFile: async (runId, file) => {
      const run = await findRun(runId);
      if (!run?.worktree || run.worktree.state !== 'active' || run.worktree.gitDir) return;
      const choice = await vscode.window.showWarningMessage(`Apply ${file} to your workspace?`, { modal: true, detail: 'Only this file is applied; the other changes stay in the isolated copy.' }, 'Apply');
      if (choice !== 'Apply') return;
      try {
        await applyWorktreeFiles(run.worktree, [file]);
      } catch (error) {
        void vscode.window.showErrorMessage(`Dual Agent: ${message(error)}`);
      }
      await chat.runsChanged();
    },
    discardFile: async (runId, file) => {
      const run = await findRun(runId);
      if (!run?.worktree || run.worktree.state !== 'active') return;
      const direct = Boolean(run.worktree.gitDir);
      const choice = await vscode.window.showWarningMessage(
        direct ? `Undo the changes to ${file}?` : `Discard the changes to ${file}?`,
        { modal: true, detail: direct ? 'The file is put back as it was in the snapshot; a file the agents created is deleted.' : 'Only this file is put back in the isolated copy; your workspace is not touched.' },
        direct ? 'Undo' : 'Discard',
      );
      if (!choice) return;
      await revertWorktreeFiles(run.worktree, [file]);
      await chat.runsChanged();
    },
    soundEnabled: () => configuration.sound,
    machineUsage: () => (machine ? { days: { claude: machine.claude, codex: machine.codex }, scannedAt: machine.scannedAt } : undefined),
    accounts: () => [...accounts.values()].map((status) => ({ provider: status.provider, signedIn: status.signedIn, detail: status.detail })),
    signIn: (provider) => signIn(provider),
    refreshLimits: () => refreshLimits(),
    includeEditorByDefault: () => configuration.includeEditorContext,
  };
  function editorContext(folder: string): ReturnType<ChatHost['editorContext']> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;
    const relative = path.relative(folder, editor.document.uri.fsPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const file = relative.split(path.sep).join('/');
    const selection = editor.selection;
    const selected = selection.isEmpty ? '' : editor.document.getText(selection);
    const start = selection.start.line + 1;
    const end = selection.end.line + 1 - (selection.end.character === 0 && selection.end.line > selection.start.line ? 1 : 0);
    const diagnostics = vscode.languages
      .getDiagnostics(editor.document.uri)
      .filter((item) => item.severity <= vscode.DiagnosticSeverity.Warning)
      .slice(0, 20)
      .map((item) => `${file}:${item.range.start.line + 1}: ${item.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}: ${item.message.split('\n')[0] ?? ''}`);
    return {
      file,
      label: selected ? `${file}:${start}-${end}` : file,
      ...(selected ? { startLine: start, endLine: end, selection: selected } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
    };
  }

  const chat = new ChatController(chatHost, { global: context.globalState, workspace: context.workspaceState });
  void chat.refreshBrief();
  const chatProvider = new ChatViewProvider(context.extensionUri, chat);
  const continuations = new ContinuationScheduler(
    context.workspaceState.get<unknown[]>(CONTINUATIONS_KEY) ?? [],
    (items) => void context.workspaceState.update(CONTINUATIONS_KEY, items),
    (item) => continueAfterLimit(item),
  );
  continuations.onChange(() => chat.refresh());
  limits.onChange(() => {
    void context.globalState.update(LIMITS_KEY, limits.toJSON());
    chat.refresh();
  });

  /** Schedules a run that stopped at the usage limits to continue once the first limit resets. */
  async function scheduleContinuation(runId: string): Promise<void> {
    const run = await findRun(runId);
    if (!run || !canResume(run)) return;
    if (run.limitReset) {
      const at = continueAt(run.limitReset);
      continuations.schedule({ runId, at, commands: commandsSignature() });
      output.info(`Run ${runId} continues automatically at ${formatReset(at)}.`);
    } else if (run.offlineSince) {
      continuations.schedule({ runId, at: new Date(Date.now() + NETWORK_RETRY_MS).toISOString(), commands: commandsSignature(), network: true });
      output.info(`Run ${runId} continues automatically when the network connection is back.`);
    }
  }

  /** Continues a run whose usage limits have reset, unless what it was allowed to run has changed. */
  async function continueAfterLimit(item: Continuation): Promise<ContinuationOutcome> {
    if (busy || orchestrator.activeRun) return 'retry';
    const run = await findRun(item.runId);
    if (!run || !canResume(run) || !(run.limitReset || run.offlineSince) || !vscode.workspace.isTrusted) return 'done';
    if (item.network && !(await isOnline())) return 'retry';
    if (run.allowWrites && item.commands !== commandsSignature()) {
      output.warn(`Run ${run.id} was not continued automatically: its setup or verification commands changed while it was paused.`);
      void vscode.window
        .showWarningMessage(
          'Dual Agent: the usage limits have reset, but the setup or verification commands changed while the run was paused, so it was not continued automatically.',
          'Resume',
        )
        .then((choice) => (choice ? vscode.commands.executeCommand('dualAgent.resumeRun', run.id) : undefined));
      return 'done';
    }
    output.info(item.network ? `The network connection is back; continuing run ${run.id}.` : `Usage limits reset; continuing run ${run.id}.`);
    if (run.conversationId) {
      await chat.continueAfterLimit(run.id);
    } else {
      await exclusive(async () => {
        if (!orchestrator.activeRun) reconfigure();
        return orchestrator.resume(run.id, run.allowWrites);
      });
    }
    return 'done';
  }

  /** Tells the user a run stopped at the usage limits, and schedules it to continue when that is on. */
  async function paused(run: RunRecord): Promise<void> {
    if (!run.limitReset && !run.offlineSince) return;
    const auto = readConfiguration().autoContinue;
    if (auto) await scheduleContinuation(run.id);
    // The chat shows a card for its own messages; a hidden chat, or a run from the Runs view, gets a notification.
    if (run.conversationId && chat.hasVisibleView) return;
    if (!run.limitReset) {
      const text = auto
        ? 'Dual Agent: the network connection was lost. The message continues where it stopped when the connection is back.'
        : 'Dual Agent: the network connection was lost, so the message stopped.';
      const choice = await vscode.window.showWarningMessage(text, auto ? 'Do Not Continue' : 'Continue When Online', 'Resume Now');
      if (choice === 'Do Not Continue') continuations.cancel(run.id);
      else if (choice === 'Continue When Online') await scheduleContinuation(run.id);
      else if (choice === 'Resume Now') await vscode.commands.executeCommand('dualAgent.resumeRun', run.id);
      return;
    }
    const reason = run.error ?? 'Both agents are at their usage limits.';
    if (auto) {
      const choice = await vscode.window.showWarningMessage(
        `Dual Agent: ${reason} It continues automatically at ${formatReset(continueAt(run.limitReset))}.`,
        'Continue Now',
        'Do Not Continue',
      );
      if (choice === 'Continue Now') await continuations.runNow(run.id);
      else if (choice === 'Do Not Continue') continuations.cancel(run.id);
      return;
    }
    const choice = await vscode.window.showWarningMessage(`Dual Agent: ${reason}`, 'Continue When Limits Reset', 'Resume Now');
    if (choice === 'Continue When Limits Reset') await scheduleContinuation(run.id);
    else if (choice === 'Resume Now') await vscode.commands.executeCommand('dualAgent.resumeRun', run.id);
  }

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
    orchestrator = createOrchestrator(configuration, store, dependencies(), permissionBridge);
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

  const findings = vscode.languages.createDiagnosticCollection('Dual Agent');
  const outcomeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  outcomeItem.command = 'dualAgent.openChat';

  /** Puts reviewers' findings that name a file and line on that line, as the editor's problems. */
  function showFindings(run: RunRecord): void {
    findings.clear();
    if (!configuration.findingsInEditor) return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const stage of run.stages) {
      if (!stage.review || !stage.verdict) continue;
      for (const finding of stage.verdict.findings) {
        if (!finding.location) continue;
        const reference = fileReference(finding.location);
        const absolute = path.resolve(run.workspacePath, reference.path);
        if (path.relative(run.workspacePath, absolute).startsWith('..')) continue;
        const line = Math.max(0, (reference.line ?? 1) - 1);
        const severity =
          finding.severity === 'blocker' || finding.severity === 'high'
            ? vscode.DiagnosticSeverity.Error
            : finding.severity === 'medium'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information;
        const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), finding.title, severity);
        diagnostic.source = `Dual Agent (${stage.assignedAgent === 'codex' ? 'Codex' : 'Claude'})`;
        byFile.set(absolute, [...(byFile.get(absolute) ?? []), diagnostic]);
      }
    }
    for (const [file, list] of byFile) findings.set(vscode.Uri.file(file), list);
  }

  function showOutcome(run: RunRecord): void {
    const outcome = describeOutcome(run);
    const icon = run.status === 'failed' ? '$(error)' : run.status === 'cancelled' ? '$(circle-slash)' : /agreed|Quick reply|merged/.test(outcome) ? '$(pass)' : '$(warning)';
    outcomeItem.text = `${icon} ${outcome.length > 48 ? `${outcome.slice(0, 47)}…` : outcome}`;
    outcomeItem.tooltip = `Dual Agent: ${outcome}. Click to open the chat.`;
    outcomeItem.show();
  }

  function handleEvent(event: OrchestratorEvent): void {
    chat.handleEvent(event);
    switch (event.type) {
      case 'run-updated':
        runsView.upsert(event.run);
        documents.refresh(event.run.id);
        updateContext(event.run);
        if (isFinished(event.run.status)) {
          showFindings(event.run);
          showOutcome(event.run);
          if (event.run.status === 'failed' && /not logged in|sign in|log in|unauthori[sz]ed|authentication/i.test(event.run.error ?? '')) void agentsView.refresh();
        }
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
    // The log is plain text that may be shared in bug reports, so credentials are masked here too.
    const text = redactSecrets(agentEvent.message).text.replace(/\s+/g, ' ').trim();
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
    const gemini = current.gemini.enabled ? await new GeminiReferee({ command: current.gemini.command, timeoutMs: 30_000, billingMode: current.claude.billingMode }).doctor() : undefined;
    // Whether each installed CLI is signed in, from its own status command.
    const signedIn = async (provider: AccountProvider, available: boolean): Promise<AccountStatus | undefined> => (available ? refreshAccount(provider) : undefined);
    const [claudeAccount, codexAccount, geminiAccount] = await Promise.all([
      signedIn('claude', health[0]?.available === true),
      signedIn('codex', health[1]?.available === true),
      signedIn('gemini', gemini?.available === true),
    ]);
    const agentRow = (id: 'claude' | 'codex' | 'gemini', label: string, available: boolean, version: string | undefined, detail: string, account: AccountStatus | undefined): ToolRow => ({
      id,
      label,
      state: !available ? 'unavailable' : account?.signedIn === false ? 'warning' : 'ready',
      description: !available
        ? 'not available'
        : `${version ?? 'installed'} · ${account?.signedIn ? (account.method ?? 'signed in') : account?.signedIn === false ? 'not signed in' : 'sign-in unknown'}`,
      detail: account ? `${detail} ${account.detail}` : detail,
      ...(available && account?.signedIn !== undefined ? { signedIn: account.signedIn } : {}),
    });
    return [
      ...health.map((item, index) =>
        agentRow(item.agent, item.agent === 'claude' ? 'Claude Code' : 'Codex', item.available, item.version, item.detail, index === 0 ? claudeAccount : codexAccount),
      ),
      {
        id: 'git',
        label: 'Git',
        state: !git.available ? 'unavailable' : git.repository || !workspace ? 'ready' : 'warning',
        description: !git.available ? 'not available' : git.repository || !workspace ? (git.version ?? 'installed') : 'workspace not usable',
        detail: git.detail,
      },
      ...(gemini ? [agentRow('gemini', 'Gemini CLI (referee)', gemini.available, gemini.version, gemini.detail, geminiAccount)] : []),
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
    if (finished?.limitReset || finished?.offlineSince) void paused(finished).catch((error: unknown) => output.error(message(error)));
    else if (finished) void announce(finished).catch((error: unknown) => output.error(message(error)));
    // Queued chat messages run once the lock is free; the timer lets the caller finish first.
    setTimeout(() => void chat.drain(), 0);
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

  /** Suggests a commit message in Source Control after applying, unless the user already typed one. */
  function fillCommitMessage(run: RunRecord): void {
    try {
      const api = (vscode.extensions.getExtension('vscode.git')?.exports as GitExtension | undefined)?.getAPI(1);
      const root = path.resolve(run.worktree?.repositoryRoot ?? run.workspacePath).toLowerCase();
      const repository = api?.repositories.find((item) => path.resolve(item.rootUri.fsPath).toLowerCase() === root);
      if (!repository || repository.inputBox.value.trim()) return;
      const final = [...run.stages].reverse().find((stage) => !stage.review && stage.status === 'completed' && stage.result?.text);
      const summary = final?.result?.text.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#') && !line.startsWith('```'));
      repository.inputBox.value = [titleFor(run.objective), '', ...(summary ? [summary.slice(0, 300), ''] : []), `Made with Dual Agent: ${describeOutcome(run)}.`].join('\n');
    } catch (error) {
      output.debug(`No commit message suggested: ${message(error)}`);
    }
  }

  /** Prefills the chat with a request about a problem or a selection in the editor. */
  async function askAbout(kind: 'fix' | 'explain' | 'ask', uri?: vscode.Uri, range?: vscode.Range, problem?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
    if (!document) throw new Error('Open a file first.');
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const file = folder ? path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join('/') : path.basename(document.uri.fsPath);
    const selection = range ?? (editor && editor.document === document && !editor.selection.isEmpty ? editor.selection : undefined);
    const where = selection ? `${file}:${selection.start.line + 1}${selection.end.line > selection.start.line ? `-${selection.end.line + 1}` : ''}` : file;
    const issues =
      problem ??
      vscode.languages
        .getDiagnostics(document.uri)
        .filter((item) => (selection ? item.range.intersection(selection) : true) && item.severity <= vscode.DiagnosticSeverity.Warning)
        .slice(0, 5)
        .map((item) => item.message.split('\n')[0] ?? '')
        .join('; ');
    const text =
      kind === 'fix'
        ? `Fix ${issues ? `this problem in ${where}: ${issues}` : `the problems in ${where}`}. Keep the change small and explain the cause.`
        : kind === 'explain'
          ? `Explain ${issues ? `this problem in ${where}: ${issues}` : `the code in ${where}`}: what causes it and how to fix it.`
          : `About ${where}: `;
    await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    await chat.prefill(text, kind === 'fix' ? 'edit' : 'chat');
    chat.focusComposer();
  }

  const codeActions: vscode.CodeActionProvider = {
    provideCodeActions: (document, range, context) => {
      if (document.uri.scheme !== 'file' || !context.diagnostics.length) return [];
      const problem = context.diagnostics.map((item) => item.message.split('\n')[0] ?? '').join('; ');
      const fix = new vscode.CodeAction('Fix with Dual Agent', vscode.CodeActionKind.QuickFix);
      fix.command = { command: 'dualAgent.fixProblem', title: 'Fix with Dual Agent', arguments: [document.uri, range, problem] };
      fix.diagnostics = [...context.diagnostics];
      const explain = new vscode.CodeAction('Explain with Dual Agent', vscode.CodeActionKind.QuickFix);
      explain.command = { command: 'dualAgent.explainProblem', title: 'Explain with Dual Agent', arguments: [document.uri, range, problem] };
      return [fix, explain];
    },
  };
  /** The agent a command was run for: a row of the Agents view, an ID, or nothing to ask. */
  const providerOf = (argument: unknown): AccountProvider | undefined => {
    const id = typeof argument === 'string' ? argument : (argument as Partial<ToolRow> | undefined)?.id;
    return id === 'claude' || id === 'codex' || id === 'gemini' ? id : undefined;
  };
  const editorArguments = (args: unknown[]): [vscode.Uri | undefined, vscode.Range | undefined, string | undefined] => [
    args[0] instanceof vscode.Uri ? args[0] : undefined,
    args[1] instanceof vscode.Range ? args[1] : undefined,
    typeof args[2] === 'string' ? args[2] : undefined,
  ];

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
    broker,
    findings,
    outcomeItem,
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, codeActions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.window.onDidChangeActiveTextEditor(() => chat.editorChanged()),
    vscode.window.onDidChangeTextEditorSelection(() => chat.editorChanged()),
    vscode.languages.onDidChangeDiagnostics(() => chat.editorChanged()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (path.resolve(document.uri.fsPath) === path.resolve(briefPath)) void chat.refreshBrief();
    }),

    command('dualAgent.signIn', (argument) => signIn(providerOf(argument))),
    command('dualAgent.signOut', (argument) => signOutOf(providerOf(argument))),
    command('dualAgent.refreshLimits', async () => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Dual Agent: asking for the current limits' }, () => refreshLimits());
      chat.refresh();
    }),
    command('dualAgent.fixProblem', (...args) => askAbout('fix', ...editorArguments(args))),
    command('dualAgent.explainProblem', (...args) => askAbout('explain', ...editorArguments(args))),
    command('dualAgent.askAboutSelection', (...args) => askAbout('ask', ...editorArguments(args))),
    command('dualAgent.editBrief', () => chatHost.editBrief()),
    command('dualAgent.exportConversation', () => chat.receive({ type: 'exportConversation' })),
    command('dualAgent.clearFindings', () => findings.clear()),

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
    command('dualAgent.showUsage', async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
      chat.showUsage();
    }),

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
    command('dualAgent.clearHistory', () =>
      exclusive(async () => {
        const waiting = new Set((await store.list()).filter((run) => run.worktree?.state === 'active').map((run) => run.worktree?.path)).size;
        if (waiting) throw new Error(`${waiting} isolated worktree(s) still hold changes. Apply or discard them first, then delete the history.`);
        const choice = await vscode.window.showWarningMessage(
          'Delete all Dual Agent history for this workspace?',
          { modal: true, detail: 'Every conversation, attachment, and run record is deleted. Files in your workspace are not touched. This cannot be undone.' },
          'Delete History',
        );
        if (choice !== 'Delete History') return undefined;
        await chat.clearHistory();
        await store.clear();
        runsView.setRuns([]);
        output.info('History deleted.');
        void vscode.window.showInformationMessage('Dual Agent: history deleted.');
        return undefined;
      }),
    ),
    command('dualAgent.refreshRuns', async () => runsView.setRuns(await store.list())),
    command('dualAgent.openDocument', (uri) => (uri instanceof vscode.Uri ? openDocument(uri) : undefined)),
    command('dualAgent.openReport', async (argument) => {
      const run = await resolveRun(argument, () => true, 'Which run?');
      if (run) await openDocument(reportUri(run));
    }),
    command('dualAgent.exportRun', async (argument) => {
      const run = await resolveRun(argument, () => true, 'Which run should be exported?');
      if (run) await exportReport(run, configuration.redactSecrets);
    }),
    command('dualAgent.exportLatestRun', async () => {
      const latest = await store.latest();
      if (!latest) throw new Error('There is no run to export.');
      await exportReport(latest, configuration.redactSecrets);
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
      if (worktree.gitDir) {
        // The agents edited the folder itself; keeping the changes only drops the snapshot that could undo them.
        const keep = await vscode.window.showWarningMessage(
          changes.length ? `Keep the ${changes.length} file change(s) the agents made?` : 'The agents did not change any files. Remove the snapshot?',
          {
            modal: true,
            detail: 'The folder is not a Git repository, so the agents edited it directly after Dual Agent took a snapshot. Keeping the changes deletes the snapshot; after that, Dual Agent cannot undo them.',
          },
          'Keep Changes',
        );
        if (keep !== 'Keep Changes') return;
        await markWorktree(worktree, 'applied');
        await removeWorktree(worktree, worktreeRoot).catch((error: unknown) => output.warn(`Snapshot not removed: ${message(error)}`));
        return;
      }
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
      fillCommitMessage(run);
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
      const worktree = run.worktree;
      const direct = Boolean(worktree.gitDir);
      const choice = await vscode.window.showWarningMessage(
        direct ? 'Undo the agents\' changes to your folder?' : 'Discard this run\'s changes?',
        {
          modal: true,
          detail: direct
            ? 'Every file the agents changed is put back as it was when the message started, and files they created are deleted. Folders the snapshot skips, such as node_modules, .venv, and build output, are left as they are. This cannot be undone.'
            : 'The isolated worktree and every change in it are deleted. Your workspace is not touched. This cannot be undone.',
        },
        direct ? 'Undo Changes' : 'Discard Changes',
      );
      if (choice !== (direct ? 'Undo Changes' : 'Discard Changes')) return;
      if (direct) await restoreWorktree(worktree, worktree.baseCommit);
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
      if (event.affectsConfiguration('dualAgent.usage')) {
        watchLocalUsage();
        scheduleLocalScan(0);
      }
      void agentsView.refresh();
      chat.refresh();
    }),
    { dispose: () => detach() },
    { dispose: () => continuations.dispose() },
    {
      dispose: () => {
        if (localTimer) clearTimeout(localTimer);
        for (const watcher of localWatchers.splice(0)) watcher.close();
      },
    },
    // Stops any agent still running when the extension shuts down.
    { dispose: () => void orchestrator.cancel('VS Code closed while the message was running.') },
  );

  reportProblems(configuration);
  attach();
  updateContext();
  watchLocalUsage();
  // The first read waits until VS Code has finished starting.
  scheduleLocalScan(10_000);
  setTimeout(() => void agentsView.refresh(), 5_000);
  try {
    const recovered = await orchestrator.recoverInterrupted();
    if (recovered.length) output.warn(`${recovered.length} run(s) were interrupted when VS Code closed; resume them from the Runs view.`);
    runsView.setRuns(await store.list());
  } catch (error) {
    output.error(`Run history could not be read: ${message(error)}`);
  }
  return {
    chatReady: () => chat.hasReadyView,
    chatState: () => chat.snapshot(),
    chatMessage: (value) => chat.receive(value),
    chatErrors: () => chat.pageErrors,
  };
}

interface GitExtension {
  getAPI(version: 1): { repositories: { rootUri: vscode.Uri; inputBox: { value: string } }[] };
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
  permissionBridge?: { configFile: string; tool: string },
): WorkflowOrchestrator {
  return new WorkflowOrchestrator(
    {
      claude: new ClaudeCliAdapter({ ...configuration.claude, ...(permissionBridge ? { permissionBridge } : {}) }),
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
      redactSecrets: configuration.redactSecrets,
    },
    dependencies,
  );
}

async function exportReport(run: RunRecord, redact: boolean): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    // Reports contain prompts and agent output; defaulting outside the repository avoids committing them.
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `dual-agent-run-${run.id.slice(0, 8)}.md`)),
    filters: { Markdown: ['md'] },
  });
  if (!target) return;
  // A report leaves private storage, so credentials an agent quoted are masked unless masking is turned off.
  const report = renderRunReport(run);
  await writeFile(target.fsPath, redact ? redactSecrets(report).text : report, 'utf8');
  await vscode.window.showTextDocument(target);
}

export function deactivate(): void {}
