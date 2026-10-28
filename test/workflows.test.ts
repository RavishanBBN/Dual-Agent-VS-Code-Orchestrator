import { describe, expect, it } from 'vitest';

import { fixRoundStages, getWorkflow } from '../src/core/workflows.js';

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
    expect(stages.filter((stage) => stage.permission === 'workspace-write').map((stage) => stage.id)).toEqual([
      'claude-implement',
      'claude-adjudicate-fix',
    ]);
  });

  it('gates on the final verification and keeps the final summary read-only, so nothing changes after the gate', () => {
    const stages = getWorkflow('implementation');
    expect(stages.filter((stage) => stage.gate).map((stage) => stage.id)).toEqual(['codex-final-verification']);
    expect(stages.filter((stage) => stage.review).every((stage) => stage.agent === 'codex')).toBe(true);
    expect(stages.at(-1)).toMatchObject({ id: 'claude-finalize', permission: 'read-only' });
  });

  it('asks for approval before the first stage that edits files', () => {
    const stages = getWorkflow('implementation');
    const firstWrite = stages.find((stage) => stage.permission === 'workspace-write');
    expect(stages.filter((stage) => stage.requiresApproval)).toEqual([firstWrite]);
  });

  it('keeps brainstorming read-only and reciprocal, with verdicts but no gate', () => {
    const stages = getWorkflow('brainstorming');
    expect(stages).toHaveLength(5);
    expect(stages.every((stage) => stage.permission === 'read-only')).toBe(true);
    expect(stages.map((stage) => stage.agent)).toEqual(['claude', 'codex', 'claude', 'codex', 'claude']);
    expect(stages.some((stage) => stage.gate || stage.requiresApproval)).toBe(false);
  });

  it('builds a fix round as a Claude fix followed by a fresh gated Codex verification', () => {
    const [fix, verify] = fixRoundStages(2, 'the reviewer reported fail: 1 high');
    expect(fix).toMatchObject({ id: 'claude-fix-round-2', agent: 'claude', permission: 'workspace-write', round: 2 });
    expect(fix?.instructions).toContain('1 high');
    expect(verify).toMatchObject({ id: 'codex-reverification-round-2', agent: 'codex', permission: 'read-only', gate: true, review: true });
  });

  it('returns copies so callers cannot mutate templates', () => {
    const first = getWorkflow('brainstorming');
    first[0]!.title = 'changed';
    expect(getWorkflow('brainstorming')[0]!.title).not.toBe('changed');
  });
});
