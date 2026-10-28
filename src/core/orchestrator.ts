import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { isSmallTalk } from './about.js';
import { sanitizeAgentOptions } from './agentOptions.js';
import { attachmentText } from './attachments.js';
import { buildStagePrompt, describeCheck } from './context.js';
import { AgentExecutionError, canFallback, ConnectionLostError, isQuotaError, LimitReachedError } from './errors.js';
import { captureGitSnapshot } from './gitSnapshot.js';
import { snapshotEnvironment } from './worktree.js';
import { type AgentLimits, formatReset } from './limits.js';
import type {
  AgentAdapter,
  AgentId,
  AgentOptions,
  AgentRunRequest,
  AgentStreamEvent,
  ApprovalDecision,
  AttachmentRef,
  CheckResult,
  GitSnapshot,
  OrchestratorEvent,
  OrchestratorOptions,
  QuotaReading,
  RunRecord,
  RunStore,
  StageRecord,
  StageResult,
  StartOptions,
  TokenUsage,
  WorkflowKind,
  WorkflowStageDefinition,
  WorktreeInfo,
} from './types.js';
import { checksPassed, isFinished } from './types.js';
import { addUsage, totalUsageByAgent } from './usage.js';
import { onlyMinorFindings, parseVerdict, summarizeVerdict } from './verdict.js';
import { arrangeStage, fixRoundStages, getWorkflow, introWorkflow, repairStage, reviseStage } from './workflows.js';

export interface PreparedWorktree {
  info: WorktreeInfo;
  warnings: string[];
}

export interface CheckRequest {
  commands: readonly (readonly string[])[];
  cwd: string;
  signal: AbortSignal;
  untrustedDirectories: readonly string[];
  onLine: (line: string) => void;
}

export interface OrchestratorDependencies {
  captureSnapshot?: (cwd: string, untrustedDirectories: readonly string[], environment?: NodeJS.ProcessEnv) => Promise<GitSnapshot>;
  /** Creates the isolated worktree for an implementation run. Required when isolation is "worktree". */
  prepareWorktree?: (workspacePath: string, runId: string, signal: AbortSignal, direct: boolean) => Promise<PreparedWorktree>;
  /** Confirms a recorded worktree still exists before a run is resumed in it. */
  worktreeExists?: (worktree: WorktreeInfo) => Promise<boolean>;
  /** Runs setup and verification commands. Required when either is configured. */
  runChecks?: (request: CheckRequest) => Promise<CheckResult[]>;
  /** Asks the user to approve the plan. Required when plan approval is enabled. */
  requestApproval?: (run: RunRecord, stage: StageRecord, signal: AbortSignal) => Promise<ApprovalDecision>;
  /** Reads the attachment text to include in an agent's prompt; defaults to reading the stored files. */
  readAttachmentText?: (attachments: readonly AttachmentRef[], agent: AgentId) => Promise<Record<string, string>>;
  /** Usage limits agents reported, shared by every run so a limited agent is skipped until it resets. */
  limits?: AgentLimits;
  /** Receives each report of an account's usage limits, for the quota meter. */
  onQuota?: (reading: QuotaReading) => void;
  /**
   * Whether the machine can reach the providers. Asked after a connection error: offline, the run pauses
   * until the connection is back; online, the error is one provider's outage and the other agent can cover.
   */
  online?: () => Promise<boolean>;
  /**
   * A third model that rules on the findings of a failed check before Claude revises, such as Gemini CLI.
   * Its ruling is evidence for the revision; it never decides on its own.
   */
  referee?: {
    readonly name: string;
    rule(request: { prompt: string; cwd: string; signal: AbortSignal; untrustedDirectories?: readonly string[] }): Promise<{ text: string; usage?: TokenUsage; model?: string }>;
  };
}

/** Ends a run as cancelled because the user decided to stop it. */
class StoppedByUser extends Error {}

