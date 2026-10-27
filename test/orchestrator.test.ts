import type { AgentAdapter, AgentHealth, AgentRunRequest, RunRecord, RunStore, StageResult } from '../src/core/types.js';
import { AgentExecutionError } from '../src/core/errors.js';
import { WorkflowOrchestrator } from '../src/core/orchestrator.js';
import { describe, expect, it } from 'vitest';

class MemoryStore implements RunStore {
  public runs: RunRecord[] = [];
  public async list(): Promise<RunRecord[]> { return this.runs; }
  public async latest(): Promise<RunRecord | undefined> { return this.runs[0]; }
  public async save(run: RunRecord): Promise<void> {
    this.runs = [structuredClone(run), ...this.runs.filter((item) => item.id !== run.id)];
  }
}

class FakeAdapter implements AgentAdapter {
  public calls: AgentRunRequest[] = [];
  public failOnce = false;
  public constructor(public readonly id: 'claude' | 'codex') {}
  public async doctor(): Promise<AgentHealth> { return { agent: this.id, available: true, detail: 'ok' }; }
  public async run(request: AgentRunRequest): Promise<StageResult> {
    this.calls.push(request);
    request.onEvent({ agent: this.id, category: 'message', message: 'working' });
    if (this.failOnce) {
      this.failOnce = false;
      throw new AgentExecutionError('usage limit reached', 'quota');
    }
    return {
      text: `${this.id} result`,
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 0 },
      rawEventCount: 1,
    };
  }
}

describe('WorkflowOrchestrator', () => {
  it('runs the complete Claude-led reciprocal brainstorming workflow', async () => {
    const store = new MemoryStore();
    const claude = new FakeAdapter('claude');
    const codex = new FakeAdapter('codex');
    const events: string[] = [];
    const orchestrator = new WorkflowOrchestrator(
      { claude, codex },
      store,
      { maxContextCharacters: 20_000, fallbackOnQuota: true },
    );
    orchestrator.onEvent((event) => events.push(event.type));

    const run = await orchestrator.start('brainstorming', 'Design the system.', process.cwd(), false);

    expect(run.status).toBe('completed');
    expect(run.stages.every((stage) => stage.status === 'completed')).toBe(true);
    expect(claude.calls).toHaveLength(3);
    expect(codex.calls).toHaveLength(2);
    expect(run.usage.claude.inputTokens).toBe(30);
    expect(run.usage.codex.inputTokens).toBe(20);
    expect(events).toContain('agent-event');
  });

  it('falls back to the other agent on quota failure', async () => {
    const store = new MemoryStore();
    const claude = new FakeAdapter('claude');
    const codex = new FakeAdapter('codex');
    claude.failOnce = true;
    const orchestrator = new WorkflowOrchestrator(
      { claude, codex },
      store,
      { maxContextCharacters: 20_000, fallbackOnQuota: true },
    );

    const run = await orchestrator.start('brainstorming', 'Design the system.', process.cwd(), false);
    expect(run.status).toBe('completed');
    expect(run.stages[0]).toMatchObject({ assignedAgent: 'codex', status: 'completed' });
    expect(run.stages[0]?.fallbackReason).toContain('usage limit');
    expect(codex.calls[0]?.prompt).toContain('Assigned agent: codex');
    expect(codex.calls[0]?.prompt).toContain('Bounded provider fallback');
  });

  it('requires explicit write consent for implementation', async () => {
    const store = new MemoryStore();
    const claude = new FakeAdapter('claude');
    const codex = new FakeAdapter('codex');
    const orchestrator = new WorkflowOrchestrator(
      { claude, codex },
      store,
      { maxContextCharacters: 20_000, fallbackOnQuota: false },
    );
    await expect(orchestrator.start('implementation', 'Change files.', process.cwd(), false)).rejects.toThrow(
      'explicit workspace-write consent',
    );
  });
});
