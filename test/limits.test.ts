import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentExecutionError, classifyFailure } from '../src/core/errors.js';
import { AgentLimits, parseLimitReset } from '../src/core/limits.js';
import { WorkflowOrchestrator } from '../src/core/orchestrator.js';
import type { AgentAdapter, AgentHealth, AgentRunRequest, GitSnapshot, RunRecord, RunStore, StageResult } from '../src/core/types.js';
import { continueAt, ContinuationScheduler, type Continuation } from '../src/ui/continuations.js';

const NOW = new Date(2026, 9, 28, 10, 0, 0);

describe('reading when a usage limit resets', () => {
  it('reads Unix timestamps, ISO times, durations, and clock times', () => {
    const epoch = Math.floor(NOW.getTime() / 1000) + 3600;
    expect(parseLimitReset(`Claude AI usage limit reached|${epoch}`, NOW)?.getTime()).toBe(epoch * 1000);
    expect(parseLimitReset('Limit resets at 2026-10-28T12:30:00Z', NOW)?.toISOString()).toBe('2026-10-28T12:30:00.000Z');
    expect(parseLimitReset("You've hit your usage limit. Try again in 2 hours 13 minutes.", NOW)?.getTime()).toBe(NOW.getTime() + (2 * 60 + 13) * 60_000);
    expect(parseLimitReset('rate limited, retry in 4h 12m', NOW)?.getTime()).toBe(NOW.getTime() + (4 * 60 + 12) * 60_000);
    expect(parseLimitReset('5-hour limit reached ∙ resets 3pm', NOW)).toEqual(new Date(2026, 9, 28, 15, 0, 0));
    expect(parseLimitReset('Session limit reached, resets at 9:30 am', NOW)).toEqual(new Date(2026, 9, 29, 9, 30, 0));
    expect(parseLimitReset('limit reached; available at 14:45', NOW)).toEqual(new Date(2026, 9, 28, 14, 45, 0));
  });

  it('ignores times in the past, implausibly far away, or missing', () => {
    expect(parseLimitReset('usage limit reached|1000000000', NOW)).toBeUndefined();
    expect(parseLimitReset('try again in 90 days', NOW)).toBeUndefined();
    expect(parseLimitReset('usage limit reached', NOW)).toBeUndefined();
  });

  it('classifies the wording both CLIs use for exhausted limits and credits as a quota failure', () => {
    for (const message of ['5-hour limit reached ∙ resets 3pm', "You've hit your usage limit.", 'Credit balance is too low', 'Weekly limit reached', 'out of credits']) {
      expect(classifyFailure(message)).toBe('quota');
    }
  });
});

describe('AgentLimits', () => {
  it('keeps a limit until its reset, then lets the agent be tried again with a longer estimate next time', () => {
    let clock = NOW.getTime();
    const limits = new AgentLimits([], () => clock);
    const first = limits.record('claude', 'usage limit reached');
    expect(first.estimated).toBe(true);
    expect(Date.parse(first.until) - clock).toBe(15 * 60_000);
    expect(limits.active('claude')).toBeDefined();
    expect(limits.exhausted).toBe(false);
    clock += 16 * 60_000;
    expect(limits.active('claude')).toBeUndefined();
    expect(Date.parse(limits.record('claude', 'usage limit reached').until) - clock).toBe(30 * 60_000);
    limits.clear('claude');
    expect(Date.parse(limits.record('claude', 'usage limit reached').until) - clock).toBe(15 * 60_000);
  });

  it('knows when both agents are out and which resets first, and survives a restart', () => {
    const clock = NOW.getTime();
    const limits = new AgentLimits([], () => clock);
    limits.record('claude', 'try again in 3 hours');
    limits.record('codex', 'try again in 1 hour');
    expect(limits.exhausted).toBe(true);
    expect(limits.nextReset()?.getTime()).toBe(clock + 3_600_000);
    const restored = new AgentLimits(JSON.parse(JSON.stringify(limits)) as never, () => clock);
    expect(restored.all().map((limit) => limit.agent)).toEqual(['codex', 'claude']);
    expect(new AgentLimits([{ agent: 'nobody' } as never]).all()).toEqual([]);
  });
});

// ---- Solo mode in the orchestrator ----

