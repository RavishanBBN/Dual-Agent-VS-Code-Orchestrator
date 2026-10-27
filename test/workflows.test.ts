import { describe, expect, it } from 'vitest';

import { getWorkflow } from '../src/core/workflows.js';

describe('workflow definitions', () => {
  it('makes Claude the implementation lead and Codex the independent reviewer', () => {
    const stages = getWorkflow('implementation');
    expect(stages).toHaveLength(7);
    expect(stages.map((stage) => stage.agent)).toEqual([
      'claude',
      'codex',
      'claude',
      'codex',
      'claude',
      'codex',
      'claude',
    ]);
    expect(stages.filter((stage) => stage.permission === 'workspace-write').map((stage) => stage.agent)).toEqual([
      'claude',
      'claude',
      'claude',
    ]);
  });

  it('keeps brainstorming read-only and reciprocal', () => {
    const stages = getWorkflow('brainstorming');
    expect(stages).toHaveLength(5);
    expect(stages.every((stage) => stage.permission === 'read-only')).toBe(true);
    expect(stages.map((stage) => stage.agent)).toEqual(['claude', 'codex', 'claude', 'codex', 'claude']);
  });

  it('returns copies so callers cannot mutate templates', () => {
    const first = getWorkflow('brainstorming');
    first[0]!.title = 'changed';
    expect(getWorkflow('brainstorming')[0]!.title).not.toBe('changed');
  });
});
