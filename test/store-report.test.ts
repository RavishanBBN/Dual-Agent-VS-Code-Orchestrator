import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderRunReport } from '../src/core/report.js';
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