class MemoryStore implements RunStore {
  public runs: RunRecord[] = [];
  public async list(): Promise<RunRecord[]> {
    return structuredClone(this.runs);
  }
  public async latest(): Promise<RunRecord | undefined> {
    return structuredClone(this.runs[0]);
  }
  public async save(run: RunRecord): Promise<void> {
    this.runs = [structuredClone(run), ...this.runs.filter((item) => item.id !== run.id)];
  }
}

const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 };
const pass = 'Checked.\n```verdict\n{"verdict": "pass", "findings": []}\n```';

class Agent implements AgentAdapter {
  public calls: AgentRunRequest[] = [];
  /** A usage-limit message to fail with, while set. */
  public limited: string | undefined;
  public constructor(
    public readonly id: 'claude' | 'codex',
    private readonly sessionId?: string,
  ) {}
  public async doctor(): Promise<AgentHealth> {
    return { agent: this.id, available: true, detail: 'ok' };
  }
  public async run(request: AgentRunRequest): Promise<StageResult> {
    this.calls.push(request);
    if (this.limited) throw new AgentExecutionError(this.limited, 'quota', 1);
    const review = /- ID: codex-check/.test(request.prompt);
    return { text: review ? pass : `${this.id} answer`, usage, rawEventCount: 1, ...(this.sessionId ? { providerSessionId: this.sessionId } : {}) };
  }
}

const snapshot: GitSnapshot = { available: true, status: '', diff: '', diffStat: '', untracked: [], warnings: [] };

function setup(clock = (): number => NOW.getTime()) {
  const store = new MemoryStore();
  const claude = new Agent('claude', 'claude-session');
  const codex = new Agent('codex');
  const limits = new AgentLimits([], clock);
  const orchestrator = new WorkflowOrchestrator(
    { claude, codex },
    store,
    { maxContextCharacters: 20_000, fallbackOnQuota: true, resumeSessions: ['claude'] },
    { captureSnapshot: async () => snapshot, limits },
  );
  return { claude, codex, limits, orchestrator };
}

describe('when one agent is at its usage limit', () => {
  it('remembers the limit, so later stages go straight to the other agent without failing first', async () => {
    const { claude, codex, limits, orchestrator } = setup(() => Date.now());
    claude.limited = 'Claude usage limit reached. Try again in 2 hours.';

    const first = await orchestrator.start('chat', 'Why?', process.cwd(), false);
    expect(first.status).toBe('completed');
    expect(first.stages[0]).toMatchObject({ agent: 'claude', assignedAgent: 'codex' });
    expect(limits.active('claude')?.estimated).toBe(false);
    expect(claude.calls).toHaveLength(1);

    const second = await orchestrator.start('chat', 'And then?', process.cwd(), false);
    expect(second.status).toBe('completed');
    // Claude is not tried again while its limit is in force; Codex works alone.
    expect(claude.calls).toHaveLength(1);
    expect(second.stages[0]?.assignedAgent).toBe('codex');
    expect(second.stages[0]?.fallbackReason).toMatch(/Claude is at its usage limit until/);
    expect(codex.calls.at(-2)?.prompt).toContain('Bounded provider fallback');
  });

  it('tries the agent again after its limit resets, and forgets the limit once it works', async () => {
    let clock = NOW.getTime();
    const { claude, limits, orchestrator } = setup(() => clock);
    limits.record('claude', 'usage limit reached');
    clock += 20 * 60_000;
    const run = await orchestrator.start('chat', 'Why?', process.cwd(), false);
    expect(run.stages[0]?.assignedAgent).toBe('claude');
    expect(claude.calls).toHaveLength(1);
    expect(limits.toJSON()).toEqual([]);
  });

  it('stops with the reset time when both agents are out, and continues on resume once they reset', async () => {
    let clock = NOW.getTime();
    const { claude, codex, limits, orchestrator } = setup(() => clock);
    claude.limited = 'usage limit reached, try again in 3 hours';
    codex.limited = "You've hit your usage limit. Try again in 1 hour 30 minutes.";

    const stopped = await orchestrator.start('chat', 'Why?', process.cwd(), false);
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toMatch(/Claude and Codex are both at their usage limits/);
    expect(stopped.limitReset).toBe(new Date(clock + 90 * 60_000).toISOString());
    expect(limits.exhausted).toBe(true);

    clock += 91 * 60_000;
    codex.limited = undefined;
    const resumed = await orchestrator.resume(stopped.id, false);
    expect(resumed.status).toBe('completed');
    expect(resumed.limitReset).toBeUndefined();
    // Claude is still out, so Codex did the whole message alone.
    expect(resumed.stages.map((stage) => stage.assignedAgent)).toEqual(['codex', 'codex']);
  });

  it('waits for the agent itself when fallback is turned off', async () => {
    const store = new MemoryStore();
    const claude = new Agent('claude');
    const limits = new AgentLimits();
    const orchestrator = new WorkflowOrchestrator({ claude, codex: new Agent('codex') }, store, { maxContextCharacters: 20_000, fallbackOnQuota: false }, {
      captureSnapshot: async () => snapshot,
      limits,
    });
    claude.limited = 'usage limit reached, try again in 2 hours';
    const run = await orchestrator.start('chat', 'Why?', process.cwd(), false);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/Claude is at its usage limit and fallback is turned off/);
    expect(run.limitReset).toBe(limits.active('claude')?.until);
  });

  it('gives a continued session the turns it missed while the other agent answered alone', async () => {
    const { claude, orchestrator } = setup();
    await orchestrator.start('chat', 'Third question', process.cwd(), false, {
      history: '### User (chat)\nFirst\n\n### Answer\nOne\n\n### User (chat)\nSecond\n\n### Answer\nTwo',
      continueSessions: { claude: 'claude-session' },
      catchUp: { claude: '### User (chat)\nSecond\n\n### Answer\nTwo (answered by Codex)' },
    });
    const resumed = claude.calls[0]?.resume?.prompt ?? '';
    expect(resumed).toContain('answered while you were unavailable');
    expect(resumed).toContain('Two (answered by Codex)');
    expect(resumed).not.toContain('First');
  });
});

