import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import * as vscode from 'vscode';

import type { CodexModel } from '../../adapters/models.js';
import { CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, isModelName, sanitizeAgentOptions } from '../../core/agentOptions.js';
import {
  ATTACHMENT_LIMITS,
  AttachmentError,
  looksSensitive,
  mentionAttachment,
  removeAttachmentFolder,
  storeAttachment,
  type AttachmentSource,
} from '../../core/attachments.js';
import {
  continuedSessions,
  conversationHistory,
  FileConversationStore,
  missedTurns,
  newConversation,
  recordRun,
  titleFor,
  type Conversation,
  type ConversationTurn,
} from '../../core/conversation.js';
import { isSmallTalk } from '../../core/about.js';
import { formatReset, type AgentLimit } from '../../core/limits.js';
import { editsFiles } from '../../core/orchestrator.js';
import type { AgentId, AgentOptions, AttachmentRef, OrchestratorEvent, RunRecord, StartOptions, WorkflowKind, WorktreeInfo } from '../../core/types.js';
import { isFinished } from '../../core/types.js';
import type { WorktreeChange } from '../../core/worktree.js';
import {
  fileReference,
  linkTarget,
  parseWebviewMessage,
  type AgentChoices,
  type ChatState,
  type ConsentView,
  type HostMessage,
  type ModelChoice,
  type Tone,
  type WebviewMessage,
} from './protocol.js';
import { applyLiveEvent, attachmentView, conversationSummaries, transcript, usageOverview, type LiveStage } from './transcript.js';

const COMPOSER_KEY = 'dualAgent.chat.composer';
const CURRENT_KEY = 'dualAgent.chat.current';
const QUEUE_KEY = 'dualAgent.chat.queue';
const QUEUE_LIMIT = 20;
const MAX_CONVERSATIONS = 50;
const PUSH_DELAY_MS = 100;
const PAGE_ERROR_LIMIT = 20;
/** Share of the context budget given to the conversation's earlier turns. */
const HISTORY_SHARE = 0.3;
const MODES: readonly WorkflowKind[] = ['chat', 'research', 'edit', 'brainstorming', 'implementation'];
const STATUS_LETTERS: Record<string, WorktreeChange['status']> = { A: 'added', M: 'modified', D: 'deleted', T: 'type-changed' };

/** What the chat needs from the extension: its single-run lock, the orchestrator, settings, and commands. */
export interface ChatHost {
  readonly storagePath: string;
  /** The folder new conversations work in, or why the chat cannot run here. */
  folder(): { path: string; name: string } | { blocked: string };
  isBusy(): boolean;
  /** Runs `task` while holding the extension's single-run lock. */
  exclusive(task: () => Promise<RunRecord | undefined>): Promise<void>;
  start(kind: WorkflowKind, objective: string, folder: string, allowWrites: boolean, options: StartOptions): Promise<RunRecord>;
  resume(runId: string, allowWrites: boolean): Promise<RunRecord>;
  cancel(): void;
  /** What the user agrees to before agents edit files, for the consent card. */
  consentDetails(folder: string, kind: WorkflowKind): string[];
  /** Changes when the setup or verification commands change, so consent is asked again. */
  commandsSignature(): string;
  maxContextCharacters(): number;
  loadRuns(): Promise<RunRecord[]>;
  listChanges(worktree: WorktreeInfo): Promise<WorktreeChange[]>;
  worktreeExists(worktree: WorktreeInfo): Promise<boolean>;
  codexModels(): Promise<CodexModel[]>;
  extractPdfText(data: Uint8Array): Promise<string>;
  pendingApprovalRunId(): string | undefined;
  approve(notes: string): void;
  reject(): void;
  openPlan(runId: string): Promise<void>;
  openStage(runId: string, index: number): Promise<void>;
  openReport(runId: string): Promise<void>;
  log(message: string): void;
  /** Usage limits in force, earliest reset first; while one agent is limited, the other works alone. */
  limits(): AgentLimit[];
  /** When a run that stopped at the usage limits continues on its own, if it is scheduled to. */
  continuation(runId: string): string | undefined;
  /** Runs waiting to continue after the usage limits reset; queued messages wait for them. */
  pendingContinuations(): number;
  scheduleContinuation(runId: string): void;
  cancelContinuation(runId: string): void;
  /** Records the worktree's files, so a later retry can put them back. */
  checkpointWorktree(worktree: WorktreeInfo): Promise<string>;
  /** Puts the worktree back to a checkpoint, or discards it when there is no checkpoint tree. */
  rewindWorktree(worktree: WorktreeInfo, tree: string | undefined): Promise<void>;
}

/** A message waiting for the running one to finish, or for the agents' usage limits to reset. */
interface QueuedMessage {
  id: string;
  conversationId: string;
  text: string;
  mode: WorkflowKind;
  attachments: AttachmentRef[];
  agentOptions: Record<AgentId, AgentOptions>;
  web: boolean;
  /** A retried message: its run starts new sessions instead of continuing ones that saw what it replaces. */
  fresh?: boolean;
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
  const item = value as Partial<QueuedMessage> | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.id === 'string' &&
    typeof item.conversationId === 'string' &&
    typeof item.text === 'string' &&
    typeof item.mode === 'string' &&
    MODES.includes(item.mode) &&
    Array.isArray(item.attachments)
  );
}

interface Composer {
  mode: WorkflowKind;
  options: Record<AgentId, AgentOptions>;
  web: boolean;
}

