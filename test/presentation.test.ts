import { describe, expect, it } from 'vitest';

import type { RunRecord, StageRecord } from '../src/core/types.js';
import { totalUsageByAgent } from '../src/core/usage.js';
import {
  applyDetail,
  changeDescription,
  consentDetail,
  escapeMarkdown,
  relativeTime,
  runContextValue,
  runDescription,
  runIcon,
  runLabel,
  runTooltip,
  stageDescription,
  stageIcon,
  statusBarText,
} from '../src/ui/presentation.js';

function stage(overrides: Partial<StageRecord> = {}): StageRecord {
  return {
    id: 'codex-final-verification',
    title: 'Codex performs final verification',
    agent: 'codex',
    assignedAgent: 'codex',
    permission: 'read-only',
    purpose: 'Final gate',
    instructions: 'Verify.',
    status: 'pending',
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    id: 'run-1',
    kind: 'implementation',
    objective: 'Add paging\nto the   results list',
    workspacePath: '/repo',
    status: 'completed',
    allowWrites: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stages: [stage({ status: 'completed' }), stage({ id: 'b', status: 'running' }), stage({ id: 'c' })],
    usage: totalUsageByAgent(),
    ...overrides,
  };
}

const worktree = { path: '/s/wt', workingDirectory: '/s/wt', repositoryRoot: '/repo', baseCommit: 'abc', state: 'active' as const };
const now = Date.parse('2026-01-01T02:00:00.000Z');

describe('run presentation', () => {
  it('labels a run by the first line of its objective', () => {
    expect(runLabel(run())).toBe('Add paging to the results list');
    expect(runLabel(run({ objective: 'x'.repeat(200) }))).toHaveLength(80);
  });

  it('describes progress while active and the outcome afterwards', () => {
    expect(runDescription(run({ status: 'running' }), now, true)).toBe('stage 2/3 · implementation · 2 h ago');
    expect(runDescription(run({ status: 'completed-with-findings' }), now, false)).toBe(
      'completed with unresolved findings · implementation · 2 h ago',
    );
    expect(relativeTime('2026-01-01T01:59:30.000Z', now)).toBe('just now');
    expect(relativeTime('2025-12-29T02:00:00.000Z', now)).toBe('3 d ago');
  });

  it('exposes only the actions that apply, as flags for menu "when" clauses', () => {
    expect(runContextValue(run({ status: 'running' }), true)).toBe('run active');
    expect(runContextValue(run({ status: 'awaiting-approval' }), true)).toBe('run active awaitingApproval');
    expect(runContextValue(run({ status: 'failed', worktree }), false)).toBe('run resumable worktree');
    expect(runContextValue(run({ status: 'failed', worktree: { ...worktree, state: 'applied' } }), false)).toBe('run');
    expect(runContextValue(run(), false)).toBe('run');
  });

  it('chooses icons from the status, and warns when a completed review did not pass', () => {
    expect(runIcon(run(), false).id).toBe('pass');
    expect(runIcon(run({ status: 'completed-with-findings' }), false).id).toBe('warning');
    expect(runIcon(run({ status: 'running' }), true).id).toBe('sync~spin');
    expect(runIcon(run({ status: 'running' }), false).id).toBe('question');
    expect(stageIcon(stage({ status: 'completed', verdict: { outcome: 'pass', findings: [] } })).id).toBe('pass');
    expect(stageIcon(stage({ status: 'completed', verdict: { outcome: 'fail', findings: [] } })).id).toBe('warning');
    expect(stageIcon(stage({ status: 'completed', checks: [{ command: ['npm'], exitCode: 1, durationMs: 1, output: '' }] })).id).toBe('warning');
  });

  it('summarizes a stage\'s agent, permission, verdict, and checks', () => {
    const value = stage({
      agent: 'claude',
      assignedAgent: 'codex',
      permission: 'workspace-write',
      verdict: { outcome: 'fail', findings: [{ severity: 'high', title: 'x' }] },
      checks: [{ command: ['npm', 'test'], exitCode: 0, durationMs: 1, output: '' }],
    });
    expect(stageDescription(value)).toBe('codex (fallback) · edits files · fail: 1 high · checks passed');
  });

  it('escapes agent and repository text in tooltips so it shows literally', () => {
    expect(escapeMarkdown('[link](command:evil) *b*')).toBe('\\[link\\]\\(command:evil\\) \\*b\\*');
    const tooltip = runTooltip(run({ error: '[click](command:workbench.action.terminal.new)', warnings: ['<img src=x>'] }));
    expect(tooltip).not.toContain('[click](command:');
    expect(tooltip).toContain('\\<img src=x\\>');
  });

  it('asks for attention in the status bar only while a plan waits', () => {
    expect(statusBarText(run({ status: 'awaiting-approval' })).attention).toBe(true);
    const running = statusBarText(run({ status: 'running' }));
    expect(running).toMatchObject({ text: '$(sync~spin) Dual Agent 2/3', attention: false });
  });
});

describe('consent and apply prompts', () => {
  const settings = { isolation: 'worktree' as const, approvePlan: true, setupCommands: [], verificationCommands: [], maxFixRounds: 1 };

  it('states where agents edit files and what the user will be asked', () => {
    const detail = consentDetail(settings, 'app', false);
    expect(detail).toContain('isolated Git worktree of app');
    expect(detail).toContain('You approve the plan');
    expect(detail).toContain('up to 1 fix round');
    expect(detail).not.toContain('outside any agent sandbox');
    expect(consentDetail({ ...settings, isolation: 'none' }, 'app', true)).toContain('edit files in app directly');
    expect(consentDetail(settings, 'app', true)).not.toContain('You approve the plan');
  });

  it('says that Agent mode works in the folder itself, asks before commands, and can undo file changes only', () => {
    const detail = consentDetail(settings, 'app', false, 'agent');
    expect(detail).toContain('works in app itself');
    expect(detail).toContain('Claude asks you before each command');
    expect(detail).toContain('can reach the network');
    expect(detail).toContain('cannot be undone');
    expect(detail).not.toContain('isolated Git worktree');
    expect(detail).not.toContain('fix round');
    expect(consentDetail({ ...settings, codex: { codexAgentNetwork: false } }, 'app', false, 'agent')).toContain('cannot reach the network');
    expect(consentDetail(settings, 'app', false, 'edit')).toContain('edited directly after a snapshot');
  });

  it('warns that configured commands run repository code outside every sandbox', () => {
    const detail = consentDetail({ ...settings, setupCommands: [['npm', 'ci']], verificationCommands: [['npm', 'test']] }, 'app', false);
    expect(detail).toContain('runs in the worktree: npm ci');
    expect(detail).toContain('After each editing stage, the extension runs: npm test');
    expect(detail).toContain('outside any agent sandbox');
  });

  it('lists changes and flags runs that did not pass, and symbolic links', () => {
    const changes = [
      { path: 'src/a.ts', status: 'modified' as const, symlink: false },
      { path: 'link', status: 'added' as const, symlink: true },
    ];
    const detail = applyDetail(run({ status: 'completed-with-findings' }), changes);
    expect(detail).toContain('M  src/a.ts');
    expect(detail).toContain('A  link');
    expect(detail).toContain('did not pass the final gate');
    expect(detail).toContain('symbolic links');
    expect(applyDetail(run(), changes.slice(0, 1))).not.toContain('did not pass');
    expect(changeDescription(changes[0]!)).toBe('src · M');
  });
});
