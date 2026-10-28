import { randomUUID } from 'node:crypto';

import { buildStagePrompt, describeCheck } from './context.js';
import { AgentExecutionError, canFallback } from './errors.js';
import { captureGitSnapshot } from './gitSnapshot.js';
import type {
  AgentAdapter,
  AgentId,
  AgentRunRequest,
  ApprovalDecision,
  CheckResult,
  GitSnapshot,
  OrchestratorEvent,
  OrchestratorOptions,
  RunRecord,
  RunStore,
  StageRecord,
  StageResult,
  WorkflowKind,
  WorkflowStageDefinition,
  WorktreeInfo,
} from './types.js';
import { checksPassed, isFinished } from './types.js';
import { addUsage, totalUsageByAgent } from './usage.js';
import { parseVerdict, summarizeVerdict } from './verdict.js';
import { fixRoundStages, getWorkflow } from './workflows.js';

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
  captureSnapshot?: (cwd: string, untrustedDirectories: readonly string[]) => Promise<GitSnapshot>;
  /** Creates the isolated worktree for an implementation run. Required when isolation is "worktree". */
  prepareWorktree?: (workspacePath: string, runId: string, signal: AbortSignal) => Promise<PreparedWorktree>;
  /** Confirms a recorded worktree still exists before a run is resumed in it. */
  worktreeExists?: (worktree: WorktreeInfo) => Promise<boolean>;
  /** Runs setup and verification commands. Required when either is configured. */
  runChecks?: (request: CheckRequest) => Promise<CheckResult[]>;
  /** Asks the user to approve the plan. Required when plan approval is enabled. */
  requestApproval?: (run: RunRecord, stage: StageRecord, signal: AbortSignal) => Promise<ApprovalDecision>;
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

/** Failed and cancelled runs continue from their first unfinished stage, if their worktree is still there. */
export function canResume(run: RunRecord): boolean {
  return (run.status === 'failed' || run.status === 'cancelled') && (!run.worktree || run.worktree.state === 'active');
}

/** The directory agents and checks run in. */
export function workingDirectory(run: RunRecord): string {
  return run.worktree?.state === 'active' ? run.worktree.workingDirectory : run.workspacePath;
}

function untrustedDirectories(run: RunRecord): string[] {
  return run.worktree ? [run.workspacePath, run.worktree.path, run.worktree.repositoryRoot] : [run.workspacePath];
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
  for (const key of ['startedAt', 'completedAt', 'result', 'error', 'fallbackReason', 'verdict', 'checks'] as const) delete stage[key];
}

export class WorkflowOrchestrator {
  private active: { controller: AbortController; run: RunRecord } | undefined;
  private readonly listeners = new Set<(event: OrchestratorEvent) => void>();
  private readonly captureSnapshot: (cwd: string, untrustedDirectories: readonly string[]) => Promise<GitSnapshot>;

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

  public cancel(): boolean {
    if (!this.active) return false;
    this.active.controller.abort();
    return true;
  }

  public async start(
    kind: WorkflowKind,
    objective: string,
    workspacePath: string,
    allowWrites: boolean,
  ): Promise<RunRecord> {
    if (this.active) throw new Error('A workflow is already running. Cancel it before starting another.');
    if (!objective.trim()) throw new Error('An objective is required.');
    if (kind === 'implementation' && !allowWrites) {
      throw new Error('Implementation workflows require explicit workspace-write consent.');
    }

    const created = now();
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
      stages: getWorkflow(kind).map((stage) => stageRecord(stage, allowWrites)),
      usage: totalUsageByAgent(),
      warnings: [],
      isolation: kind === 'implementation' ? (this.options.isolation ?? 'none') : 'none',
    };
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
    if (run.kind === 'implementation' && !allowWrites) {
      throw new Error('Implementation workflows require explicit workspace-write consent.');
    }
    if (run.worktree && !(await (this.dependencies.worktreeExists?.(run.worktree) ?? Promise.resolve(true)))) {
      throw new Error('The isolated worktree for this run no longer exists, so it cannot be resumed.');
    }