interface PendingConsent {
  view: ConsentView;
  settle: (decision: 'once' | 'conversation' | 'deny') => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Owns the conversations and everything the chat shows. Runs go through the same orchestrator, lock, and
 * consent as the commands; the chat only decides how a message becomes a run and how the result is shown.
 */
export class ChatController implements vscode.Disposable {
  private readonly store: FileConversationStore;
  private readonly attachmentRoot: string;
  private conversations: Conversation[] = [];
  private current: Conversation | undefined;
  private readonly runs = new Map<string, RunRecord>();
  private readonly live = new Map<string, Map<string, LiveStage>>();
  private readonly changes = new Map<string, WorktreeChange[]>();
  /** Recording of finished runs on their turns, which sending waits for before it reports completion. */
  private readonly finishing = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, AttachmentRef[]>();
  /** Conversations whose edits were allowed for the rest of the session, with the commands then configured. */
  private readonly allowedEdits = new Map<string, string>();
  private composer: Composer;
  private codexModels: CodexModel[] = [];
  private consent: PendingConsent | undefined;
  private notice: { text: string; tone: Tone } | undefined;
  /** The turn whose run is starting; the run's first update links the two. */
  private starting: { conversation: Conversation; turn: ConversationTurn } | undefined;
  private readonly webviews = new Map<vscode.Webview, { toUri: (file: string) => string }>();
  /** Webviews whose script has loaded and asked for the state. */
  private readonly ready = new Set<vscode.Webview>();
  private pushTimer: NodeJS.Timeout | undefined;
  private loaded: Promise<void> | undefined;
  /** Errors the webviews reported this session, for the smoke test. */
  public readonly pageErrors: string[] = [];
  /** Messages sent while another was running, run in order once it finishes. */
  private queue: QueuedMessage[] = [];
  /** A message is between being sent and its run starting, for example while its consent card waits. */
  private sending = false;
  private draining = false;
  /** Drains the queue once the agents' usage limits reset. */
  private limitTimer: NodeJS.Timeout | undefined;
  /** The earlier message whose text is in the composer; sending replaces it. */
  private editing: { conversationId: string; turnId: string } | undefined;

  public constructor(
    private readonly host: ChatHost,
    private readonly memento: { global: vscode.Memento; workspace: vscode.Memento },
  ) {
    this.store = new FileConversationStore(host.storagePath);
    this.attachmentRoot = path.join(host.storagePath, 'attachments');
    this.composer = this.readComposer();
    this.queue = (memento.workspace.get<unknown[]>(QUEUE_KEY) ?? []).filter(isQueuedMessage);
  }

  private saveQueue(): void {
    void this.memento.workspace.update(QUEUE_KEY, this.queue);
  }

  /** Folders a webview may load files from: stored attachments, for thumbnails. */
  public get resourceRoot(): string {
    return this.attachmentRoot;
  }

  public get hasVisibleView(): boolean {
    return this.visible();
  }

  private visible: () => boolean = () => false;

  public setVisibility(check: () => boolean): void {
    this.visible = check;
  }

  private readComposer(): Composer {
    const stored = this.memento.global.get<Partial<Composer>>(COMPOSER_KEY) ?? {};
    const mode = stored.mode && MODES.includes(stored.mode) ? stored.mode : 'chat';
    return {
      mode,
      options: { claude: sanitizeAgentOptions('claude', stored.options?.claude), codex: sanitizeAgentOptions('codex', stored.options?.codex) },
      web: stored.web === true,
    };
  }

