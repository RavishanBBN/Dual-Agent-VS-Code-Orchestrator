import { describe, expect, it } from 'vitest';

import { AgentExecutionError } from '../src/core/errors.js';
import { WorkflowOrchestrator } from '../src/core/orchestrator.js';
import type {
  AgentAdapter,
  AgentHealth,
  AgentRunRequest,
  GitSnapshot,
  RunRecord,
  RunStore,
  StageResult,
} from '../src/core/types.js';

class MemoryStore implements RunStore {
  public runs: RunRecord[] = [];
  public failures = 0;
  public async list(): Promise<RunRecord[]> {
    return this.runs;
  }
  public async latest(): Promise<RunRecord | undefined> {
    return this.runs[0];
  }
  public async save(run: RunRecord): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('disk full');
    }
    this.runs = [structuredClone(run), ...this.runs.filter((item) => item.id !== run.id)];
  }
}

const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 0 };

class FakeAdapter implements AgentAdapter {
  public calls: AgentRunRequest[] = [];
  public failOnce = false;
  public warnings: string[] = [];
  public constructor(public readonly id: 'claude' | 'codex') {}
  public async doctor(): Promise<AgentHealth> {
    return { agent: this.id, available: true, detail: 'ok' };
  }
  public async preflightWarnings(): Promise<string[]> {
    return this.warnings;
  }
  public async run(request: AgentRunRequest): Promise<StageResult> {
    this.calls.push(request);
    request.onEvent({ agent: this.id, category: 'message', message: 'working' });
    if (this.failOnce) {
      this.failOnce = false;
      throw new AgentExecutionError('usage limit reached', 'quota', 1, { ...usage, inputTokens: 4 });
    }
    return { text: `${this.id} result`, usage, rawEventCount: 1 };
  }
}

const clean: GitSnapshot = { available: true, status: '', diff: '', diffStat: '', untracked: [], warnings: [] };
const noGit: GitSnapshot = { ...clean, available: false, warnings: ['The workspace is not a Git repository, so agents receive no diff.'] };

function setup(snapshot: GitSnapshot = clean, fallbackOnQuota = true) {
  const store = new MemoryStore();
  const claude = new FakeAdapter('claude');
  const codex = new FakeAdapter('codex');
  let snapshots = 0;
  const orchestrator = new WorkflowOrchestrator(
    { claude, codex },
    store,
    { maxContextCharacters: 20_000, fallbackOnQuota },
    {
      captureSnapshot: async () => {
        snapshots += 1;
        return snapshot;
      },
    },
  );
  return { store, claude, codex, orchestrator, snapshots: () => snapshots };
}

describe('WorkflowOrchestrator', () => {
  it('runs the complete Claude-led reciprocal brainstorming workflow', async () => {
    const { claude, codex, orchestrator } = setup();
    const events: string[] = [];
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

  it('falls back on quota failure with a fresh snapshot and counts the failed attempt', async () => {
    const { claude, codex, orchestrator, snapshots } = setup();
    claude.failOnce = true;

    const run = await orchestrator.start('brainstorming', 'Design the system.', process.cwd(), false);

    expect(run.status).toBe('completed');
    expect(run.stages[0]).toMatchObject({ assignedAgent: 'codex', status: 'completed' });
    expect(run.stages[0]?.fallbackReason).toContain('usage limit');
    expect(codex.calls[0]?.prompt).toContain('Assigned agent: codex');
    expect(codex.calls[0]?.prompt).toContain('Bounded provider fallback');
    // Five stages plus one fresh snapshot for the fallback attempt.
    expect(snapshots()).toBe(6);
    // Two successful Claude stages plus the four tokens the failed attempt reported.
    expect(run.usage.claude.inputTokens).toBe(24);
  });

  it('requires explicit write consent for implementation', async () => {
    const { orchestrator } = setup(clean, false);
    await expect(orchestrator.start('implementation', 'Change files.', process.cwd(), false)).rejects.toThrow(
      'explicit workspace-write consent',
    );
  });

  it('refuses to run implementation stages without a usable Git snapshot', async () => {
    const { claude, codex, orchestrator } = setup(noGit);
    const run = await orchestrator.start('implementation', 'Change files.', process.cwd(), true);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('need a working Git repository');
    expect(run.error).toContain('not a Git repository');
    expect(run.stages.every((stage) => stage.status === 'skipped')).toBe(true);
    expect(claude.calls).toHaveLength(0);
    expect(codex.calls).toHaveLength(0);
  });

  it('records snapshot and provider warnings while a read-only workflow continues', async () => {
    const { codex, orchestrator } = setup(noGit);
    codex.warnings = ['The repository contains .codex.'];
    const run = await orchestrator.start('brainstorming', 'Design the system.', process.cwd(), false);
    expect(run.status).toBe('completed');
    expect(run.warnings).toEqual(['The repository contains .codex.', noGit.warnings[0]]);
  });

  it('honors a cancellation that arrives while the snapshot is being captured', async () => {
    const store = new MemoryStore();
    const claude = new FakeAdapter('claude');
    const codex = new FakeAdapter('codex');
    const orchestrator: WorkflowOrchestrator = new WorkflowOrchestrator(
      { claude, codex },
      store,
      { maxContextCharacters: 20_000, fallbackOnQuota: true },
      {
        captureSnapshot: async () => {
          orchestrator.cancel();
          return clean;
        },
      },
    );

    const run = await orchestrator.start('brainstorming', 'Design the system.', process.cwd(), false);

    expect(run.status).toBe('cancelled');
    expect(run.stages[0]?.status).toBe('cancelled');
    expect(claude.calls).toHaveLength(0);
  });

  it('is never left stuck as running when run history cannot be saved', async () => {
    const { store, orchestrator } = setup();
    store.failures = 2;

    const failed = await orchestrator.start('brainstorming', 'Design the system.', process.cwd(), false);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('disk full');
    expect(failed.warnings?.[0]).toContain('could not be saved');
    expect(orchestrator.activeRun).toBeUndefined();

    const next = await orchestrator.start('brainstorming', 'Design the system.', process.cwd(), false);
    expect(next.status).toBe('completed');
  });

  it('keeps running when an event listener throws', async () => {
    const { orchestrator } = setup();
    orchestrator.onEvent(() => {
      throw new Error('view disposed');
    });
    const run = await orchestrator.start('brainstorming', 'Design the system.', process.cwd(), false);
    expect(run.status).toBe('completed');
  });
});
