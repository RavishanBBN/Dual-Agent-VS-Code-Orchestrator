import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fence, renderRunReport, renderStageDocument } from '../src/core/report.js';
import { FileRunStore } from '../src/core/store.js';
import type { RunRecord } from '../src/core/types.js';
import { totalUsageByAgent } from '../src/core/usage.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function run(id: string): RunRecord {
  return {
    schemaVersion: 1,
    id,
    kind: 'brainstorming',
    objective: 'Design it.',
    workspacePath: '/workspace',
    status: 'completed',
    allowWrites: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    stages: [],
    usage: totalUsageByAgent(),
  };
}

describe('FileRunStore', () => {
  it('persists, replaces, orders, and caps run history', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dual-agent-store-'));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory, 2);
    await store.save(run('one'));
    await store.save(run('two'));
    await store.save(run('three'));
    expect((await store.list()).map((item) => item.id)).toEqual(['three', 'two']);
    const replacement = run('two');
    replacement.objective = 'Updated.';
    await store.save(replacement);
    expect(await store.latest()).toMatchObject({ id: 'two', objective: 'Updated.' });
    expect(JSON.parse(await readFile(path.join(directory, 'runs.json'), 'utf8'))).toMatchObject({ schemaVersion: 1 });
  });

  it('deletes the whole history, including copies set aside, and leaves other files alone', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dual-agent-store-'));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory, 5);
    await store.save(run('one'));
    await writeFile(path.join(directory, 'runs.json.unreadable-1'), '{');
    await writeFile(path.join(directory, 'other.json'), '{}');
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect(await readdir(directory)).toEqual(['other.json']);
    await store.save(run('two'));
    expect((await store.list()).map((item) => item.id)).toEqual(['two']);
  });
});

describe('run report', () => {
  it('renders objective, status, and usage caveat', () => {
    const report = renderRunReport(run('report'));
    expect(report).toContain('# Dual Agent Run report');
    expect(report).toContain('Design it.');
    expect(report).toContain('not authoritative subscription balances');
  });

  it('renders completed stages, fallback provenance, and run errors', () => {
    const value = run('detailed');
    value.status = 'failed';
    value.error = 'verification failed';
    value.stages = [
      {
        id: 'review',
        title: 'Review',
        agent: 'codex',
        assignedAgent: 'claude',
        permission: 'read-only',
        purpose: 'review',
        instructions: 'review',
        status: 'completed',
        fallbackReason: 'quota reached',
        result: {
          text: 'Finding recorded.',
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
          rawEventCount: 1,
        },
      },
    ];
    const report = renderRunReport(value);
    expect(report).toContain('Fallback reason: quota reached');
    expect(report).toContain('Finding recorded.');
    expect(report).toContain('verification failed');
  });
});

describe('FileRunStore recovery', () => {
  it('sets an unreadable history aside instead of failing every save', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dual-agent-store-'));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, 'runs.json'), '{ not json', 'utf8');
    const store = new FileRunStore(directory, 5);

    expect(await store.list()).toEqual([]);
    await store.save(run('after-corruption'));

    expect((await store.list()).map((item) => item.id)).toEqual(['after-corruption']);
    expect((await readdir(directory)).some((name) => name.startsWith('runs.json.unreadable-'))).toBe(true);
  });

  it('serializes concurrent saves so no run is lost', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dual-agent-store-'));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory, 50);
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.save(run(`run-${index}`))));
    expect(await store.list()).toHaveLength(10);
  });
});

describe('run report warnings', () => {
  it('lists run warnings', () => {
    const value = run('warned');
    value.warnings = ['Git snapshot unavailable.'];
    expect(renderRunReport(value)).toContain('## Warnings\n\n- Git snapshot unavailable.');
  });
});

const worktree = { path: '/storage/wt', workingDirectory: '/storage/wt', repositoryRoot: '/repo', baseCommit: 'abc' };

describe('isolated runs in history', () => {
  it('never prunes a run whose worktree changes still wait for review', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dual-agent-store-'));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory, 5);
    await store.save({ ...run('pending-review'), worktree: { ...worktree, state: 'active' } });
    await store.save({ ...run('applied'), worktree: { ...worktree, state: 'applied' } });
    for (let index = 0; index < 6; index += 1) await store.save(run(`later-${index}`));

    const ids = (await store.list()).map((item) => item.id);
    expect(ids).toContain('pending-review');
    expect(ids).not.toContain('applied');
    expect(ids).toHaveLength(6);
  });

  it('reports isolation, approval, verdicts, checks, and unresolved findings', () => {
    const value: RunRecord = {
      ...run('gated'),
      kind: 'implementation',
      status: 'completed-with-findings',
      isolation: 'worktree',
      worktree: { ...worktree, state: 'active' },
      approval: { decidedAt: '2026-01-01T00:00:30.000Z', notes: 'Keep the API.' },
      unresolved: 'the reviewer reported fail: 1 high',
      stages: [
        {
          id: 'codex-final-verification',
          title: 'Final verification',
          agent: 'codex',
          assignedAgent: 'codex',
          permission: 'read-only',
          purpose: 'gate',
          instructions: 'verify',
          status: 'completed',
          verdict: { outcome: 'fail', findings: [{ severity: 'high', title: 'Off by one', location: 'a.ts:3' }] },
          checks: [{ command: ['npm', 'test'], exitCode: 0, durationMs: 900, output: 'ok' }],
        },
      ],
    };
    const report = renderRunReport(value);
    expect(report).toContain('Status: **completed with unresolved findings**');
    expect(report).toContain('Isolation: isolated worktree at `/storage/wt` (changes waiting to be applied or discarded)');
    expect(report).toContain('## Guidance given at plan approval\n\nKeep the API.');
    expect(report).toContain('## Unresolved at completion\n\nthe reviewer reported fail: 1 high');
    expect(report).toContain('- Verdict: fail: 1 high');
    expect(report).toContain('  - high: Off by one (a.ts:3)');
    expect(report).toContain('- `npm test`: passed in 0.9 s');
  });

  it('renders a stage document whose fence agent output cannot close', () => {
    const value = run('document');
    const stage = {
      id: 'claude-implement',
      title: 'Implement',
      agent: 'claude' as const,
      assignedAgent: 'claude' as const,
      permission: 'workspace-write' as const,
      purpose: 'implement',
      instructions: 'implement',
      status: 'completed' as const,
      checks: [{ command: ['npm', 'test'], exitCode: 1, durationMs: 100, output: 'before\n```\nafter' }],
      result: { text: 'Done.', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, rawEventCount: 1 },
    };
    value.stages = [stage];
    const document = renderStageDocument(value, stage);
    expect(document).toContain('# 1. Implement');
    expect(document).toContain('````text\nbefore\n```\nafter\n````');
    expect(document).toContain('## Output\n\nDone.');
    expect(fence('a ```` b')).toBe('`````\na ```` b\n`````');
  });
});
