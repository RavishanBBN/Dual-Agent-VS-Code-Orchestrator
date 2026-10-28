import { describe, expect, it } from 'vitest';

import { AgentExecutionError } from '../src/core/errors.js';
import { canResume, STAGE_ACTIVITY_LIMIT, WorkflowOrchestrator, type CheckRequest, type OrchestratorDependencies } from '../src/core/orchestrator.js';
import type {
  AgentAdapter,
  AgentHealth,
  AgentRunRequest,
  ApprovalDecision,
  CheckResult,
  GitSnapshot,
  OrchestratorOptions,
  RunRecord,
  RunStore,
  StageResult,
} from '../src/core/types.js';

class MemoryStore implements RunStore {
  public runs: RunRecord[] = [];
  public failures = 0;
  public async list(): Promise<RunRecord[]> {
    return structuredClone(this.runs);
  }
  public async latest(): Promise<RunRecord | undefined> {
    return structuredClone(this.runs[0]);
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

const stageOf = (request: AgentRunRequest): string => /- ID: (\S+)/.exec(request.prompt)?.[1] ?? '';
const verdict = (outcome: 'pass' | 'fail'): string =>
  `Review.\n\`\`\`verdict\n${JSON.stringify({ verdict: outcome, findings: outcome === 'fail' ? [{ severity: 'high', title: 'Off-by-one in pager' }] : [] })}\n\`\`\``;

class FakeAdapter implements AgentAdapter {
  public calls: AgentRunRequest[] = [];
  public failOnce = false;
  public warnings: string[] = [];
  /** Returns the stage output, or an error to throw. */
  public respond: (request: AgentRunRequest) => string | Error = () => `${this.id} result`;
  public constructor(
    public readonly id: 'claude' | 'codex',
    private readonly sessionId?: string,
  ) {}
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
    const response = this.respond(request);
    if (response instanceof Error) throw response;
    return {
      text: response,
      usage,
      rawEventCount: 1,
      ...(this.sessionId ? { providerSessionId: this.sessionId } : {}),
      ...(request.resume ? { resumedSession: true } : {}),
    };
  }
}

const clean: GitSnapshot = { available: true, status: '', diff: '', diffStat: '', untracked: [], warnings: [] };
const noGit: GitSnapshot = { ...clean, available: false, warnings: ['The workspace is not a Git repository, so agents receive no diff.'] };

interface Setup {
  snapshot?: GitSnapshot;
  options?: Partial<OrchestratorOptions>;
  dependencies?: OrchestratorDependencies;
  claudeSession?: string;
}

function setup({ snapshot = clean, options = {}, dependencies = {}, claudeSession }: Setup = {}) {
  const store = new MemoryStore();
  const claude = new FakeAdapter('claude', claudeSession);
  const codex = new FakeAdapter('codex');
  let snapshots = 0;
  const orchestrator = new WorkflowOrchestrator(
    { claude, codex },
    store,
    { maxContextCharacters: 20_000, fallbackOnQuota: true, ...options },
    {
      captureSnapshot: async () => {
        snapshots += 1;
        return snapshot;
      },
      ...dependencies,
    },
  );
  return { store, claude, codex, orchestrator, snapshots: () => snapshots };
}

const check = (exitCode: number): CheckResult => ({ command: ['npm', 'test'], exitCode, durationMs: 1200, output: exitCode ? '1 failing' : 'all passing' });

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
    expect(events).toEqual(expect.arrayContaining(['agent-event', 'log']));
    // Review stages ask for a verdict; brainstorming records it without gating on it.
    expect(codex.calls[0]?.prompt).toContain('Required verdict');
    expect(run.stages[1]?.verdict?.outcome).toBe('missing');
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
    const { orchestrator } = setup({ options: { fallbackOnQuota: false } });
    await expect(orchestrator.start('implementation', 'Change files.', process.cwd(), false)).rejects.toThrow(
      'explicit workspace-write consent',
    );
  });

  it('refuses to run implementation stages without a usable Git snapshot', async () => {
    const { claude, codex, orchestrator } = setup({ snapshot: noGit });
    const run = await orchestrator.start('implementation', 'Change files.', process.cwd(), true);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('needs a working Git repository');
    expect(run.error).toContain('not a Git repository');
    expect(run.stages.every((stage) => stage.status === 'skipped')).toBe(true);
    expect(claude.calls).toHaveLength(0);
    expect(codex.calls).toHaveLength(0);
  });

  it('records snapshot and provider warnings while a read-only workflow continues', async () => {
    const { codex, orchestrator } = setup({ snapshot: noGit });
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

describe('final gate and fix rounds', () => {
  it('completes when the final verification passes', async () => {
    const { codex, orchestrator } = setup({ options: { maxFixRounds: 1 } });
    codex.respond = () => verdict('pass');
    const run = await orchestrator.start('implementation', 'Add paging.', process.cwd(), true);
    expect(run.status).toBe('completed');
    expect(run.stages).toHaveLength(7);
    expect(run.unresolved).toBeUndefined();
  });

  it('adds a fix round when the final verification fails, and completes once a re-verification passes', async () => {
    const { claude, codex, orchestrator } = setup({ options: { maxFixRounds: 2 } });
    let finalVerifications = 0;
    codex.respond = (request) => {
      if (!stageOf(request).includes('verification')) return verdict('pass');
      finalVerifications += 1;
      return verdict(finalVerifications === 1 ? 'fail' : 'pass');
    };

    const run = await orchestrator.start('implementation', 'Add paging.', process.cwd(), true);

    expect(run.status).toBe('completed');
    expect(run.stages.map((stage) => stage.id)).toEqual([
      'claude-plan',
      'codex-plan-review',
      'claude-implement',
      'codex-code-review',
      'claude-adjudicate-fix',
      'codex-final-verification',
      'claude-fix-round-1',
      'codex-reverification-round-1',
      'claude-finalize',
    ]);
    expect(run.stages[6]).toMatchObject({ permission: 'workspace-write', status: 'completed' });
    const fixPrompt = claude.calls.find((request) => stageOf(request) === 'claude-fix-round-1')?.prompt;
    expect(fixPrompt).toContain('1 high');
    expect(fixPrompt).toContain('Off-by-one in pager');
  });

  it('completes with unresolved findings when the fix rounds run out', async () => {
    const { codex, orchestrator } = setup({ options: { maxFixRounds: 1 } });
    codex.respond = (request) => verdict(stageOf(request).includes('verification') ? 'fail' : 'pass');
    const run = await orchestrator.start('implementation', 'Add paging.', process.cwd(), true);
    expect(run.status).toBe('completed-with-findings');
    expect(run.unresolved).toContain('1 high');
    expect(run.stages.filter((stage) => stage.round === 1)).toHaveLength(2);
  });

  it('never treats a missing verdict as a pass', async () => {
    const { orchestrator } = setup({ options: { maxFixRounds: 0 } });
    const run = await orchestrator.start('implementation', 'Add paging.', process.cwd(), true);
    expect(run.status).toBe('completed-with-findings');
    expect(run.unresolved).toContain('no machine-readable verdict');
    expect(run.stages).toHaveLength(7);
  });

  it('runs verification after every editing stage, shows the result to reviewers, and gates on it', async () => {
    const checkRequests: CheckRequest[] = [];
    // Implement passes; adjudication fails; the repair fails too; the fix round passes.
    const results = [[check(0)], [check(1)], [check(1)], [check(0)]];
    const { claude, codex, orchestrator } = setup({
      options: { maxFixRounds: 1, verificationCommands: [['npm', 'test']] },
      dependencies: {
        runChecks: async (request) => {
          checkRequests.push(request);
          return results.shift() ?? [check(0)];
        },
      },
    });
    codex.respond = () => verdict('pass');

    const run = await orchestrator.start('implementation', 'Add paging.', process.cwd(), true);

    expect(checkRequests).toHaveLength(4);
    expect(run.stages.find((stage) => stage.id === 'claude-adjudicate-fix')?.checks?.[0]?.exitCode).toBe(1);
    // One repair right after the failing checks, before Codex's review; it is never added twice.
    const ids = run.stages.map((stage) => stage.id);
    expect(ids.indexOf('claude-repair')).toBe(ids.indexOf('claude-adjudicate-fix') + 1);
    expect(ids.filter((id) => id === 'claude-repair')).toHaveLength(1);
    // The repair's checks still failed, so the gate fails even though Codex passed it, and a fix round follows.
    expect(ids).toContain('claude-fix-round-1');
    expect(run.status).toBe('completed');
    const reviewPrompt = codex.calls.find((request) => stageOf(request) === 'codex-final-verification')?.prompt ?? '';
    expect(reviewPrompt).toContain('Orchestrator-run checks');
    expect(reviewPrompt).toContain('`npm test`: failed with exit code 1');
    expect(reviewPrompt).toContain('1 failing');
    // Editing stages may run the consented commands themselves; read-only stages may not.
    expect(claude.calls.find((request) => stageOf(request) === 'claude-implement')?.allowedCommands).toEqual([['npm', 'test']]);
    expect(claude.calls.find((request) => stageOf(request) === 'claude-plan')?.allowedCommands).toBeUndefined();
  });

  it('lets Claude repair failing checks once, before the review, so Codex reviews working code', async () => {
    const results = [[check(1)], [check(0)]];
    const { codex, orchestrator } = setup({
      options: { isolation: 'none', maxFixRounds: 1, verificationCommands: [['npm', 'test']] },
      dependencies: { runChecks: async () => results.shift() ?? [check(0)] },
    });
    codex.respond = () => verdict('pass');
    const run = await orchestrator.start('edit', 'Return 0 for an empty list.', process.cwd(), true);
    expect(run.stages.map((stage) => stage.id)).toEqual(['claude-edit', 'claude-repair', 'codex-change-review']);
    expect(run.status).toBe('completed');
    expect(codex.calls[0]?.prompt).toContain('`npm test`: passed');
  });
});

describe('plan approval', () => {
  it('waits for approval before the first editing stage and passes guidance to later prompts', async () => {
    const statuses: string[] = [];
    const requested: string[] = [];
    const { claude, orchestrator } = setup({
      options: { approvePlan: true },
      dependencies: {
        requestApproval: async (_run, stage): Promise<ApprovalDecision> => {
          requested.push(stage.id);
          return { approved: true, notes: 'Keep the public API stable.' };
        },
      },
    });
    orchestrator.onEvent((event) => statuses.push(event.run.status));

    const run = await orchestrator.start('implementation', 'Add paging.', process.cwd(), true);

    expect(requested).toEqual(['claude-implement']);
    expect(statuses).toContain('awaiting-approval');
    expect(run.approval?.notes).toBe('Keep the public API stable.');
    const implement = claude.calls.find((request) => stageOf(request) === 'claude-implement');
    expect(implement?.prompt).toContain('User guidance given when approving the plan');
    expect(implement?.prompt).toContain('Keep the public API stable.');
  });

  it('cancels without editing anything when the plan is rejected', async () => {
    const { claude, orchestrator } = setup({
      options: { approvePlan: true },
      dependencies: { requestApproval: async () => ({ approved: false }) },
    });
    const run = await orchestrator.start('implementation', 'Add paging.', process.cwd(), true);
    expect(run.status).toBe('cancelled');
    expect(run.error).toContain('rejected');
    expect(claude.calls.map(stageOf)).toEqual(['claude-plan']);
    expect(run.stages.find((stage) => stage.id === 'claude-implement')?.status).toBe('skipped');
  });

  it('treats a cancellation during the wait as cancelled', async () => {
    const holder: { orchestrator?: WorkflowOrchestrator } = {};
    const { orchestrator } = setup({
      options: { approvePlan: true },
      dependencies: {
        requestApproval: async () => {
          holder.orchestrator?.cancel();
          return { approved: true };
        },
      },
    });
    holder.orchestrator = orchestrator;
    const run = await orchestrator.start('implementation', 'Add paging.', process.cwd(), true);
    expect(run.status).toBe('cancelled');
    expect(run.approval).toBeUndefined();
  });
});

describe('sessions and resuming', () => {
  it('continues Claude\'s own session in later Claude stages, without repeating its earlier output', async () => {
    const { claude, codex, orchestrator } = setup({ options: { resumeSessions: ['claude'] }, claudeSession: 'ses-claude' });
    claude.respond = (request) => `CLAUDE-OUTPUT-${stageOf(request)}`;

    const run = await orchestrator.start('brainstorming', 'Design the system.', process.cwd(), false);

    expect(claude.calls[0]?.resume).toBeUndefined();
    const synthesis = claude.calls[1];
    expect(synthesis?.resume?.sessionId).toBe('ses-claude');
    // The fresh prompt is complete; the resumed prompt leaves out what the session already holds.
    expect(synthesis?.prompt).toContain('CLAUDE-OUTPUT-claude-proposal');
    expect(synthesis?.resume?.prompt).not.toContain('CLAUDE-OUTPUT-claude-proposal');
    expect(synthesis?.resume?.prompt).toContain('already in this session');
    expect(synthesis?.resume?.prompt).toContain('codex result');
    expect(codex.calls.every((request) => request.resume === undefined)).toBe(true);
    expect(run.stages[2]?.result?.resumedSession).toBe(true);
  });

  it('resumes a failed run from its first unfinished stage', async () => {
    const { claude, orchestrator } = setup({ options: { approvePlan: true }, dependencies: { requestApproval: async () => ({ approved: true }) } });
    claude.respond = (request) => (stageOf(request) === 'claude-implement' ? new AgentExecutionError('disk full', 'unknown', 1) : 'claude result');
    const failed = await orchestrator.start('implementation', 'Add paging.', process.cwd(), true);
    expect(failed.status).toBe('failed');
    expect(canResume(failed)).toBe(true);

    claude.respond = () => 'claude result';
    const before = claude.calls.length;
    const resumed = await orchestrator.resume(failed.id, true);

    expect(resumed.status).toBe('completed-with-findings');
    expect(resumed.resumeCount).toBe(1);
    expect(resumed.error).toBeUndefined();
    // The completed plan was not repeated, and the earlier approval still stands.
    expect(claude.calls.slice(before).map(stageOf)).toEqual(['claude-implement', 'claude-adjudicate-fix', 'claude-finalize']);
    expect(resumed.stages.every((stage) => stage.status === 'completed')).toBe(true);
  });

  it('refuses to resume completed runs, runs without consent, and runs whose worktree is gone', async () => {
    const worktree = { path: '/wt', workingDirectory: '/wt', repositoryRoot: '/repo', baseCommit: 'abc', state: 'active' as const };
    const { orchestrator, store } = setup({ dependencies: { worktreeExists: async () => false } });
    const completed = await orchestrator.start('brainstorming', 'Design it.', process.cwd(), false);
    await expect(orchestrator.resume(completed.id, false)).rejects.toThrow('Only failed or cancelled runs');

    const failed: RunRecord = { ...structuredClone(completed), id: 'failed-run', kind: 'implementation', status: 'failed', allowWrites: true };
    await store.save(failed);
    await expect(orchestrator.resume('failed-run', false)).rejects.toThrow('consent');
    await store.save({ ...failed, worktree });
    await expect(orchestrator.resume('failed-run', true)).rejects.toThrow('no longer exists');
    await store.save({ ...failed, worktree: { ...worktree, state: 'applied' } });
    await expect(orchestrator.resume('failed-run', true)).rejects.toThrow('already applied');
    await expect(orchestrator.resume('missing', true)).rejects.toThrow('no longer in the history');
  });

  it('marks runs left active by a closed window as cancelled and resumable', async () => {
    const { orchestrator, store } = setup();
    const run = await orchestrator.start('brainstorming', 'Design it.', process.cwd(), false);
    run.status = 'running';
    run.stages[2]!.status = 'running';
    run.stages[3]!.status = 'pending';
    await store.save(run);

    const [recovered] = await orchestrator.recoverInterrupted();

    expect(recovered).toMatchObject({ id: run.id, status: 'cancelled' });
    expect(recovered?.error).toContain('VS Code closed');
    expect(recovered?.stages.map((stage) => stage.status).slice(2, 4)).toEqual(['cancelled', 'skipped']);
    expect(canResume(recovered!)).toBe(true);
    expect(await orchestrator.recoverInterrupted()).toEqual([]);
  });

  it('updates a finished run and reports the change', async () => {
    const { orchestrator, store } = setup();
    const run = await orchestrator.start('brainstorming', 'Design it.', process.cwd(), false);
    const seen: string[] = [];
    orchestrator.onEvent((event) => seen.push(event.type));
    await orchestrator.updateRun(run.id, (record) => {
      record.warnings = ['changed'];
    });
    expect((await store.latest())?.warnings).toEqual(['changed']);
    expect(seen).toEqual(['run-updated']);
  });
});

describe('worktree isolation', () => {
  const info = { path: '/storage/wt', workingDirectory: '/storage/wt/app', repositoryRoot: '/repo', baseCommit: 'base', state: 'active' as const };

  it('runs every stage and check in the worktree and excludes both trees from executable lookup', async () => {
    const prepared: string[] = [];
    const checkRequests: CheckRequest[] = [];
    const { claude, codex, orchestrator } = setup({
      options: { isolation: 'worktree', setupCommands: [['npm', 'ci']], verificationCommands: [['npm', 'test']] },
      dependencies: {
        prepareWorktree: async (workspacePath) => {
          prepared.push(workspacePath);
          return { info: { ...info }, warnings: ['Untracked files not copied into the isolated worktree: .env (name suggests a secret).'] };
        },
        runChecks: async (request) => {
          checkRequests.push(request);
          return [check(0)];
        },
      },
    });

    const run = await orchestrator.start('implementation', 'Add paging.', '/repo/app', true);

    expect(prepared).toEqual(['/repo/app']);
    expect(run.isolation).toBe('worktree');
    expect(run.worktree).toMatchObject({ workingDirectory: '/storage/wt/app', setupCompleted: true });
    expect(run.warnings?.[0]).toContain('.env');
    expect([...claude.calls, ...codex.calls].every((request) => request.cwd === '/storage/wt/app')).toBe(true);
    expect(claude.calls[0]?.untrustedDirectories).toEqual(['/repo/app', '/storage/wt', '/repo']);
    expect(checkRequests[0]?.commands).toEqual([['npm', 'ci']]);
    expect(checkRequests.every((request) => request.cwd === '/storage/wt/app')).toBe(true);
    expect(run.setupChecks).toHaveLength(1);
  });

  it('fails before any agent runs when a setup command fails', async () => {
    const { claude, orchestrator } = setup({
      options: { isolation: 'worktree', setupCommands: [['npm', 'ci']] },
      dependencies: {
        prepareWorktree: async () => ({ info: { ...info }, warnings: [] }),
        runChecks: async () => [{ ...check(1), command: ['npm', 'ci'] }],
      },
    });
    const run = await orchestrator.start('implementation', 'Add paging.', '/repo/app', true);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Worktree setup failed: `npm ci` failed with exit code 1');
    expect(claude.calls).toHaveLength(0);
    expect(run.worktree?.setupCompleted).toBeUndefined();
  });

  it('keeps brainstorming in the workspace', async () => {
    const { claude, orchestrator } = setup({ options: { isolation: 'worktree' } });
    const run = await orchestrator.start('brainstorming', 'Design it.', '/repo/app', false);
    expect(run.isolation).toBe('none');
    expect(claude.calls.every((request) => request.cwd === '/repo/app')).toBe(true);
  });
});

describe('conversation turns', () => {
  const info = { path: '/storage/wt', workingDirectory: '/storage/wt/app', repositoryRoot: '/repo', baseCommit: 'base', state: 'active' as const };
  const image = { id: 'img1', name: 'screen.png', kind: 'image' as const, path: '/storage/attachments/c1/img1-screen.png', size: 10, mediaType: 'image/png' };
  const notes = { id: 'txt1', name: 'notes.md', kind: 'text' as const, path: '/storage/attachments/c1/txt1-notes.md', size: 10 };
  const mention = { id: 'ws1', name: 'math.js', kind: 'text' as const, path: '/repo/app/math.js', size: 10, workspaceRelative: 'math.js' };

  it('answers a chat message with Claude and has Codex check it, without a revision when Codex agrees', async () => {
    const { claude, codex, orchestrator } = setup();
    codex.respond = () => verdict('pass');
    const run = await orchestrator.start('chat', 'Why does average([]) throw?', '/repo/app', false);
    expect(run.status).toBe('completed');
    expect(run.stages.map((stage) => stage.id)).toEqual(['claude-answer', 'codex-check']);
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]?.prompt).toContain("## The user's latest message");
    expect(codex.calls[0]?.prompt).toContain('Required verdict');
  });

  it('adds one read-only Claude revision when Codex finds a problem, and never checks again', async () => {
    const { claude, codex, orchestrator } = setup();
    codex.respond = () => verdict('fail');
    const run = await orchestrator.start('chat', 'Why does average([]) throw?', '/repo/app', false);
    expect(run.status).toBe('completed');
    expect(run.stages.map((stage) => stage.id)).toEqual(['claude-answer', 'codex-check', 'claude-revise']);
    expect(run.stages[2]).toMatchObject({ permission: 'read-only', status: 'completed' });
    expect(claude.calls[1]?.prompt).toContain('1 high');
    expect(claude.calls[1]?.prompt).toContain('Off-by-one in pager');
    expect(codex.calls).toHaveLength(1);
  });

  it('treats a check without a verdict as failed, so Claude revises', async () => {
    const { orchestrator } = setup();
    const run = await orchestrator.start('chat', 'Explain the pager.', '/repo/app', false);
    expect(run.stages.at(-1)?.id).toBe('claude-revise');
  });

  it('gives each agent the chosen model and effort, and the attachments in the form it can read', async () => {
    const { claude, codex, orchestrator } = setup();
    codex.respond = () => verdict('pass');
    const run = await orchestrator.start('chat', 'What is in the screenshot?', '/repo/app', false, {
      conversationId: 'c1',
      attachments: [image, notes, mention],
      agentOptions: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6-sol', effort: '--bad' } },
    });
    expect(run.conversationId).toBe('c1');
    expect(claude.calls[0]?.options).toEqual({ model: 'opus', effort: 'high' });
    // An invalid stored effort is dropped rather than passed on.
    expect(codex.calls[0]?.options).toEqual({ model: 'gpt-6-sol' });
    expect(codex.calls[0]?.images).toEqual([image.path]);
    // Stored copies are readable; mentioned workspace files are read in place.
    expect(claude.calls[0]?.readableDirectories).toEqual(['/storage/attachments/c1']);
    expect(claude.calls[0]?.prompt).toContain('screen.png (image, 10 B)');
    expect(claude.calls[0]?.prompt).toContain('Workspace file: math.js');
    expect(claude.calls[0]?.prompt).toContain('Open them with your Read tool');
    expect(codex.calls[0]?.prompt).toContain('Image attachments are attached to this prompt');
  });

  it("continues the previous turn's Claude session without repeating the conversation, while Codex starts fresh with it", async () => {
    const { claude, codex, orchestrator } = setup({ options: { resumeSessions: ['claude'] }, claudeSession: 'ses_turn2' });
    codex.respond = () => verdict('pass');
    const history = '### User (chat)\nWhat does average do?\n\n### Answer (Codex agreed)\nIt averages numbers.';
    const run = await orchestrator.start('chat', 'And for an empty list?', '/repo/app', false, {
      history,
      continueSessions: { claude: 'ses_turn1', codex: 'thr_1' },
    });
    expect(run.stages[0]?.result?.resumedSession).toBe(true);
    expect(claude.calls[0]?.resume?.sessionId).toBe('ses_turn1');
    expect(claude.calls[0]?.resume?.prompt).toContain("already in this session's history");
    expect(claude.calls[0]?.resume?.prompt).not.toContain('It averages numbers.');
    // The full prompt, used if the session is gone, still carries the history.
    expect(claude.calls[0]?.prompt).toContain('It averages numbers.');
    expect(codex.calls[0]?.resume).toBeUndefined();
    expect(codex.calls[0]?.prompt).toContain('It averages numbers.');
  });

  it('requires consent for edits, then edits in a worktree and runs fix rounds after a failed review', async () => {
    const created: string[] = [];
    const { claude, codex, orchestrator } = setup({
      options: { isolation: 'worktree', maxFixRounds: 1 },
      dependencies: {
        prepareWorktree: async (_workspace, runId) => {
          created.push(runId);
          return { info: { ...info }, warnings: [] };
        },
      },
    });
    await expect(orchestrator.start('edit', 'Return 0 for an empty list.', '/repo/app', false)).rejects.toThrow('explicit workspace-write consent');

    let reviews = 0;
    codex.respond = () => verdict((reviews += 1) === 1 ? 'fail' : 'pass');
    const run = await orchestrator.start('edit', 'Return 0 for an empty list.', '/repo/app', true);
    expect(run.status).toBe('completed');
    expect(run.stages.map((stage) => stage.id)).toEqual(['claude-edit', 'codex-change-review', 'claude-fix-round-1', 'codex-reverification-round-1']);
    expect(run.worktree?.path).toBe('/storage/wt');
    expect(created).toHaveLength(1);
    expect([...claude.calls, ...codex.calls].every((request) => request.cwd === '/storage/wt/app')).toBe(true);
  });

  it("keeps editing the conversation's worktree on the next turn, or makes a new one if it is gone", async () => {
    const created: string[] = [];
    let exists = true;
    const { orchestrator } = setup({
      options: { isolation: 'worktree', maxFixRounds: 0 },
      dependencies: {
        prepareWorktree: async (_workspace, runId) => {
          created.push(runId);
          return { info: { ...info, path: `/storage/${runId}` }, warnings: [] };
        },
        worktreeExists: async () => exists,
      },
    });
    const reused = await orchestrator.start('edit', 'Also handle NaN.', '/repo/app', true, { worktree: { ...info, setupCompleted: true } });
    expect(reused.worktree?.path).toBe('/storage/wt');
    expect(created).toHaveLength(0);

    exists = false;
    const fresh = await orchestrator.start('edit', 'Also handle NaN.', '/repo/app', true, { worktree: { ...info } });
    expect(created).toEqual([fresh.id]);
    expect(fresh.worktree?.path).toBe(`/storage/${fresh.id}`);
  });

  it("keeps each stage's steps with their results, dropping the earliest beyond the limit", async () => {
    const { claude, orchestrator } = setup();
    claude.respond = (request) => {
      if (stageOf(request) !== 'claude-answer') return 'revised';
      request.onEvent({ agent: 'claude', category: 'tool', message: '', activity: { kind: 'command', tool: 'Bash', title: 'Run tests', input: 'npm test', id: 'call-1' } });
      request.onEvent({ agent: 'claude', category: 'tool', message: '', activityResult: { id: 'call-1', output: '1 failing', failed: true } });
      for (let index = 0; index < STAGE_ACTIVITY_LIMIT; index += 1) {
        request.onEvent({ agent: 'claude', category: 'tool', message: '', activity: { kind: 'read', tool: 'Read', title: `file-${index}.js` } });
      }
      return 'answer';
    };
    const run = await orchestrator.start('chat', 'Do the tests pass?', '/repo/app', false);
    const steps = run.stages[0]?.activities ?? [];
    expect(steps).toHaveLength(STAGE_ACTIVITY_LIMIT);
    expect(steps[0]?.title).toBe('file-0.js');
    expect(steps.at(-1)?.title).toBe(`file-${STAGE_ACTIVITY_LIMIT - 1}.js`);

    const { claude: other, orchestrator: second } = setup();
    other.respond = (request) => {
      request.onEvent({ agent: 'claude', category: 'tool', message: '', activity: { kind: 'command', tool: 'Bash', title: 'Run tests', input: 'npm test', id: 'call-1' } });
      request.onEvent({ agent: 'claude', category: 'tool', message: '', activityResult: { id: 'call-1', output: '1 failing', failed: true } });
      return 'answer';
    };
    const linked = await second.start('chat', 'Do the tests pass?', '/repo/app', false);
    expect(linked.stages[0]?.activities).toEqual([{ kind: 'command', tool: 'Bash', title: 'Run tests', input: 'npm test', id: 'call-1', output: '1 failing', failed: true }]);
  });

  it('keeps the answer when the check finds only minor notes, saving a revision', async () => {
    const { claude, codex, orchestrator } = setup();
    codex.respond = () => 'Small nit.\n```verdict\n{"verdict":"fail","findings":[{"severity":"low","title":"Name the helper more clearly"}]}\n```';
    const logs: string[] = [];
    orchestrator.onEvent((event) => {
      if (event.type === 'log' && event.message) logs.push(event.message);
    });
    const run = await orchestrator.start('chat', 'Explain the pager.', '/repo/app', false);
    expect(run.stages.map((stage) => stage.id)).toEqual(['claude-answer', 'codex-check']);
    expect(claude.calls).toHaveLength(1);
    expect(logs.some((line) => line.includes('only minor notes'))).toBe(true);
    // A material finding still gets the revision.
    codex.respond = () => 'Wrong.\n```verdict\n{"verdict":"fail","findings":[{"severity":"low","title":"Nit"},{"severity":"medium","title":"Misses the empty case"}]}\n```';
    const revised = await orchestrator.start('chat', 'Explain the pager.', '/repo/app', false);
    expect(revised.stages.at(-1)?.id).toBe('claude-revise');
  });

  it('researches with the web, has Codex verify the sources, and thinks hard unless told otherwise', async () => {
    const { claude, codex, orchestrator } = setup();
    codex.respond = () => verdict('fail');
    const run = await orchestrator.start('research', 'What are the open problems in sparse attention?', '/repo/app', false, {
      agentOptions: { codex: { effort: 'low' } },
    });
    expect(run.stages.map((stage) => stage.id)).toEqual(['claude-research', 'codex-source-check', 'claude-revise']);
    expect(run.stages[2]?.title).toBe('Claude revises the research');
    expect([...claude.calls, ...codex.calls].every((request) => request.web === true)).toBe(true);
    expect(claude.calls[0]?.options).toEqual({ effort: 'high' });
    // An effort the user chose is kept.
    expect(codex.calls[0]?.options).toEqual({ effort: 'low' });
    expect(claude.calls[0]?.prompt).toContain('never cite from a search snippet or from memory');
    expect(codex.calls[0]?.prompt).toContain('Open each cited source');
  });

  it('gives chat stages the web only when the user turns it on', async () => {
    const { claude, orchestrator } = setup();
    await orchestrator.start('chat', 'What changed in Node 24?', '/repo/app', false);
    expect(claude.calls[0]?.web).toBeUndefined();
    await orchestrator.start('chat', 'What changed in Node 24?', '/repo/app', false, { web: true });
    expect(claude.calls.at(-1)?.web).toBe(true);
  });

  it('tags agent events with their stage', async () => {
    const { orchestrator } = setup();
    const stages: (string | undefined)[] = [];
    orchestrator.onEvent((event) => {
      if (event.type === 'agent-event') stages.push(event.stageId);
    });
    await orchestrator.start('chat', 'Why is the build slow?', '/repo/app', false);
    expect(stages).toEqual(['claude-answer', 'codex-check', 'claude-revise']);
  });
});
