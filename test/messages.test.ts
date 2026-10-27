import { describe, expect, it } from 'vitest';

import type { RunRecord } from '../src/core/types.js';
import { totalUsageByAgent } from '../src/core/usage.js';
import { agentEventView, OBJECTIVE_LIMIT, parseDashboardMessage, runView } from '../src/ui/messages.js';

describe('dashboard messages', () => {
  it('accepts well-formed messages', () => {
    expect(parseDashboardMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseDashboardMessage({ type: 'start', kind: 'brainstorming', objective: 'Plan it.', allowWrites: false })).toEqual({
      type: 'start',
      kind: 'brainstorming',
      objective: 'Plan it.',
      allowWrites: false,
    });
  });

  it.each([
    null,
    'start',
    { type: 'delete-everything' },
    { type: 'start', kind: 'unknown', objective: 'x', allowWrites: false },
    { type: 'start', kind: 'implementation', objective: 42, allowWrites: true },
    { type: 'start', kind: 'implementation', objective: 'x', allowWrites: 'yes' },
    { type: 'start', kind: 'implementation', objective: 'x'.repeat(OBJECTIVE_LIMIT + 1), allowWrites: true },
  ])('drops malformed message %#', (message) => {
    expect(parseDashboardMessage(message)).toBeUndefined();
  });

  it('sends the webview only what it renders', () => {
    const run: RunRecord = {
      schemaVersion: 1,
      id: 'run-1',
      kind: 'implementation',
      objective: 'private objective',
      workspacePath: '/workspace',
      status: 'failed',
      allowWrites: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      stages: [
        {
          id: 'plan',
          title: 'Plan',
          agent: 'claude',
          assignedAgent: 'codex',
          permission: 'read-only',
          purpose: 'plan',
          instructions: 'plan',
          status: 'completed',
          fallbackReason: 'quota',
          result: { text: 'stage output with file contents', usage: totalUsageByAgent().claude, rawEventCount: 1 },
        },
      ],
      usage: totalUsageByAgent(),
      error: 'e'.repeat(5_000),
    };
    const view = runView(run);
    expect(JSON.stringify(view)).not.toContain('stage output');
    expect(JSON.stringify(view)).not.toContain('private objective');
    expect(view.stages[0]).toEqual({ title: 'Plan', status: 'completed', assignedAgent: 'codex', permission: 'read-only', fallback: true });
    expect(view.error?.length).toBeLessThan(2_100);
    expect(view.warnings).toEqual([]);
  });

  it('drops raw provider events from activity messages', () => {
    const view = agentEventView({ agent: 'claude', category: 'tool', message: 'Read file', raw: { content: 'secret' } });
    expect(view).toEqual({ agent: 'claude', category: 'tool', message: 'Read file' });
  });
});