interface StagePrompts {
  prompt: string;
  resume?: { sessionId: string; prompt: string };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const now = (): string => new Date().toISOString();

const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' };
/** Characters of the user's project brief kept on a run. */
export const BRIEF_LIMIT = 4_000;

/** Failed and cancelled runs continue from their first unfinished stage, if their worktree is still there. */
export function canResume(run: RunRecord): boolean {
  return (run.status === 'failed' || run.status === 'cancelled') && (!run.worktree || run.worktree.state === 'active');
}

/** The directory agents and checks run in. */
export function workingDirectory(run: RunRecord): string {
  return run.worktree?.state === 'active' ? run.worktree.workingDirectory : run.workspacePath;
}

/** Workflows whose stages edit files, so they need consent, Git, and (by default) a worktree. */
export function editsFiles(kind: WorkflowKind): boolean {
  return kind === 'implementation' || kind === 'edit' || kind === 'tdd' || kind === 'agent';
}

/** Agent mode works on the real environment, so it edits the folder itself, after a snapshot. */
export function editsDirectly(kind: WorkflowKind): boolean {
  return kind === 'agent';
}

/**
 * Why a message cannot build on the changes waiting in its conversation: Agent mode works in the folder
 * itself, and the other editing modes in an isolated copy, so one cannot continue the other's changes.
 */
export function worktreeConflict(kind: WorkflowKind, worktree: WorktreeInfo | undefined): string | undefined {
  if (!worktree || worktree.state !== 'active') return undefined;
  if (editsDirectly(kind) && !worktree.gitDir) {
    return 'changes from an earlier message are waiting in an isolated copy. Apply or discard them first, because Agent mode works in the folder itself.';
  }
  if (!editsDirectly(kind) && worktree.snapshotFor === 'agent') {
    return 'Agent mode changed the folder directly, and those changes are waiting. Keep or undo them first, because this mode edits an isolated copy.';
  }
  return undefined;
}

function untrustedDirectories(run: RunRecord): string[] {
  return run.worktree ? [run.workspacePath, run.worktree.path, run.worktree.repositoryRoot] : [run.workspacePath];
}

/** Images to pass as arguments, and the folders outside the workspace that hold the run's attachments. */
function attachmentAccess(run: RunRecord): { images: string[]; folders: string[] } {
  const images: string[] = [];
  const folders = new Set<string>();
  for (const attachment of run.attachments ?? []) {
    if (attachment.kind === 'image') images.push(attachment.path);
    // Workspace files are read in place; stored copies live in the conversation's attachment folder.
    if (!attachment.workspaceRelative) folders.add(path.dirname(attachment.path));
  }
  return { images, folders: [...folders] };
}

/** A chat greeting or question about the assistant gets one quick reply; everything else its full workflow. */
function workflowFor(kind: WorkflowKind, objective: string, options: StartOptions): WorkflowStageDefinition[] {
  const agents = options.agents ?? 'claude-codex';
  if (kind === 'chat' && !options.attachments?.length && isSmallTalk(objective)) return introWorkflow().map((stage) => arrangeStage(stage, agents));
  return getWorkflow(kind, agents);
}

function stageRecord(definition: WorkflowStageDefinition, allowWrites: boolean): StageRecord {
  return {
    ...definition,
    // Write permission is granted only with this run's consent, whatever the template says.
    permission: allowWrites ? definition.permission : 'read-only',
    assignedAgent: definition.agent,
    status: 'pending',
  };
}

function resetStage(stage: StageRecord): void {
  stage.status = 'pending';
  stage.assignedAgent = stage.agent;
  for (const key of ['startedAt', 'completedAt', 'result', 'error', 'fallbackReason', 'verdict', 'checks', 'activities'] as const) delete stage[key];
}

/** Steps kept per stage; the earliest are dropped first so the run history stays small. */
export const STAGE_ACTIVITY_LIMIT = 60;

/** Keeps the agent's steps on the stage, and attaches a later result to the step it belongs to. */
function recordActivity(stage: StageRecord, event: AgentStreamEvent): void {
  if (event.activity) {
    stage.activities ??= [];
    stage.activities.push({ ...event.activity });
    if (stage.activities.length > STAGE_ACTIVITY_LIMIT) stage.activities.splice(0, stage.activities.length - STAGE_ACTIVITY_LIMIT);
  }
  const result = event.activityResult;
  const step = result ? stage.activities?.find((activity) => activity.id === result.id) : undefined;
  if (result && step) {
    if (result.output) step.output = result.output;
    if (result.failed) step.failed = true;
  }
}

export class WorkflowOrchestrator {
  private active: { controller: AbortController; run: RunRecord } | undefined;
  private readonly listeners = new Set<(event: OrchestratorEvent) => void>();
  private readonly captureSnapshot: (cwd: string, untrustedDirectories: readonly string[], environment?: NodeJS.ProcessEnv) => Promise<GitSnapshot>;

  public constructor(
    private readonly adapters: Record<AgentId, AgentAdapter>,
    private readonly store: RunStore,
    private readonly options: OrchestratorOptions,
    private readonly dependencies: OrchestratorDependencies = {},
  ) {
    this.captureSnapshot = dependencies.captureSnapshot ?? captureGitSnapshot;
  }

