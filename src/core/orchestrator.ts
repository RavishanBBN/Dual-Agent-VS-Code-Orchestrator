import { randomUUID } from 'node:crypto';

import { buildStagePrompt } from './context.js';
import { AgentExecutionError, canFallback } from './errors.js';
import { captureGitSnapshot } from './gitSnapshot.js';
import type {
  AgentAdapter,
  AgentId,
  GitSnapshot,
  OrchestratorEvent,
  OrchestratorOptions,
  RunRecord,
  RunStore,
  StageRecord,
  StageResult,
  WorkflowKind,
} from './types.js';
import { addUsage, totalUsageByAgent } from './usage.js';
import { getWorkflow } from './workflows.js';

export interface OrchestratorDependencies {
  captureSnapshot?: (cwd: string) => Promise<GitSnapshot>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkflowOrchestrator {
  private active: { controller: AbortController; run: RunRecord } | undefined;
  private readonly listeners = new Set<(event: OrchestratorEvent) => void>();
  private readonly captureSnapshot: (cwd: string) => Promise<GitSnapshot>;

  public constructor(
    private readonly adapters: Record<AgentId, AgentAdapter>,
    private readonly store: RunStore,
    private readonly options: OrchestratorOptions,
    dependencies: OrchestratorDependencies = {},
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

    const now = new Date().toISOString();
    const run: RunRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      kind,
      objective: objective.trim(),
      workspacePath,
      status: 'running',
      allowWrites,
      createdAt: now,
      updatedAt: now,
      stages: getWorkflow(kind).map<StageRecord>((stage) => ({
        ...stage,
        // Write permission is granted only with this run's consent, whatever the template says.
        permission: allowWrites ? stage.permission : 'read-only',
        assignedAgent: stage.agent,
        status: 'pending',
      })),
      usage: totalUsageByAgent(),
      warnings: [],
    };
    const controller = new AbortController();
    this.active = { controller, run };

    try {
      await this.update(run);
      for (const adapter of Object.values(this.adapters)) {
        for (const warning of (await adapter.preflightWarnings?.(workspacePath)) ?? []) this.warn(run, warning);
      }
      let snapshot: GitSnapshot | undefined;
      if (kind === 'implementation') {
        snapshot = await this.snapshot(run);
        if (!snapshot.available) {
          throw new Error(
            `Implementation workflows need a working Git repository so reviewers see every change and it can be reverted. ${snapshot.warnings.join(' ')}`,
          );
        }
      }
      for (const stage of run.stages) {
        if (controller.signal.aborted) throw new Error('Workflow cancelled.');
        await this.executeStage(run, stage, controller.signal, snapshot);
        snapshot = undefined;
      }
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
    } catch (error) {
      const cancelled = controller.signal.aborted;
      run.status = cancelled ? 'cancelled' : 'failed';
      run.error = messageOf(error);
      run.completedAt = new Date().toISOString();
      const running = run.stages.find((stage) => stage.status === 'running');
      if (running) {
        running.status = cancelled ? 'cancelled' : 'failed';
        running.error = run.error;
        running.completedAt = run.completedAt;
      }
      for (const stage of run.stages.filter((item) => item.status === 'pending')) stage.status = 'skipped';
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

  private async executeStage(
    run: RunRecord,
    stage: StageRecord,
    signal: AbortSignal,
    initialSnapshot?: GitSnapshot,
  ): Promise<void> {
    stage.status = 'running';
    stage.startedAt = new Date().toISOString();
    await this.update(run);

    const snapshot = initialSnapshot ?? (await this.snapshot(run));
    if (signal.aborted) throw new Error('Workflow cancelled.');
    const max = this.options.maxContextCharacters;

    try {
      stage.result = await this.attempt(run, stage, stage.agent, buildStagePrompt(run, stage, snapshot, max), signal);
    } catch (error) {
      if (!this.options.fallbackOnQuota || !canFallback(error) || signal.aborted) throw error;
      const fallback: AgentId = stage.agent === 'claude' ? 'codex' : 'claude';
      stage.assignedAgent = fallback;
      stage.fallbackReason = messageOf(error);
      await this.update(run);
      // The failed attempt may have changed files before it stopped, so the fallback needs a fresh view.
      const fresh = await this.snapshot(run);
      if (signal.aborted) throw new Error('Workflow cancelled.');
      const prompt = buildStagePrompt(run, stage, fresh, max, { fallback: true });
      stage.result = await this.attempt(run, stage, fallback, prompt, signal);
    }

    stage.status = 'completed';
    stage.completedAt = new Date().toISOString();
    run.usage[stage.assignedAgent] = addUsage(run.usage[stage.assignedAgent], stage.result.usage);
    await this.update(run);
  }

  private async attempt(
    run: RunRecord,
    stage: StageRecord,
    agent: AgentId,
    prompt: string,
    signal: AbortSignal,
  ): Promise<StageResult> {
    try {
      return await this.adapters[agent].run({
        prompt,
        cwd: run.workspacePath,
        permission: stage.permission,
        signal,
        onEvent: (agentEvent) => this.emit({ type: 'agent-event', run, agentEvent }),
      });
    } catch (error) {
      // Quota spent by a failed attempt is still spent.
      if (error instanceof AgentExecutionError && error.usage) run.usage[agent] = addUsage(run.usage[agent], error.usage);
      throw error;
    }
  }

  private async snapshot(run: RunRecord): Promise<GitSnapshot> {
    let snapshot: GitSnapshot;
    try {
      snapshot = await this.captureSnapshot(run.workspacePath);
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

  private async update(run: RunRecord): Promise<void> {
    run.updatedAt = new Date().toISOString();
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