    for (const stage of run.stages) if (stage.status !== 'completed') resetStage(stage);
    run.status = 'running';
    delete run.error;
    delete run.completedAt;
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
      if (run.kind === 'implementation' && run.isolation === 'worktree') await this.ensureWorktree(run, signal);
      for (const adapter of Object.values(this.adapters)) {
        for (const warning of (await adapter.preflightWarnings?.(workingDirectory(run))) ?? []) this.warn(run, warning);
      }
      let snapshot: GitSnapshot | undefined;
      if (run.kind === 'implementation') {
        snapshot = await this.snapshot(run);
        if (!snapshot.available) {
          throw new Error(
            `Implementation workflows need a working Git repository so reviewers see every change and it can be reverted. ${snapshot.warnings.join(' ')}`,
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
        if (stage.permission === 'workspace-write') await this.verify(run, stage, signal);
        if (stage.gate) this.gate(run, index, stage);
      }
      run.status = run.unresolved ? 'completed-with-findings' : 'completed';
      run.completedAt = now();
      this.log(run, run.unresolved ? `Run completed with unresolved findings: ${run.unresolved}.` : 'Run completed.');
    } catch (error) {
      const cancelled = signal.aborted || error instanceof StoppedByUser;
      run.status = cancelled ? 'cancelled' : 'failed';
      run.error = messageOf(error);
      run.completedAt = now();
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
      const prepared = await this.dependencies.prepareWorktree(run.workspacePath, run.id, signal);
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

    try {
      stage.result = await this.attempt(run, stage, stage.agent, this.prompts(run, stage, stage.agent, snapshot, false), signal);
    } catch (error) {
      if (!this.options.fallbackOnQuota || !canFallback(error) || signal.aborted) throw error;
      const fallback: AgentId = stage.agent === 'claude' ? 'codex' : 'claude';
      stage.assignedAgent = fallback;
      stage.fallbackReason = messageOf(error);
      await this.update(run);
      this.log(run, `Falling back to ${fallback}: ${stage.fallbackReason}`);
      // The failed attempt may have changed files before it stopped, so the fallback needs a fresh view.
      const fresh = await this.snapshot(run);
      if (signal.aborted) throw new Error('Workflow cancelled.');
      stage.result = await this.attempt(run, stage, fallback, this.prompts(run, stage, fallback, fresh, true), signal);
    }

    if (stage.review) stage.verdict = parseVerdict(stage.result.text);
    stage.status = 'completed';
    stage.completedAt = now();
    run.usage[stage.assignedAgent] = addUsage(run.usage[stage.assignedAgent], stage.result.usage);
    await this.update(run);
    this.log(run, `Stage completed: ${stage.title}${stage.verdict ? ` (verdict: ${summarizeVerdict(stage.verdict)})` : ''}.`);
  }

  /**
   * Builds the prompt for a new session and, when this agent's sessions are resumed, a shorter prompt for
   * its previous session in this run. A fallback provider always starts fresh.
   */
  private prompts(run: RunRecord, stage: StageRecord, agent: AgentId, snapshot: GitSnapshot, fallback: boolean): StagePrompts {
    const max = this.options.maxContextCharacters;
    const prompt = buildStagePrompt(run, stage, snapshot, max, fallback ? { fallback: true } : {});
    if (fallback || !this.options.resumeSessions?.includes(agent)) return { prompt };
    const index = run.stages.indexOf(stage);
    const previous = run.stages
      .slice(0, index === -1 ? undefined : index)
      .reverse()
      .find((item) => item.status === 'completed' && item.assignedAgent === agent && item.result?.providerSessionId);
    const sessionId = previous?.result?.providerSessionId;
    if (!sessionId) return { prompt };
    return { prompt, resume: { sessionId, prompt: buildStagePrompt(run, stage, snapshot, max, { resumedSessionId: sessionId }) } };
  }

  private async attempt(
    run: RunRecord,
    stage: StageRecord,
    agent: AgentId,
    prompts: StagePrompts,
    signal: AbortSignal,
  ): Promise<StageResult> {
    const request: AgentRunRequest = {
      prompt: prompts.prompt,
      cwd: workingDirectory(run),
      untrustedDirectories: untrustedDirectories(run),
      permission: stage.permission,
      signal,
      onEvent: (agentEvent) => this.emit({ type: 'agent-event', run, agentEvent }),
      ...(prompts.resume ? { resume: prompts.resume } : {}),
    };
    try {
      return await this.adapters[agent].run(request);
    } catch (error) {
      // Quota spent by a failed attempt is still spent.
      if (error instanceof AgentExecutionError && error.usage) run.usage[agent] = addUsage(run.usage[agent], error.usage);
      throw error;
    }
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
    const rounds = run.stages.filter((item) => item.round !== undefined && item.permission === 'workspace-write').length;
    if (!run.allowWrites || rounds >= (this.options.maxFixRounds ?? 0)) return;
    run.stages.splice(index + 1, 0, ...fixRoundStages(rounds + 1, reason).map((item) => stageRecord(item, run.allowWrites)));
    this.log(run, `The final gate did not pass (${reason}); starting fix round ${rounds + 1}.`);
  }

  private async snapshot(run: RunRecord): Promise<GitSnapshot> {
    let snapshot: GitSnapshot;
    try {
      snapshot = await this.captureSnapshot(workingDirectory(run), untrustedDirectories(run));
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