describe('continuing after the limits reset', () => {
  afterEach(() => vi.useRealTimers());

  it('fires at the reset plus a margin, retries while another run is active, and saves what is pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const saved: Continuation[][] = [];
    const outcomes: ('done' | 'retry')[] = ['retry', 'done'];
    const fired: string[] = [];
    const scheduler = new ContinuationScheduler([], (items) => saved.push(items), async (item) => {
      fired.push(item.runId);
      return outcomes.shift() ?? 'done';
    });
    const at = continueAt(new Date(NOW.getTime() + 10 * 60_000).toISOString());
    expect(Date.parse(at) - NOW.getTime()).toBe(11 * 60_000);
    scheduler.schedule({ runId: 'r1', at, commands: '[]' });
    expect(saved.at(-1)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual(['r1']);
    // Another run was active, so it waits a minute and tries again.
    expect(scheduler.get('r1')).toBeDefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual(['r1', 'r1']);
    expect(scheduler.get('r1')).toBeUndefined();
    expect(saved.at(-1)).toEqual([]);
    scheduler.dispose();
  });

  it('keeps a continuation the run scheduled again while it was continuing, and drops cancelled ones', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const later = new Date(NOW.getTime() + 3_600_000).toISOString();
    const scheduler: ContinuationScheduler = new ContinuationScheduler([], () => undefined, async (item) => {
      // The continued run stopped at a limit again and was rescheduled.
      scheduler.schedule({ ...item, at: later });
      return 'done';
    });
    scheduler.schedule({ runId: 'r1', at: new Date(NOW.getTime() + 1_000).toISOString(), commands: '[]' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(scheduler.get('r1')?.at).toBe(later);
    expect(scheduler.cancel('r1')).toBe(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(scheduler.size).toBe(0);
    scheduler.dispose();
  });

  it('restores pending continuations after a restart and runs overdue ones soon after start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fired: string[] = [];
    const overdue = { runId: 'r1', at: new Date(NOW.getTime() - 60_000).toISOString(), commands: '[]' };
    const scheduler = new ContinuationScheduler([overdue, { runId: 42 }], () => undefined, async (item) => {
      fired.push(item.runId);
      return 'done';
    });
    expect(scheduler.size).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fired).toEqual(['r1']);
    scheduler.dispose();
  });
});
