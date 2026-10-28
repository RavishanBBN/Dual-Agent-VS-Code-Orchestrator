import { describe, expect, it } from 'vitest';

import { worktreeConflict } from '../src/core/orchestrator.js';
import { fixRoundStages, getWorkflow, reviseStage } from '../src/core/workflows.js';

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

describe('choosing the agents and the new modes', () => {
  it('swaps the roles when Codex leads, keeping stage IDs, and exchanges the names in the instructions', () => {
    const swapped = getWorkflow('chat', 'codex-claude');
    expect(swapped.map((stage) => [stage.id, stage.agent])).toEqual([
      ['claude-answer', 'codex'],
      ['codex-check', 'claude'],
    ]);
    expect(swapped[1]?.title).toMatch(/^Claude/);
    // Claude now checks Codex's answer.
    expect(swapped[1]?.instructions).toContain("Codex's answer");
    expect(swapped[1]?.instructions).not.toContain("Claude's answer");
  });

  it('gives one agent alone every stage, with no check that would need the other', () => {
    for (const kind of ['chat', 'research', 'agent', 'edit', 'tdd', 'compare', 'brainstorming', 'implementation'] as const) {
      const stages = getWorkflow(kind, 'codex');
      expect(stages.length, kind).toBeGreaterThan(0);
      expect(stages.every((stage) => stage.agent === 'codex'), kind).toBe(true);
      expect(stages.some((stage) => stage.review), kind).toBe(false);
    }
  });

  it('answers twice independently in Compare, then merges', () => {
    const stages = getWorkflow('compare');
    expect(stages.map((stage) => stage.id)).toEqual(['claude-answer', 'codex-answer', 'claude-merge']);
    expect(stages[1]?.blind).toBe(true);
    expect(stages.every((stage) => stage.permission === 'read-only')).toBe(true);
  });

  it('writes failing tests first in Test first, then implements, then gates on a review', () => {
    const stages = getWorkflow('tdd');
    expect(stages.map((stage) => [stage.id, stage.agent, stage.permission])).toEqual([
      ['codex-tests', 'codex', 'workspace-write'],
      ['claude-tdd-implement', 'claude', 'workspace-write'],
      ['codex-tdd-review', 'codex', 'read-only'],
    ]);
    expect(stages[0]?.expectFailingChecks).toBe(true);
    expect(stages[2]).toMatchObject({ review: true, gate: true });
  });

  it('keeps Agent mode hands-on after a failed check, while the check itself changes nothing', () => {
    const [work, check] = getWorkflow('agent');
    expect(work?.permission).toBe('agent');
    expect(check).toMatchObject({ permission: 'read-only', review: true, onFail: 'revise' });
    expect(reviseStage('half done', 'agent').permission).toBe('agent');
    expect(reviseStage('wrong').permission).toBe('read-only');
  });
});

describe('changes waiting in a conversation', () => {
  const copy = { path: '/wt', workingDirectory: '/wt', repositoryRoot: '/repo', baseCommit: 'a'.repeat(40), state: 'active' as const };
  const agentSnapshot = { ...copy, path: '/repo', gitDir: '/storage/direct-1.git', snapshotFor: 'agent' as const };
  const folderSnapshot = { ...agentSnapshot, snapshotFor: 'folder' as const };

  it('keeps Agent mode out of an isolated copy, and the editing modes out of Agent mode\'s direct changes', () => {
    expect(worktreeConflict('agent', copy)).toContain('Apply or discard them first');
    expect(worktreeConflict('edit', agentSnapshot)).toContain('Keep or undo them first');
    // A folder without Git has only direct edits, so every mode continues the same snapshot.
    expect(worktreeConflict('edit', folderSnapshot)).toBeUndefined();
    expect(worktreeConflict('agent', folderSnapshot)).toBeUndefined();
    expect(worktreeConflict('edit', copy)).toBeUndefined();
    expect(worktreeConflict('agent', { ...copy, state: 'applied' })).toBeUndefined();
  });
});
