import { randomUUID } from 'node:crypto';

import { buildStagePrompt } from './context.js';
import { canFallback } from './errors.js';
import { captureGitSnapshot } from './gitSnapshot.js';
import type {
  AgentAdapter,
  AgentId,
  OrchestratorEvent,
  OrchestratorOptions,
  RunRecord,
  RunStore,
  StageRecord,
  WorkflowKind,
} from './types.js';
import { addUsage, totalUsageByAgent } from './usage.js';
import { getWorkflow } from './workflows.js';

export class WorkflowOrchestrator {
  private active: { controller: AbortController; run: RunRecord } | undefined;
  private readonly listeners = new Set<(event: OrchestratorEvent) => void>();

  public constructor(
    private readonly adapters: Record<AgentId, AgentAdapter>,
    private readonly store: RunStore,
    private readonly options: OrchestratorOptions,
  ) {}

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
        assignedAgent: stage.agent,
        status: 'pending',
      })),
      usage: totalUsageByAgent(),
    };
    const controller = new AbortController();
    this.active = { controller, run };
    await this.update(run);

    try {
      for (const stage of run.stages) {
        if (controller.signal.aborted) throw new Error('Workflow cancelled.');
        await this.executeStage(run, stage, controller.signal);
      }
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
    } catch (error) {
      const cancelled = controller.signal.aborted;
      run.status = cancelled ? 'cancelled' : 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = new Date().toISOString();
      const running = run.stages.find((stage) => stage.status === 'running');
      if (running) {
        running.status = cancelled ? 'cancelled' : 'failed';
        running.error = run.error;
        running.completedAt = run.completedAt;
      }
      for (const stage of run.stages.filter((item) => item.status === 'pending')) stage.status = 'skipped';
    } finally {
      await this.update(run);
      this.active = undefined;
    }
    return run;
  }

  private async executeStage(run: RunRecord, stage: StageRecord, signal: AbortSignal): Promise<void> {
    stage.status = 'running';
    stage.startedAt = new Date().toISOString();
    await this.update(run);

    const snapshot = await captureGitSnapshot(run.workspacePath);
    const prompt = buildStagePrompt(run, stage, snapshot, this.options.maxContextCharacters);

    try {
      stage.result = await this.runAdapter(run, stage, stage.agent, prompt, signal);
    } catch (error) {
      if (!this.options.fallbackOnQuota || !canFallback(error) || signal.aborted) throw error;
      const fallback: AgentId = stage.agent === 'claude' ? 'codex' : 'claude';
      stage.assignedAgent = fallback;
      stage.fallbackReason = error instanceof Error ? error.message : String(error);
      await this.update(run);
      const fallbackPrompt = `${buildStagePrompt(run, stage, snapshot, this.options.maxContextCharacters)}

## Bounded provider fallback
The intended provider could not complete this stage. You are the recorded fallback provider. Complete the same stage contract without expanding its authority or scope.`;
      stage.result = await this.runAdapter(run, stage, fallback, fallbackPrompt, signal);
    }

    stage.status = 'completed';
    stage.completedAt = new Date().toISOString();
    run.usage[stage.assignedAgent] = addUsage(run.usage[stage.assignedAgent], stage.result.usage);
    await this.update(run);
  }

  private async runAdapter(
    run: RunRecord,
    stage: StageRecord,
    agent: AgentId,
    prompt: string,
    signal: AbortSignal,
  ) {
    return this.adapters[agent].run({
      prompt,
      cwd: run.workspacePath,
      permission: stage.permission,
      signal,
      onEvent: (agentEvent) => this.emit({ type: 'agent-event', run, agentEvent }),
    });
  }

  private async update(run: RunRecord): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await this.store.save(run);
    this.emit({ type: 'run-updated', run });
  }

  private emit(event: OrchestratorEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