  public onEvent(listener: (event: OrchestratorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public get activeRun(): RunRecord | undefined {
    return this.active?.run;
  }

  /** Stops the active run; `reason` is recorded on it, so the history says who or what stopped it. */
  public cancel(reason = 'Stopped by you.'): boolean {
    if (!this.active) return false;
    this.active.controller.abort(new StoppedByUser(reason));
    return true;
  }

  public async start(
    kind: WorkflowKind,
    objective: string,
    workspacePath: string,
    allowWrites: boolean,
    options: StartOptions = {},
  ): Promise<RunRecord> {
    if (this.active) throw new Error('A workflow is already running. Cancel it before starting another.');
    if (!objective.trim()) throw new Error('An objective is required.');
    if (editsFiles(kind) && !allowWrites) {
      throw new Error('Workflows that edit files require explicit workspace-write consent.');
    }

    const created = now();
    const isolation = editsFiles(kind) ? (this.options.isolation ?? 'none') : 'none';
    const run: RunRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      kind,
      objective: objective.trim(),
      workspacePath,
      status: 'running',
      allowWrites,
      createdAt: created,
      updatedAt: created,
      stages: workflowFor(kind, objective, options).map((stage) => stageRecord(stage, allowWrites)),
      usage: totalUsageByAgent(),
      warnings: [],
      isolation,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      ...(options.agentOptions ? { agentOptions: options.agentOptions } : {}),
      ...(options.history ? { history: options.history } : {}),
      ...(options.continueSessions ? { continueSessions: options.continueSessions } : {}),
      ...(options.web ? { web: true } : {}),
      ...(options.catchUp && Object.keys(options.catchUp).length ? { catchUp: options.catchUp } : {}),
      ...(options.agents && options.agents !== 'claude-codex' ? { agents: options.agents } : {}),
      ...(options.brief?.trim() ? { brief: options.brief.trim().slice(0, BRIEF_LIMIT) } : {}),
      ...(options.editorContext ? { editorContext: options.editorContext } : {}),
    };
    // A conversation keeps editing the same worktree until its changes are applied or discarded.
    const reused = options.worktree;
    if (isolation === 'worktree' && reused?.state === 'active' && (await (this.dependencies.worktreeExists?.(reused) ?? Promise.resolve(true)))) {
      run.worktree = { ...reused };
    }
    return this.execute(run);
  }

  /**
   * Continues a failed or cancelled run from its first unfinished stage. Completed stages, their outputs,
   * and an earlier plan approval are kept. Consent to edit files is asked for again by the caller.
   */
  public async resume(runId: string, allowWrites: boolean): Promise<RunRecord> {
    if (this.active) throw new Error('A workflow is already running. Cancel it before resuming another.');
    const run = (await this.store.list()).find((item) => item.id === runId);
    if (!run) throw new Error('That run is no longer in the history.');
    if (!canResume(run)) {
      throw new Error(
        run.worktree && run.worktree.state !== 'active'
          ? `The changes from this run were already ${run.worktree.state}, so it cannot be resumed.`
          : `Only failed or cancelled runs can be resumed; this run is ${run.status}.`,
      );
    }
    if (editsFiles(run.kind) && !allowWrites) {
      throw new Error('Workflows that edit files require explicit workspace-write consent.');
    }
    if (run.worktree && !(await (this.dependencies.worktreeExists?.(run.worktree) ?? Promise.resolve(true)))) {
      throw new Error('The isolated worktree for this run no longer exists, so it cannot be resumed.');
    }

    for (const stage of run.stages) if (stage.status !== 'completed') resetStage(stage);
    run.status = 'running';
    delete run.error;
    delete run.completedAt;
    delete run.limitReset;
    delete run.offlineSince;
    run.resumeCount = (run.resumeCount ?? 0) + 1;
    return this.execute(run);
  }

  /** Marks runs left active by a VS Code shutdown as cancelled so they can be resumed. */
  public async recoverInterrupted(): Promise<RunRecord[]> {
    const recovered: RunRecord[] = [];
    for (const run of await this.store.list()) {
      if (isFinished(run.status) || run.id === this.active?.run.id) continue;
      run.status = 'cancelled';
      run.error = 'VS Code closed while this run was active. Resume it to continue from the last completed stage.';
      run.completedAt = now();
      for (const stage of run.stages) {
        if (stage.status === 'running') stage.status = 'cancelled';
        else if (stage.status === 'pending') stage.status = 'skipped';
      }
      await this.store.save(run);
      recovered.push(run);
    }
    return recovered;
  }

  /** Changes a finished run's record, for example after its worktree changes are applied. */
  public async updateRun(runId: string, mutate: (run: RunRecord) => void): Promise<RunRecord> {
    if (this.active?.run.id === runId) throw new Error('Wait for the run to finish first.');
    const run = (await this.store.list()).find((item) => item.id === runId);
    if (!run) throw new Error('That run is no longer in the history.');
    mutate(run);
    await this.update(run);
    return run;
  }

  private async execute(run: RunRecord): Promise<RunRecord> {
    const controller = new AbortController();
    const { signal } = controller;
    this.active = { controller, run };

    try {
      await this.update(run);
      if (editsFiles(run.kind) && (run.isolation === 'worktree' || editsDirectly(run.kind))) await this.ensureWorktree(run, signal);
      for (const adapter of Object.values(this.adapters)) {
        for (const warning of (await adapter.preflightWarnings?.(workingDirectory(run))) ?? []) this.warn(run, warning);
      }
      let snapshot: GitSnapshot | undefined;
      if (editsFiles(run.kind)) {
        snapshot = await this.snapshot(run);
        if (!snapshot.available) {
          throw new Error(
            `Editing files needs a working Git repository so reviewers see every change and it can be reverted. ${snapshot.warnings.join(' ')}`,
          );
        }
      }
      // Fix rounds add stages while the loop runs, so the length is read on every iteration.
      for (let index = 0; index < run.stages.length; index += 1) {
        const stage = run.stages[index];
        if (!stage || stage.status === 'completed') continue;
        if (signal.aborted) throw new Error('Workflow cancelled.');
        if (stage.requiresApproval && run.allowWrites && this.options.approvePlan && !run.approval) {
          await this.approve(run, stage, signal);
          // The workspace may have changed while the user was deciding.
          snapshot = undefined;
        }
        await this.executeStage(run, stage, signal, snapshot);
        snapshot = undefined;
        if (stage.permission !== 'read-only') {
          await this.verify(run, stage, signal);
          this.repair(run, index, stage);
        }
        if (stage.gate) this.gate(run, index, stage);
        if (stage.onFail === 'revise') {
          this.revise(run, index, stage);
          await this.consultReferee(run, index, stage, signal);
        }
      }
      run.status = run.unresolved ? 'completed-with-findings' : 'completed';
      run.completedAt = now();
      this.log(run, run.unresolved ? `Run completed with unresolved findings: ${run.unresolved}.` : 'Run completed.');
    } catch (error) {
      const cancelled = signal.aborted || error instanceof StoppedByUser;
      run.status = cancelled ? 'cancelled' : 'failed';
      run.error = signal.aborted && signal.reason instanceof StoppedByUser ? signal.reason.message : messageOf(error);
      run.completedAt = now();
      if (error instanceof LimitReachedError) run.limitReset = error.resetAt;
      if (error instanceof ConnectionLostError) run.offlineSince = run.completedAt;
      const running = run.stages.find((stage) => stage.status === 'running');
      if (running) {
        running.status = cancelled ? 'cancelled' : 'failed';
        running.error = run.error;
        running.completedAt = run.completedAt;
      }
      for (const stage of run.stages.filter((item) => item.status === 'pending')) stage.status = 'skipped';
      this.log(run, `Run ${run.status}: ${run.error}`);
    } finally {
      try {
        await this.update(run);
      } catch (error) {
        // A storage failure must never leave the orchestrator believing a run is still active.
        this.warn(run, `Run history could not be saved: ${messageOf(error)}`);
        this.emit({ type: 'run-updated', run });
      } finally {
        this.active = undefined;
      }
    }
    return run;
  }

  private async ensureWorktree(run: RunRecord, signal: AbortSignal): Promise<void> {
    if (!run.worktree) {
      if (!this.dependencies.prepareWorktree) throw new Error('Worktree isolation is enabled, but worktrees are unavailable.');
      this.log(run, 'Creating an isolated Git worktree for this run.');
      const prepared = await this.dependencies.prepareWorktree(run.workspacePath, run.id, signal, editsDirectly(run.kind));
      run.worktree = prepared.info;
      for (const warning of prepared.warnings) this.warn(run, warning);
      await this.update(run);
    }
    const commands = this.options.setupCommands ?? [];
    if (run.worktree.setupCompleted || !commands.length) return;
    this.log(run, 'Running setup commands in the worktree.');
    run.setupChecks = await this.check(run, commands, signal);
    if (signal.aborted) throw new Error('Workflow cancelled.');
    const failed = run.setupChecks.find((check) => !checksPassed([check]));
    if (failed) throw new Error(`Worktree setup failed: \`${failed.command.join(' ')}\` ${describeCheck(failed)}.`);
    run.worktree.setupCompleted = true;
    await this.update(run);
  }

  private async approve(run: RunRecord, stage: StageRecord, signal: AbortSignal): Promise<void> {
    if (!this.dependencies.requestApproval) throw new Error('Plan approval is enabled, but no approval handler is available.');
    run.status = 'awaiting-approval';
    await this.update(run);
    this.log(run, `Waiting for approval before "${stage.title}".`);
    const decision = await this.dependencies.requestApproval(run, stage, signal);
    if (signal.aborted) throw new Error('Workflow cancelled.');
    if (!decision.approved) throw new StoppedByUser('The plan was rejected, so no files were changed.');
    const notes = decision.notes?.trim();
    run.approval = { decidedAt: now(), ...(notes ? { notes } : {}) };
    run.status = 'running';
    await this.update(run);
    this.log(run, 'Plan approved.');
  }

  private async executeStage(
    run: RunRecord,
    stage: StageRecord,
    signal: AbortSignal,
    initialSnapshot?: GitSnapshot,
  ): Promise<void> {
    stage.status = 'running';
    stage.startedAt = now();
    await this.update(run);
    this.log(run, `Stage started: ${stage.title} (${stage.assignedAgent}, ${stage.permission}).`);

    const snapshot = initialSnapshot ?? (await this.snapshot(run));
    if (signal.aborted) throw new Error('Workflow cancelled.');

    const inline = (agent: AgentId): Promise<Record<string, string>> =>
      run.attachments?.length ? (this.dependencies.readAttachmentText ?? attachmentText)(run.attachments, agent) : Promise.resolve({});
    const limits = this.dependencies.limits;
    const other: AgentId = stage.agent === 'claude' ? 'codex' : 'claude';
    // An agent known to be at its usage limit is not tried again until the limit resets: the other agent
    // works alone meanwhile, or the run stops until the first limit resets.
    const known = limits?.active(stage.agent);
    // The user chose one agent alone, so the other never stands in; at its limit the run pauses instead.
    const fallback = this.options.fallbackOnQuota && run.agents !== 'claude' && run.agents !== 'codex';
    if (known) {
      if (!fallback || limits?.active(other)) throw this.limitReached(stage);
      stage.assignedAgent = other;
      stage.fallbackReason = `${AGENT_NAMES[stage.agent]} is at its usage limit until ${formatReset(known.until)}${known.estimated ? ' (estimated)' : ''}.`;
      await this.update(run);
      this.log(run, `${AGENT_NAMES[other]} works alone: ${stage.fallbackReason}`);
    }
    try {
      const agent = stage.assignedAgent;
      const prompts = this.prompts(run, stage, agent, snapshot, agent !== stage.agent, await inline(agent));
      stage.result = await this.attempt(run, stage, agent, prompts, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      await this.throwIfOffline(error);
      this.noteLimit(stage.assignedAgent, error);
      const switchable = stage.assignedAgent === stage.agent && fallback && canFallback(error) && !limits?.active(other);
      if (!switchable) throw limits && isQuotaError(error) ? this.limitReached(stage) : error;
      stage.assignedAgent = other;
      stage.fallbackReason = messageOf(error);
      await this.update(run);
      this.log(run, `Falling back to ${other}: ${stage.fallbackReason}`);
      // The failed attempt may have changed files before it stopped, so the fallback needs a fresh view.
      const fresh = await this.snapshot(run);
      if (signal.aborted) throw new Error('Workflow cancelled.', { cause: error });
      try {
        stage.result = await this.attempt(run, stage, other, this.prompts(run, stage, other, fresh, true, await inline(other)), signal);
      } catch (second) {
        if (signal.aborted) throw second;
        await this.throwIfOffline(second);
        this.noteLimit(other, second);
        throw limits && isQuotaError(second) ? this.limitReached(stage) : second;
      }
    }
    // A completed call shows the agent's earlier limit has reset, unless the call itself just reported the
    // limit reached or nearly so, in which case the new limit stands.
    if (!limits?.active(stage.assignedAgent)) limits?.clear(stage.assignedAgent);

    if (stage.review) stage.verdict = parseVerdict(stage.result.text);
    stage.status = 'completed';
    stage.completedAt = now();
    run.usage[stage.assignedAgent] = addUsage(run.usage[stage.assignedAgent], stage.result.usage);
    await this.update(run);
    this.log(run, `Stage completed: ${stage.title}${stage.verdict ? ` (verdict: ${summarizeVerdict(stage.verdict)})` : ''}.`);
  }

  /**
   * Passes on what a provider reported about its account's limits. A limit already reached, or a window all
   * but used up, is recorded with its exact reset time, so the next stage goes to the other agent without
   * failing first.
   */
  private noteQuota(reading: QuotaReading): void {
    this.dependencies.onQuota?.(reading);
    this.dependencies.limits?.observe(reading);
  }

  /** A connection error while the machine is offline pauses the run, since no agent could take the stage. */
  private async throwIfOffline(error: unknown): Promise<void> {
    if (!(error instanceof AgentExecutionError) || error.kind !== 'network' || !this.dependencies.online) return;
    if (await this.dependencies.online().catch(() => true)) return;
    throw new ConnectionLostError(`The network connection was lost (${error.message.split('\n')[0] ?? ''}). The message continues where it stopped when the connection is back.`);
  }

  /**
   * Asks the referee to rule on each finding of a check that failed, before the revision that follows it.
   * A referee that cannot rule is noted, and the revision goes ahead without it.
   */
  private async consultReferee(run: RunRecord, index: number, check: StageRecord, signal: AbortSignal): Promise<void> {
    const referee = this.dependencies.referee;
    if (!referee || !check.result || run.stages[index + 1]?.id !== 'claude-revise') return;
    const ruling: StageRecord = {
      id: 'referee',
      context: 'lean',
      title: `${referee.name} rules on the findings`,
      agent: check.agent,
      assignedAgent: check.agent,
      permission: 'read-only',
      purpose: 'Independent ruling on disputed findings',
      instructions:
        'You are an independent referee between two agents. The first answered the user\'s latest message; the second checked that answer and reported findings, both shown above. For each finding, rule upheld, partly upheld, or rejected, with one or two sentences of evidence from the files or sources, which you may read. Then say in one line which parts of the answer stand. Do not modify files.',
      status: 'running',
    };
    try {
      const snapshot = await this.snapshot(run);
      const prompt = buildStagePrompt(run, ruling, snapshot, this.options.maxContextCharacters, { redact: this.options.redactSecrets !== false });
      const result = await referee.rule({ prompt, cwd: workingDirectory(run), signal, untrustedDirectories: untrustedDirectories(run) });
      check.referee = { referee: referee.name, text: result.text, ...(result.usage ? { usage: result.usage } : {}), ...(result.model ? { model: result.model } : {}) };
      this.log(run, `${referee.name} ruled on the findings of "${check.title}".`);
    } catch (error) {
      if (signal.aborted) throw error;
      check.referee = { referee: referee.name, text: '', error: messageOf(error) };
      this.warn(run, `${referee.name} could not rule on the check: ${messageOf(error)}`);
    }
    await this.update(run);
  }

  /** Records a usage limit the agent reported, so later stages skip it until the limit resets. */
  private noteLimit(agent: AgentId, error: unknown): void {
    if (isQuotaError(error) && !(error instanceof LimitReachedError)) this.dependencies.limits?.record(agent, error.message);
  }

  /** The error that stops a run until the first agent that could continue it is past its limit. */
  private limitReached(stage: StageRecord): LimitReachedError {
    const limits = this.dependencies.limits;
    const candidates: AgentId[] = this.options.fallbackOnQuota ? ['claude', 'codex'] : [stage.agent];
    const resets = candidates.map((agent) => limits?.active(agent)?.until).filter((until): until is string => until !== undefined);
    const resetAt = resets.sort()[0] ?? new Date(Date.now() + 15 * 60_000).toISOString();
    const who =
      candidates.length > 1 ? 'Claude and Codex are both at their usage limits' : `${AGENT_NAMES[stage.agent]} is at its usage limit and fallback is turned off`;
    return new LimitReachedError(`${who}. The work can continue after ${formatReset(resetAt)}.`, resetAt);
  }

  /**
   * Builds the prompt for a new session and, when this agent's sessions are resumed, a shorter prompt for
   * its previous session in this run. A fallback provider always starts fresh.
   */
  private prompts(
    run: RunRecord,
    stage: StageRecord,
    agent: AgentId,
    snapshot: GitSnapshot,
    fallback: boolean,
    inlineText: Record<string, string>,
  ): StagePrompts {
    const max = this.options.maxContextCharacters;
    const redact = this.options.redactSecrets !== false;
    const prompt = buildStagePrompt(run, stage, snapshot, max, { attachmentText: inlineText, redact, ...(fallback ? { fallback: true } : {}) });
    if (fallback || !this.options.resumeSessions?.includes(agent)) return { prompt };
    const index = run.stages.indexOf(stage);
    const previous = run.stages
      .slice(0, index === -1 ? undefined : index)
      .reverse()
      .find((item) => item.status === 'completed' && item.assignedAgent === agent && item.result?.providerSessionId);
    // The first stage of a conversation turn continues the session from the previous turn.
    const sessionId = previous?.result?.providerSessionId ?? run.continueSessions?.[agent];
    if (!sessionId) return { prompt };
    // A session continued from an earlier turn catches up on the turns the other agent answered alone.
    const missed = previous ? undefined : run.catchUp?.[agent];
    return {
      prompt,
      resume: {
        sessionId,
        prompt: buildStagePrompt(run, stage, snapshot, max, { resumedSessionId: sessionId, attachmentText: inlineText, redact, ...(missed ? { missedHistory: missed } : {}) }),
      },
    };
  }

  private async attempt(
    run: RunRecord,
    stage: StageRecord,
    agent: AgentId,
    prompts: StagePrompts,
    signal: AbortSignal,
  ): Promise<StageResult> {
    const { images, folders } = attachmentAccess(run);
    const options = this.agentOptions(run, agent);
    const request: AgentRunRequest = {
      prompt: prompts.prompt,
      cwd: workingDirectory(run),
      untrustedDirectories: untrustedDirectories(run),
      permission: stage.permission,
      signal,
      onEvent: (agentEvent) => {
        recordActivity(stage, agentEvent);
        if (agentEvent.quota) this.noteQuota(agentEvent.quota);
        this.emit({ type: 'agent-event', run, agentEvent, stageId: stage.id });
      },
      ...(prompts.resume ? { resume: prompts.resume } : {}),
      ...(Object.keys(options).length ? { options } : {}),
      ...(images.length ? { images } : {}),
      ...(folders.length ? { readableDirectories: folders } : {}),
      ...(stage.web || run.web ? { web: true } : {}),
      // An editing stage may run the commands the user consented to, so it can test its own change.
      ...(stage.permission === 'workspace-write' && this.options.verificationCommands?.length ? { allowedCommands: this.options.verificationCommands } : {}),
    };
    try {
      const result = await this.adapters[agent].run(request);
      if (result.quota) this.noteQuota(result.quota);
      return result;
    } catch (error) {
      // Quota spent by a failed attempt is still spent.
      if (error instanceof AgentExecutionError && error.usage) run.usage[agent] = addUsage(run.usage[agent], error.usage);
      throw error;
    }
  }

  /** The run's chosen model and effort for the agent actually running, revalidated because runs are stored. */
  private agentOptions(run: RunRecord, agent: AgentId): AgentOptions {
    const options = sanitizeAgentOptions(agent, run.agentOptions?.[agent]);
    // Research depends on careful reasoning, so it thinks hard unless the user chose an effort.
    if (run.kind === 'research' && !options.effort) options.effort = 'high';
    return options;
  }

  /**
   * When the checks fail right after an editing stage, adds one Claude repair before the next stage, so the
   * reviewer sees working code. It is added at most once per run; later failures go to the gate.
   */
  private repair(run: RunRecord, index: number, stage: StageRecord): void {
    if (!stage.checks?.length || checksPassed(stage.checks) || !run.allowWrites || stage.expectFailingChecks) return;
    if (stage.id === 'claude-repair' || stage.round !== undefined || run.stages.some((item) => item.id === 'claude-repair')) return;
    run.stages.splice(index + 1, 0, stageRecord(arrangeStage(repairStage(stage.title), run.agents), run.allowWrites));
    this.log(run, `Checks failed after "${stage.title}"; Claude repairs them before the review.`);
  }

  /** Runs the configured verification commands after a stage that could edit files. */
  private async verify(run: RunRecord, stage: StageRecord, signal: AbortSignal): Promise<void> {
    const commands = this.options.verificationCommands ?? [];
    if (!commands.length) return;
    this.log(run, `Running verification after "${stage.title}".`);
    stage.checks = await this.check(run, commands, signal);
    if (signal.aborted) throw new Error('Workflow cancelled.');
    for (const check of stage.checks) this.log(run, `Check \`${check.command.join(' ')}\` ${describeCheck(check)}.`);
    await this.update(run);
  }

  private async check(run: RunRecord, commands: readonly (readonly string[])[], signal: AbortSignal): Promise<CheckResult[]> {
    if (!this.dependencies.runChecks) throw new Error('Commands are configured, but no command runner is available.');
    return this.dependencies.runChecks({
      commands,
      cwd: workingDirectory(run),
      signal,
      untrustedDirectories: untrustedDirectories(run),
      onLine: (line) => this.log(run, `  ${line}`),
    });
  }

  /**
   * Applies the final gate: it passes only with a "pass" verdict and passing verification. Otherwise a
   * fix round is added while rounds remain, and the run is marked as having unresolved findings until a
   * later gate passes.
   */
  private gate(run: RunRecord, index: number, stage: StageRecord): void {
    const reasons: string[] = [];
    if (!stage.verdict || stage.verdict.outcome === 'missing') reasons.push('the reviewer gave no machine-readable verdict');
    else if (stage.verdict.outcome === 'fail') reasons.push(`the reviewer reported ${summarizeVerdict(stage.verdict)}`);
    const checked = run.stages
      .slice(0, index)
      .reverse()
      .find((item) => item.status === 'completed' && item.checks?.length);
    const failing = checked?.checks?.find((check) => !checksPassed([check]));
    if (failing) reasons.push(`\`${failing.command.join(' ')}\` ${describeCheck(failing)}`);

    if (!reasons.length) {
      delete run.unresolved;
      return;
    }
    const reason = reasons.join('; ');
    run.unresolved = reason;
    const rounds = run.stages.filter((item) => item.round !== undefined && item.permission !== 'read-only').length;
    if (!run.allowWrites || rounds >= (this.options.maxFixRounds ?? 0)) return;
    run.stages.splice(index + 1, 0, ...fixRoundStages(rounds + 1, reason).map((item) => stageRecord(arrangeStage(item, run.agents), run.allowWrites)));
    this.log(run, `The final gate did not pass (${reason}); starting fix round ${rounds + 1}.`);
  }

  /**
   * After a chat check that did not pass, adds one read-only Claude stage that weighs the findings and gives
   * the final answer. It is not checked again, so a message costs at most three agent calls.
   */
  private revise(run: RunRecord, index: number, stage: StageRecord): void {
    if (stage.verdict?.outcome === 'pass') return;
    // Low-severity notes are shown with the check; rewriting the whole answer for them costs a full call.
    if (stage.verdict && onlyMinorFindings(stage.verdict)) {
      this.log(run, `Codex's check found only minor notes (${summarizeVerdict(stage.verdict)}); the answer stands.`);
      return;
    }
    if (run.stages.slice(index + 1).some((item) => item.id === 'claude-revise')) return;
    const reason =
      !stage.verdict || stage.verdict.outcome === 'missing'
        ? 'the check gave no machine-readable verdict'
        : `the check reported ${summarizeVerdict(stage.verdict)}`;
    run.stages.splice(index + 1, 0, stageRecord(arrangeStage(reviseStage(reason, run.kind), run.agents), run.allowWrites));
    this.log(run, `Codex's check did not pass (${reason}); Claude revises the answer.`);
  }

  private async snapshot(run: RunRecord): Promise<GitSnapshot> {
    let snapshot: GitSnapshot;
    try {
      // A folder edited directly reports its changes since the snapshot taken before the run.
      const environment = run.worktree?.state === 'active' ? snapshotEnvironment(run.worktree) : {};
      snapshot = await this.captureSnapshot(workingDirectory(run), untrustedDirectories(run), environment);
    } catch (error) {
      snapshot = { available: false, status: '', diff: '', diffStat: '', untracked: [], warnings: [`Git snapshot failed: ${messageOf(error)}`] };
    }
    for (const warning of snapshot.warnings) this.warn(run, warning);
    return snapshot;
  }

  private warn(run: RunRecord, warning: string): void {
    run.warnings ??= [];
    if (!run.warnings.includes(warning)) run.warnings.push(warning);
  }

  private log(run: RunRecord, message: string): void {
    this.emit({ type: 'log', run, message });
  }

  private async update(run: RunRecord): Promise<void> {
    run.updatedAt = now();
    // Listeners see every transition even when persistence fails.
    this.emit({ type: 'run-updated', run });
    await this.store.save(run);
  }

  private emit(event: OrchestratorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failing listener (for example a disposed view) must not break the workflow.
      }
    }
  }
}