  private saveComposer(): void {
    void this.memento.global.update(COMPOSER_KEY, this.composer);
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.conversations = await this.store.list();
        for (const run of await this.host.loadRuns()) this.runs.set(run.id, run);
        const currentId = this.memento.workspace.get<string>(CURRENT_KEY);
        this.current = this.conversations.find((conversation) => conversation.id === currentId);
        await this.refreshChanges();
      } catch (error) {
        this.host.log(`Conversations could not be read: ${message(error)}`);
      }
      void this.host.codexModels().then((models) => {
        this.codexModels = models;
        this.schedule();
      });
      // Messages queued before VS Code closed run once it has started.
      if (this.queue.length) setTimeout(() => void this.drain(), 2_000);
    })();
    return this.loaded;
  }

  // ---- Webviews ----

  /** Connects a webview (the side view or an editor tab); returns a disposable that disconnects it. */
  public attach(webview: vscode.Webview, toUri: (file: string) => string): vscode.Disposable {
    this.webviews.set(webview, { toUri });
    const subscription = webview.onDidReceiveMessage((raw: unknown) => {
      const parsed = parseWebviewMessage(raw);
      if (parsed) void this.handle(parsed, webview).catch((error: unknown) => this.show(message(error), 'bad'));
    });
    return new vscode.Disposable(() => {
      subscription.dispose();
      this.webviews.delete(webview);
      this.ready.delete(webview);
    });
  }

  private post(webview: vscode.Webview, value: HostMessage): void {
    void webview.postMessage(value);
  }

  private schedule(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.push();
    }, PUSH_DELAY_MS);
  }

  /** Called with the conversation's title, so the editor tab and view header can show it. */
  public onTitle: ((title: string) => void) | undefined;

  private push(): void {
    for (const [webview, { toUri }] of this.webviews) this.post(webview, { type: 'state', state: this.state(toUri) });
    this.onTitle?.(this.current?.title ?? 'New conversation');
  }

  /** Opens the usage panel in the chat, once a chat page has loaded. */
  public showUsage(): void {
    if (!this.ready.size) {
      this.usageRequested = true;
      return;
    }
    for (const webview of this.ready) this.post(webview, { type: 'showUsage' });
  }

  private usageRequested = false;

  public focusComposer(): void {
    for (const webview of this.webviews.keys()) this.post(webview, { type: 'focus' });
  }

  private choices(): Record<AgentId, AgentChoices> {
    const claudeModels: ModelChoice[] = [
      { id: '', label: 'Default', efforts: [...CLAUDE_EFFORTS] },
      ...CLAUDE_MODELS.map((id) => ({ id, label: capitalize(id), efforts: [...CLAUDE_EFFORTS] })),
    ];
    const codexModels: ModelChoice[] = [
      { id: '', label: 'Default', efforts: [...CODEX_EFFORTS] },
      ...this.codexModels.map((model) => ({ id: model.id, label: model.name, efforts: model.efforts })),
    ];
    // A custom model the user typed stays selectable.
    for (const [agent, models] of [['claude', claudeModels], ['codex', codexModels]] as const) {
      const chosen = this.composer.options[agent].model;
      if (chosen && !models.some((model) => model.id === chosen)) {
        models.push({ id: chosen, label: chosen, efforts: agent === 'claude' ? [...CLAUDE_EFFORTS] : [...CODEX_EFFORTS] });
      }
    }
    return {
      claude: { models: claudeModels, efforts: [...CLAUDE_EFFORTS] },
      codex: { models: codexModels, efforts: [...CODEX_EFFORTS] },
    };
  }

  private state(toUri: (file: string) => string): ChatState {
    const folder = this.host.folder();
    const conversation = this.current;
    const pending = conversation ? (this.pending.get(conversation.id) ?? []) : [];
    const activeRunId = this.activeRunId();
    const awaitingApprovalRunId = this.host.pendingApprovalRunId();
    const thumbnail = (attachment: AttachmentRef): string | undefined =>
      attachment.kind === 'image' && !attachment.workspaceRelative ? toUri(attachment.path) : undefined;
    const today = new Date();
    const dayStartMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const state: ChatState = {
      title: conversation?.title ?? 'New conversation',
      usage: usageOverview(conversation, { runs: this.runs.values(), dayStartMs, weekStartMs: dayStartMs - 6 * 86_400_000 }),
      conversations: conversationSummaries(this.conversations, Date.now()),
      turns: conversation
        ? transcript({
            conversation,
            runs: this.runs,
            live: this.live,
            changes: this.changes,
            ...(activeRunId ? { activeRunId } : {}),
            ...(awaitingApprovalRunId ? { awaitingApprovalRunId } : {}),
            thumbnail,
            idle: !this.host.isBusy() && !this.sending,
            continuation: (runId) => this.host.continuation(runId),
          })
        : [],
      running: this.host.isBusy() || this.sending,
      composer: {
        mode: this.composer.mode,
        web: this.composer.web || this.composer.mode === 'research',
        options: this.composer.options,
        pending: pending.map((attachment) => attachmentView(attachment, thumbnail(attachment))),
        choices: this.choices(),
      },
      queue: this.queue.map((item) => {
        const owner = item.conversationId === conversation?.id ? undefined : this.conversations.find((entry) => entry.id === item.conversationId);
        return { id: item.id, text: item.text, mode: item.mode, ...(owner ? { conversation: owner.title } : {}) };
      }),
      limits: this.host.limits().map((limit) => ({ agent: limit.agent, until: formatReset(limit.until), estimated: limit.estimated })),
    };
    const edited = this.editing && conversation?.id === this.editing.conversationId ? conversation.turns.find((turn) => turn.id === this.editing?.turnId) : undefined;
    if (edited) state.composer.editing = { turnId: edited.id, preview: titleFor(edited.message) };
    if ('blocked' in folder) state.blocked = folder.blocked;
    else state.folder = conversation ? path.basename(conversation.workspacePath) : folder.name;
    if (conversation) state.conversationId = conversation.id;
    if (this.consent) state.consent = this.consent.view;
    if (this.notice) state.notice = this.notice;
    return state;
  }

  private activeRunId(): string | undefined {
    const turn = this.starting?.turn;
    if (turn?.runId) return turn.runId;
    for (const run of this.runs.values()) if (!isFinished(run.status)) return run.id;
    return undefined;
  }

  private show(text: string, tone: Tone = 'warn'): void {
    this.notice = { text, tone };
    this.schedule();
  }

  // ---- Orchestrator events ----

  public handleEvent(event: OrchestratorEvent): void {
    const run = event.run;
    // Every run counts toward the usage totals; only conversation runs appear in the transcript.
    if (event.type === 'run-updated') this.runs.set(run.id, run);
    if (!run.conversationId) {
      if (event.type === 'run-updated' && isFinished(run.status)) this.schedule();
      return;
    }
    if (event.type === 'run-updated') {
      const starting = this.starting;
      if (starting && !starting.turn.runId && run.conversationId === starting.conversation.id) {
        starting.turn.runId = run.id;
        void this.store.save(starting.conversation);
      }
      if (isFinished(run.status)) this.finishing.set(run.id, this.finish(run).catch((error: unknown) => this.host.log(message(error))));
      this.schedule();
      return;
    }
    if (event.type === 'agent-event' && event.agentEvent && event.stageId) {
      let stages = this.live.get(run.id);
      if (!stages) this.live.set(run.id, (stages = new Map<string, LiveStage>()));
      let stage = stages.get(event.stageId);
      if (!stage) stages.set(event.stageId, (stage = { text: '' }));
      applyLiveEvent(stage, event.agentEvent);
      this.schedule();
    }
  }

  /** Records a finished run on its turn, whoever started it (the chat, the Runs view, or a resume). */
  private async finish(run: RunRecord): Promise<void> {
    this.live.delete(run.id);
    const conversation = this.conversations.find((item) => item.id === run.conversationId);
    const turn = conversation?.turns.find((item) => item.runId === run.id);
    if (!conversation || !turn) return;
    recordRun(turn, run);
    await this.store.save(conversation);
    await this.refreshChanges();
    this.schedule();
  }

  /** Lists the changes waiting in each conversation's latest worktree. */
  private async refreshChanges(): Promise<void> {
    const latest = new Map<string, RunRecord>();
    for (const run of this.runs.values()) {
      if (!run.worktree || run.worktree.state !== 'active' || !run.conversationId || !isFinished(run.status)) continue;
      const previous = latest.get(run.worktree.path);
      if (!previous || previous.createdAt < run.createdAt) latest.set(run.worktree.path, run);
    }
    this.changes.clear();
    for (const run of latest.values()) {
      if (!run.worktree) continue;
      try {
        this.changes.set(run.id, await this.host.listChanges(run.worktree));
      } catch (error) {
        this.host.log(`Changes could not be listed: ${message(error)}`);
      }
    }
  }

  /** Called after changes are applied or discarded, which updates every run that shared the worktree. */
  public async runsChanged(): Promise<void> {
    for (const run of await this.host.loadRuns()) this.runs.set(run.id, run);
    await this.refreshChanges();
    this.schedule();
  }

  // ---- Conversations ----

  private conversationFolder(conversation: Conversation): string {
    return path.join(this.attachmentRoot, conversation.id);
  }

  /** The current conversation, created on first use in the folder the chat works in. */
  private ensureConversation(): Conversation {
    if (this.current) return this.current;
    const folder = this.host.folder();
    if ('blocked' in folder) throw new Error(folder.blocked);
    const conversation = newConversation(folder.path);
    this.conversations.unshift(conversation);
    this.select(conversation);
    return conversation;
  }

  private select(conversation: Conversation | undefined): void {
    this.current = conversation;
    void this.memento.workspace.update(CURRENT_KEY, conversation?.id);
  }

  public async newConversation(): Promise<void> {
    await this.load();
    if (this.current && !this.current.turns.length) return;
    this.select(undefined);
    this.notice = undefined;
    this.schedule();
  }

  private async deleteConversation(id: string): Promise<void> {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return;
    if (conversation.turns.some((turn) => turn.runId === this.activeRunId())) throw new Error('Stop the running message before deleting its conversation.');
    const waiting = [...this.changes.keys()].some((runId) => this.runs.get(runId)?.conversationId === id);
    const choice = await vscode.window.showWarningMessage(
      `Delete "${conversation.title}"?`,
      {
        modal: true,
        detail: `Its messages and attachments are deleted.${waiting ? ' Its unapplied changes stay available from the Runs view until you apply or discard them.' : ''}`,
      },
      'Delete',
    );
    if (choice !== 'Delete') return;
    await this.store.delete(id);
    await removeAttachmentFolder(this.attachmentRoot, this.conversationFolder(conversation)).catch(() => undefined);
    this.conversations = this.conversations.filter((item) => item !== conversation);
    this.pending.delete(id);
    this.queue = this.queue.filter((item) => item.conversationId !== id);
    this.saveQueue();
    if (this.editing?.conversationId === id) this.editing = undefined;
    if (this.current === conversation) this.select(undefined);
  }

  /** Deletes every conversation and attachment. The caller holds the run lock and deletes the run records. */
  public async clearHistory(): Promise<void> {
    await this.load();
    await this.store.clear();
    await rm(this.attachmentRoot, { recursive: true, force: true });
    this.conversations = [];
    this.select(undefined);
    for (const map of [this.runs, this.live, this.changes, this.pending, this.allowedEdits]) map.clear();
    this.queue = [];
    this.saveQueue();
    this.editing = undefined;
    this.notice = undefined;
    this.schedule();
  }

  private async save(conversation: Conversation): Promise<void> {
    await this.store.save(conversation);
    this.conversations = [conversation, ...this.conversations.filter((item) => item !== conversation)];
    const protectedIds = new Set([...this.changes.keys()].map((runId) => this.runs.get(runId)?.conversationId));
    const removed = await this.store.prune(MAX_CONVERSATIONS, (item) => item.id === this.current?.id || protectedIds.has(item.id));
    for (const item of removed) {
      await removeAttachmentFolder(this.attachmentRoot, this.conversationFolder(item)).catch(() => undefined);
      this.conversations = this.conversations.filter((existing) => existing.id !== item.id);
    }
  }

  // ---- Attachments ----

  private async addAttachments(sources: AttachmentSource[]): Promise<void> {
    const conversation = this.ensureConversation();
    const list = this.pending.get(conversation.id) ?? [];
    this.pending.set(conversation.id, list);
    for (const source of sources) {
      if (list.length >= ATTACHMENT_LIMITS.files) {
        this.show(`A message can have at most ${ATTACHMENT_LIMITS.files} attachments.`);
        break;
      }
      if (looksSensitive(source.name)) {
        const choice = await vscode.window.showWarningMessage(
          `${source.name} may contain secrets. Attach it anyway?`,
          { modal: true, detail: 'Attachments are sent to Claude and Codex as part of your message.' },
          'Attach',
        );
        if (choice !== 'Attach') continue;
      }
      const total = list.reduce((sum, item) => sum + item.size, 0);
      try {
        const stored = await storeAttachment(this.conversationFolder(conversation), source, { extractPdfText: (data) => this.host.extractPdfText(data) });
        if (total + stored.size > ATTACHMENT_LIMITS.messageBytes) {
          await this.deleteStored(stored);
          this.show('The attachments of one message can total at most 100 MB.');
          break;
        }
        list.push(stored);
      } catch (error) {
        this.show(error instanceof AttachmentError ? error.message : `${source.name} could not be attached: ${message(error)}`);
      }
    }
    this.schedule();
  }

  private async deleteStored(attachment: AttachmentRef): Promise<void> {
    if (attachment.workspaceRelative) return;
    for (const file of [attachment.path, attachment.textPath, attachment.extractedPath]) {
      if (file && path.resolve(file).startsWith(path.resolve(this.attachmentRoot) + path.sep)) await rm(file, { recursive: true, force: true });
    }
  }

  private async pickFiles(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', title: 'Attach files to your message' });
    if (picked?.length) await this.addAttachments(picked.map((uri) => ({ name: path.basename(uri.fsPath), path: uri.fsPath })));
  }

  private async searchMentions(webview: vscode.Webview, query: string): Promise<void> {
    const pattern = query.replace(/[[\]{}()*?!\\]/g, '');
    const files = await vscode.workspace.findFiles(`**/*${pattern}*`, '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}', 30);
    const folder = this.current?.workspacePath ?? ('path' in this.host.folder() ? (this.host.folder() as { path: string }).path : '');
    const items = files
      .filter((uri) => uri.scheme === 'file' && folder && !path.relative(folder, uri.fsPath).startsWith('..'))
      .map((uri) => {
        const relative = path.relative(folder, uri.fsPath).replace(/\\/g, '/');
        return { path: relative, description: path.dirname(relative) === '.' ? '' : path.dirname(relative) };
      })
      .sort((a, b) => a.path.length - b.path.length)
      .slice(0, 12);
    this.post(webview, { type: 'mentions', query, items });
  }

  private async addMention(relative: string): Promise<void> {
    const conversation = this.ensureConversation();
    const list = this.pending.get(conversation.id) ?? [];
    this.pending.set(conversation.id, list);
    try {
      list.push(await mentionAttachment(conversation.workspacePath, relative));
    } catch (error) {
      this.show(message(error));
    }
    this.schedule();
  }

  // ---- Sending ----

  private async askConsent(conversation: Conversation, turn: ConversationTurn): Promise<boolean> {
    const signature = this.host.commandsSignature();
    if (this.allowedEdits.get(conversation.id) === signature) return true;
    const decision = await new Promise<'once' | 'conversation' | 'deny'>((resolve) => {
      this.consent = {
        view: { turnId: turn.id, mode: turn.mode, details: this.host.consentDetails(path.basename(conversation.workspacePath), turn.mode) },
        settle: resolve,
      };
      this.schedule();
      if (!this.visible()) void vscode.commands.executeCommand('dualAgent.chat.focus');
    });
    this.consent = undefined;
    if (decision === 'conversation') this.allowedEdits.set(conversation.id, signature);
    return decision !== 'deny';
  }

  /** The active worktree a new edit turn of this conversation keeps working in. */
  private async conversationWorktree(conversation: Conversation): Promise<WorktreeInfo | undefined> {
    for (const turn of [...conversation.turns].reverse()) {
      const worktree = turn.runId ? this.runs.get(turn.runId)?.worktree : undefined;
      if (worktree?.state === 'active') return (await this.host.worktreeExists(worktree)) ? worktree : undefined;
      if (worktree) return undefined;
    }
    return undefined;
  }

  /** Sends the composer's message: now, or into the queue while another message runs or the agents are at their limits. */
  private async submit(text: string, mode: WorkflowKind): Promise<void> {
    if (this.editing) {
      const target = this.editing;
      this.editing = undefined;
      await this.retry(target.turnId, text, mode);
      return;
    }
    const conversation = this.ensureConversation();
    const item: QueuedMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      text: text.trim(),
      mode,
      attachments: this.pending.get(conversation.id) ?? [],
      agentOptions: { claude: { ...this.composer.options.claude }, codex: { ...this.composer.options.codex } },
      web: this.composer.web || mode === 'research',
    };
    this.pending.delete(conversation.id);
    const waitFor = this.waitReason();
    if (waitFor) {
      if (this.queue.length >= QUEUE_LIMIT) {
        this.pending.set(conversation.id, item.attachments);
        this.show(`At most ${QUEUE_LIMIT} messages can wait in the queue.`, 'warn');
        return;
      }
      this.queue.push(item);
      this.saveQueue();
      this.show(`Queued: it runs ${waitFor}.`, 'neutral');
      this.armLimitTimer();
      return;
    }
    await this.runMessage(item);
  }

  /** Why a new message has to wait, as the end of "it runs …", or undefined when it can run now. */
  private waitReason(): string | undefined {
    if (this.host.isBusy() || this.sending || this.draining) return 'after the current message';
    if (this.queue.length) return 'after the messages ahead of it';
    if (this.host.pendingContinuations()) return 'after the paused message continues';
    const limits = this.host.limits();
    if (limits.length >= 2) return `when the first usage limit resets, at ${formatReset(limits[0]?.until ?? new Date())}`;
    return undefined;
  }

  /** Runs queued messages in order while nothing else is running and the agents can work. */
  public async drain(): Promise<void> {
    if (this.draining) return;
    await this.load();
    this.draining = true;
    try {
      while (this.queue.length && !this.host.isBusy() && !this.sending && !this.host.pendingContinuations() && this.host.limits().length < 2) {
        const item = this.queue.shift();
        this.saveQueue();
        if (item) await this.runMessage(item);
      }
    } finally {
      this.draining = false;
      this.schedule();
    }
    this.armLimitTimer();
  }

  /** While both agents are at their limits, checks the queue again when the first limit resets. */
  private armLimitTimer(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = undefined;
    const [first, second] = this.host.limits();
    if (!this.queue.length || !first || !second) return;
    const delay = Math.min(2_147_483_647, Math.max(1_000, Date.parse(first.until) - Date.now() + 60_000));
    this.limitTimer = setTimeout(() => void this.drain(), delay);
  }

  /**
   * Runs an earlier message again: the messages after it are removed, the file changes made from it on are
   * undone in the conversation's isolated copy, and the agents start new sessions so nothing removed carries over.
   */
  private async retry(turnId: string, text?: string, mode?: WorkflowKind): Promise<void> {
    await this.load();
    if (this.host.isBusy() || this.sending) {
      this.show('Wait for the running message to finish, or stop it, before retrying an earlier one.');
      return;
    }
    const conversation = this.conversations.find((item) => item.turns.some((turn) => turn.id === turnId));
    const index = conversation?.turns.findIndex((turn) => turn.id === turnId) ?? -1;
    const turn = conversation?.turns[index];
    if (!conversation || !turn) return;
    const later = conversation.turns.slice(index + 1);
    const undo = this.rewindPlan(conversation.turns.slice(index));
    const effects: string[] = [];
    if (later.length) effects.push(`The ${later.length} message${later.length === 1 ? '' : 's'} after it ${later.length === 1 ? 'is' : 'are'} removed from the conversation.`);
    if (undo?.kind === 'restore') effects.push('File changes made from this message on are undone in the isolated copy.');
    if (undo?.kind === 'discard') effects.push('The isolated copy holding the changes from this message on is discarded.');
    if (undo?.kind === 'applied') effects.push('Changes already applied to your workspace are not undone; review them in Source Control.');
    // Retrying the last message undoes only its own work, which is what retrying means; anything more is confirmed.
    if (later.length || undo?.kind === 'applied') {
      const choice = await vscode.window.showWarningMessage(`${text === undefined ? 'Retry' : 'Edit and resend'} this message?`, { modal: true, detail: effects.join(' ') }, 'Retry');
      if (choice !== 'Retry') return;
    }
    try {
      if (undo?.kind === 'restore') await this.host.rewindWorktree(undo.worktree, undo.tree);
      else if (undo?.kind === 'discard') await this.host.rewindWorktree(undo.worktree, undefined);
    } catch (error) {
      this.show(`The file changes could not be undone, so nothing was retried: ${message(error)}`, 'bad');
      return;
    }
    conversation.turns.splice(index);
    this.select(conversation);
    await this.save(conversation);
    await this.refreshChanges();
    this.notice = undefined;
    await this.runMessage({
      id: randomUUID(),
      conversationId: conversation.id,
      text: (text ?? turn.message).trim(),
      mode: mode ?? turn.mode,
      attachments: turn.attachments,
      // The current choices apply, so a retry can use a stronger model or more effort.
      agentOptions: { claude: { ...this.composer.options.claude }, codex: { ...this.composer.options.codex } },
      web: this.composer.web || turn.web === true || (mode ?? turn.mode) === 'research',
      fresh: true,
    });
  }

  /** What retrying from the first of `turns` does to files: the first checkpoint among them decides. */
  private rewindPlan(
    turns: readonly ConversationTurn[],
  ): { kind: 'restore'; worktree: WorktreeInfo; tree: string } | { kind: 'discard'; worktree: WorktreeInfo } | { kind: 'applied' } | undefined {
    for (const turn of turns) {
      const worktree = turn.checkpoint && turn.runId ? this.runs.get(turn.runId)?.worktree : undefined;
      if (!turn.checkpoint || !worktree) continue;
      if (worktree.state === 'applied') return { kind: 'applied' };
      if (worktree.state !== 'active') return undefined;
      return turn.checkpoint.tree ? { kind: 'restore', worktree, tree: turn.checkpoint.tree } : { kind: 'discard', worktree };
    }
    return undefined;
  }

  private async runMessage(item: QueuedMessage): Promise<void> {
    const conversation = this.conversations.find((entry) => entry.id === item.conversationId);
    if (!conversation) return;
    if (this.current !== conversation) this.select(conversation);
    this.sending = true;
    try {
      await this.startMessage(conversation, item);
    } finally {
      this.sending = false;
      this.schedule();
    }
  }

  private async startMessage(conversation: Conversation, item: QueuedMessage): Promise<void> {
    const { attachments } = item;
    // A greeting or a question about the assistant gets a quick reply in any mode, so "hi" never asks to edit files.
    const smallTalk = !attachments.length && isSmallTalk(item.text);
    const mode: WorkflowKind = smallTalk ? 'chat' : item.mode;
    const earlier = { ...conversation, turns: [...conversation.turns] };
    const turn: ConversationTurn = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      mode,
      message: item.text,
      attachments,
      agentOptions: item.agentOptions,
      ...(item.web && !smallTalk ? { web: true } : {}),
      ...(item.fresh ? { freshSessions: true } : {}),
    };
    if (!conversation.turns.length) conversation.title = titleFor(turn.message);
    conversation.turns.push(turn);
    this.notice = undefined;
    await this.save(conversation);
    this.schedule();

    const allowWrites = editsFiles(mode) && (await this.askConsent(conversation, turn));
    if (editsFiles(mode) && !allowWrites) {
      turn.status = 'cancelled';
      turn.outcome = 'Not started: editing was not allowed';
      await this.save(conversation);
      this.schedule();
      return;
    }

    await this.host.exclusive(async () => {
      this.starting = { conversation, turn };
      try {
        const worktree = editsFiles(mode) ? await this.conversationWorktree(conversation) : undefined;
        if (editsFiles(mode)) await this.checkpoint(turn, worktree);
        const budget = Math.floor(this.host.maxContextCharacters() * HISTORY_SHARE);
        const history = conversationHistory(earlier, budget);
        const sessions = item.fresh ? {} : continuedSessions(earlier);
        const catchUp = missedTurns(earlier, sessions, budget);
        const options: StartOptions = {
          conversationId: conversation.id,
          ...(attachments.length ? { attachments } : {}),
          agentOptions: item.agentOptions,
          ...(history ? { history } : {}),
          ...(Object.keys(sessions).length ? { continueSessions: sessions } : {}),
          ...(Object.keys(catchUp).length ? { catchUp } : {}),
          ...(worktree ? { worktree } : {}),
          ...(turn.web ? { web: true } : {}),
        };
        const finished = await this.host.start(mode, turn.message, conversation.workspacePath, allowWrites, options);
        // The turn shows its answer and changes only once the finished run has been recorded on it.
        await this.finishing.get(finished.id);
        return finished;
      } catch (error) {
        turn.status = 'failed';
        turn.error = message(error);
        turn.outcome = `Failed: ${turn.error}`;
        await this.save(conversation);
        return undefined;
      } finally {
        this.starting = undefined;
        this.schedule();
      }
    });
  }

  /** Records the conversation's worktree before an edit turn, so retrying from it can undo the turn. */
  private async checkpoint(turn: ConversationTurn, worktree: WorktreeInfo | undefined): Promise<void> {
    if (!worktree) {
      turn.checkpoint = {};
      return;
    }
    try {
      turn.checkpoint = { tree: await this.host.checkpointWorktree(worktree) };
    } catch (error) {
      // Without a checkpoint the turn still runs; retrying from it cannot undo its file changes.
      this.host.log(`No checkpoint before this edit: ${message(error)}`);
    }
  }

  /**
   * Continues a message that stopped at the usage limits, once they have reset. It needs no new consent: the
   * extension calls this only for a run allowed to edit with the same commands that are configured now.
   */
  public async continueAfterLimit(runId: string): Promise<void> {
    await this.load();
    const run = this.runs.get(runId);
    if (!run) return;
    await this.host.exclusive(async () => {
      const finished = await this.host.resume(runId, run.allowWrites);
      await this.finishing.get(finished.id);
      return finished;
    });
  }

  private async resume(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    const conversation = this.conversations.find((item) => item.id === run?.conversationId);
    const turn = conversation?.turns.find((item) => item.runId === runId);
    if (!run || !conversation || !turn) return;
    if (this.host.isBusy()) {
      this.show('Another message is still running.');
      return;
    }
    // Continuing by hand replaces an automatic continuation.
    this.host.cancelContinuation(runId);
    // Resuming always asks again, as it does from the Runs view.
    this.allowedEdits.delete(conversation.id);
    const allowWrites = editsFiles(run.kind) && (await this.askConsent(conversation, turn));
    if (editsFiles(run.kind) && !allowWrites) return;
    await this.host.exclusive(async () => {
      const finished = await this.host.resume(runId, allowWrites);
      await this.finishing.get(finished.id);
      return finished;
    });
  }

  // ---- Messages from the webview ----

  /** True once a chat page has loaded its script, which shows the page runs under its security policy. */
  public get hasReadyView(): boolean {
    return this.ready.size > 0;
  }

  /** The state a webview would show, for the smoke test. */
  public snapshot(): ChatState {
    return this.state((file) => file);
  }

  /** Handles a message as if a webview sent it, for the smoke test; it resolves when the work is done. */
  public async receive(raw: unknown): Promise<void> {
    const parsed = parseWebviewMessage(raw);
    if (!parsed) throw new Error('The chat message was not valid.');
    await this.handle(parsed);
  }

  private async handle(incoming: WebviewMessage, webview?: vscode.Webview): Promise<void> {
    await this.load();
    switch (incoming.type) {
      case 'ready':
        if (webview) this.ready.add(webview);
        if (webview && this.usageRequested) {
          this.usageRequested = false;
          setTimeout(() => this.post(webview, { type: 'showUsage' }), 50);
        }
        if (webview) this.post(webview, { type: 'state', state: this.state(this.webviews.get(webview)?.toUri ?? (() => '')) });
        return;
      case 'send':
        await this.submit(incoming.text, incoming.mode);
        return;
      case 'retry':
        await this.retry(incoming.turnId);
        return;
      case 'editMessage': {
        const turn = this.current?.turns.find((item) => item.id === incoming.turnId);
        if (!this.current || !turn) return;
        this.editing = { conversationId: this.current.id, turnId: turn.id };
        this.composer.mode = turn.mode;
        for (const webview of this.webviews.keys()) this.post(webview, { type: 'fillComposer', text: turn.message });
        break;
      }
      case 'cancelEdit':
        this.editing = undefined;
        break;
      case 'unqueue': {
        const index = this.queue.findIndex((item) => item.id === incoming.id);
        if (index >= 0) {
          const [removed] = this.queue.splice(index, 1);
          this.saveQueue();
          for (const attachment of removed?.attachments ?? []) await this.deleteStored(attachment);
        }
        break;
      }
      case 'continueAfterLimit':
        this.host.scheduleContinuation(incoming.runId);
        break;
      case 'cancelContinuation':
        this.host.cancelContinuation(incoming.runId);
        void this.drain();
        break;
      case 'stop':
        this.consent?.settle('deny');
        this.host.cancel();
        return;
      case 'newConversation':
        await this.newConversation();
        return;
      case 'openConversation':
        this.select(this.conversations.find((item) => item.id === incoming.id));
        this.notice = undefined;
        break;
      case 'deleteConversation':
        await this.deleteConversation(incoming.id);
        break;
      case 'pickFiles':
        await this.pickFiles();
        return;
      case 'attachData':
        await this.addAttachments([{ name: incoming.name, data: new Uint8Array(Buffer.from(incoming.data, 'base64')) }]);
        return;
      case 'attachTooLarge':
        this.show(`${incoming.name} is larger than 25 MB, so it was not attached.`);
        return;
      case 'removeAttachment': {
        const list = this.current ? this.pending.get(this.current.id) : undefined;
        const index = list?.findIndex((item) => item.id === incoming.id) ?? -1;
        if (list && index >= 0) {
          const [removed] = list.splice(index, 1);
          if (removed) await this.deleteStored(removed);
        }
        break;
      }
      case 'searchMentions':
        if (webview) await this.searchMentions(webview, incoming.query);
        return;
      case 'addMention':
        await this.addMention(incoming.path);
        return;
      case 'setMode':
        this.composer.mode = incoming.mode;
        this.saveComposer();
        break;
      case 'setWeb':
        this.composer.web = incoming.enabled;
        this.saveComposer();
        break;
      case 'setOptions':
        this.composer.options[incoming.agent] = sanitizeAgentOptions(incoming.agent, { model: incoming.model, effort: incoming.effort });
        this.saveComposer();
        break;
      case 'customModel': {
        const name = await vscode.window.showInputBox({
          title: `${incoming.agent === 'claude' ? 'Claude' : 'Codex'} model`,
          prompt: 'A model name or alias the CLI accepts, such as claude-opus-5-5 or gpt-6-sol.',
          value: this.composer.options[incoming.agent].model ?? '',
          validateInput: (value) => (!value.trim() || isModelName(value.trim()) ? undefined : 'Use letters, digits, and . _ : / @ - only.'),
        });
        if (name === undefined) return;
        this.composer.options[incoming.agent] = sanitizeAgentOptions(incoming.agent, { ...this.composer.options[incoming.agent], model: name.trim() });
        if (!name.trim()) delete this.composer.options[incoming.agent].model;
        this.saveComposer();
        break;
      }
      case 'consent':
        if (this.consent?.view.turnId === incoming.turnId) this.consent.settle(incoming.decision);
        return;
      case 'approve':
        this.host.approve(incoming.notes);
        return;
      case 'reject':
        this.host.reject();
        return;
      case 'reviewPlan':
        await this.host.openPlan(incoming.runId);
        return;
      case 'reviewChanges':
        await vscode.commands.executeCommand('dualAgent.reviewChanges', incoming.runId);
        return;
      case 'openChange':
        await vscode.commands.executeCommand('dualAgent.openChange', incoming.runId, {
          path: incoming.path,
          status: STATUS_LETTERS[incoming.status] ?? 'modified',
          symlink: false,
        });
        return;
      case 'applyChanges':
        await vscode.commands.executeCommand('dualAgent.applyChanges', incoming.runId);
        return;
      case 'discardChanges':
        await vscode.commands.executeCommand('dualAgent.discardChanges', incoming.runId);
        return;
      case 'openStage':
        await this.host.openStage(incoming.runId, incoming.index);
        return;
      case 'openReport':
        await this.host.openReport(incoming.runId);
        return;
      case 'resume':
        await this.resume(incoming.runId);
        return;
      case 'openLink': {
        const target = linkTarget(incoming.href);
        if (!target) {
          this.show('Only web and email links can be opened from the chat.');
          return;
        }
        const choice = await vscode.window.showInformationMessage(`Open ${target.url}?`, { modal: true, detail: 'The link comes from agent output.' }, 'Open');
        if (choice === 'Open') await vscode.env.openExternal(vscode.Uri.parse(target.url, true));
        return;
      }
      case 'openFile':
        await this.openFile(incoming.path);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(incoming.text);
        return;
      case 'dismissNotice':
        this.notice = undefined;
        break;
      case 'pageError':
        if (this.pageErrors.length < PAGE_ERROR_LIMIT) this.pageErrors.push(incoming.message);
        this.host.log(`Chat view error: ${incoming.message}`);
        return;
    }
    this.schedule();
  }

  /**
   * Opens a file an agent referred to, at the line it named. Only files in the conversation's folder or its
   * worktree open; anything else is refused rather than read from wherever the text points.
   */
  private async openFile(reference: string): Promise<void> {
    const conversation = this.current;
    if (!conversation) return;
    const { path: target, line } = fileReference(reference);
    const worktree = (await this.conversationWorktree(conversation))?.workingDirectory;
    const roots = [conversation.workspacePath, ...(worktree ? [worktree] : [])];
    const resolved = roots
      .map((root) => ({ root, file: path.resolve(root, target) }))
      .find(({ root, file }) => !path.relative(root, file).startsWith('..') && !path.isAbsolute(path.relative(root, file)));
    if (!resolved) {
      this.show(`${target} is outside this conversation's folder, so it was not opened.`);
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.file));
      const position = line ? new vscode.Position(Math.min(line, document.lineCount) - 1, 0) : undefined;
      await vscode.window.showTextDocument(document, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
        ...(position ? { selection: new vscode.Range(position, position) } : {}),
      });
    } catch {
      this.show(`${target} could not be opened.`);
    }
  }

  /** Refreshes what the chat shows, for example after settings or the approval state changed. */
  public refresh(): void {
    this.schedule();
  }

  public dispose(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.consent?.settle('deny');
    this.webviews.clear();
  }
}
