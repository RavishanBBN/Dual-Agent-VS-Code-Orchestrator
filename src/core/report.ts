import { describeCheck } from './context.js';
import type { CheckResult, RunRecord, RunStatus, StageRecord, TokenUsage } from './types.js';
import { summarizeVerdict } from './verdict.js';

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'queued',
  running: 'running',
  'awaiting-approval': 'awaiting plan approval',
  completed: 'completed',
  'completed-with-findings': 'completed with unresolved findings',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function statusLabel(status: RunStatus): string {
  return STATUS_LABELS[status];
}

function usageLine(usage: TokenUsage): string {
  const cost = usage.estimatedCostUsd !== undefined ? `; reported cost $${usage.estimatedCostUsd.toFixed(4)}` : '';
  return `${usage.inputTokens} input, ${usage.cachedInputTokens} cached input, ${usage.outputTokens} output${cost}`;
}

/** Wraps text in a code fence longer than any backtick run inside it, so agent output cannot close it. */
export function fence(content: string, language = ''): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const marker = '`'.repeat(longest + 1);
  return `${marker}${language}\n${content}\n${marker}`;
}

function checkLines(checks: CheckResult[], withOutput: boolean): string[] {
  return checks.flatMap((check) => [
    `- \`${check.command.join(' ')}\`: ${describeCheck(check)}`,
    ...(withOutput && check.output.trim() ? ['', fence(check.output.trimEnd(), 'text'), ''] : []),
  ]);
}

function isolationLine(run: RunRecord): string {
  if (!run.worktree) return run.isolation === 'worktree' ? 'isolated worktree (not created)' : 'edits the workspace directly';
  const state = { active: 'changes waiting to be applied or discarded', applied: 'changes applied', discarded: 'changes discarded' };
  return `isolated worktree at \`${run.worktree.path}\` (${state[run.worktree.state]})`;
}

function stageMetadata(stage: StageRecord): string[] {
  return [
    `- Status: ${stage.status}`,
    `- Intended agent: ${stage.agent}`,
    `- Actual agent: ${stage.assignedAgent}`,
    `- Permission: ${stage.permission}`,
    ...(stage.result?.resumedSession ? ['- Session: continued from the previous stage'] : []),
    ...(stage.fallbackReason ? [`- Fallback reason: ${stage.fallbackReason}`] : []),
    ...(stage.verdict ? [`- Verdict: ${summarizeVerdict(stage.verdict)}`] : []),
    ...(stage.verdict?.findings.length
      ? stage.verdict.findings.map((item) => `  - ${item.severity}: ${item.title}${item.location ? ` (${item.location})` : ''}`)
      : []),
  ];
}

/** The document shown when a stage is opened: its metadata, checks, and full output. */
export function renderStageDocument(run: RunRecord, stage: StageRecord): string {
  const position = run.stages.indexOf(stage) + 1;
  const lines = [
    `# ${position}. ${stage.title}`,
    '',
    ...stageMetadata(stage),
    ...(stage.startedAt ? [`- Started: ${stage.startedAt}`] : []),
    ...(stage.completedAt ? [`- Finished: ${stage.completedAt}`] : []),
    '',
  ];
  if (stage.checks?.length) lines.push('## Orchestrator-run checks', '', ...checkLines(stage.checks, true), '');
  lines.push('## Output', '');
  if (stage.result) lines.push(stage.result.text);
  else if (stage.error) lines.push(`**Error:** ${stage.error}`);
  else lines.push(stage.status === 'running' ? '_This stage is running. The document updates when it finishes._' : '_No output._');
  return `${lines.join('\n')}\n`;
}

export function renderRunReport(run: RunRecord): string {
  const lines = [
    `# Dual Agent Run ${run.id}`,
    '',
    `- Status: **${statusLabel(run.status)}**`,
    `- Workflow: **${run.kind}**`,
    `- Created: ${run.createdAt}`,
    `- Updated: ${run.updatedAt}`,
    `- Workspace: \`${run.workspacePath}\``,
    `- Workspace writes authorized: ${run.allowWrites ? 'yes' : 'no'}`,
    ...(run.kind === 'implementation' || run.kind === 'edit' ? [`- Isolation: ${isolationLine(run)}`] : []),
    ...(run.attachments?.length ? [`- Attachments: ${run.attachments.map((item) => item.name).join(', ')}`] : []),
    ...(run.approval ? [`- Plan approved: ${run.approval.decidedAt}`] : []),
    ...(run.resumeCount ? [`- Resumed: ${run.resumeCount} time(s)`] : []),
    '',
    '## Objective',
    '',
    run.objective,
    '',
  ];
  if (run.approval?.notes) lines.push('## Guidance given at plan approval', '', run.approval.notes, '');
  if (run.unresolved) lines.push('## Unresolved at completion', '', run.unresolved, '');
  lines.push(
    '## Usage observed during this run',
    '',
    `- Claude: ${usageLine(run.usage.claude)}`,
    `- Codex: ${usageLine(run.usage.codex)}`,
    '',
    'These figures are event-level observations, not authoritative subscription balances. They include attempts that failed and were handed to the fallback provider.',
    '',
  );

  if (run.warnings?.length) {
    lines.push('## Warnings', '', ...run.warnings.map((warning) => `- ${warning}`), '');
  }
  if (run.setupChecks?.length) lines.push('## Worktree setup', '', ...checkLines(run.setupChecks, false), '');

  lines.push('## Stages', '');

  for (const stage of run.stages) {
    lines.push(`### ${stage.title}`, '', ...stageMetadata(stage), '');
    if (stage.checks?.length) lines.push('Orchestrator-run checks:', '', ...checkLines(stage.checks, false), '');
    lines.push(stage.result?.text ?? stage.error ?? '(no result)', '');
  }

  if (run.error) lines.push('## Run error', '', run.error, '');
  return `${lines.join('\n')}\n`;
}
