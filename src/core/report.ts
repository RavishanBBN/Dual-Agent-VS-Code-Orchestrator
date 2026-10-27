import type { RunRecord, TokenUsage } from './types.js';

function usageLine(usage: TokenUsage): string {
  const cost = usage.estimatedCostUsd !== undefined ? `; reported cost $${usage.estimatedCostUsd.toFixed(4)}` : '';
  return `${usage.inputTokens} input, ${usage.cachedInputTokens} cached input, ${usage.outputTokens} output${cost}`;
}

export function renderRunReport(run: RunRecord): string {
  const lines = [
    `# Dual Agent Run ${run.id}`,
    '',
    `- Status: **${run.status}**`,
    `- Workflow: **${run.kind}**`,
    `- Created: ${run.createdAt}`,
    `- Updated: ${run.updatedAt}`,
    `- Workspace: \`${run.workspacePath}\``,
    `- Workspace writes authorized: ${run.allowWrites ? 'yes' : 'no'}`,
    '',
    '## Objective',
    '',
    run.objective,
    '',
    '## Usage observed during this run',
    '',
    `- Claude: ${usageLine(run.usage.claude)}`,
    `- Codex: ${usageLine(run.usage.codex)}`,
    '',
    'These figures are event-level observations, not authoritative subscription balances. They include attempts that failed and were handed to the fallback provider.',
    '',
  ];

  if (run.warnings?.length) {
    lines.push('## Warnings', '', ...run.warnings.map((warning) => `- ${warning}`), '');
  }

  lines.push('## Stages', '');

  for (const stage of run.stages) {
    lines.push(
      `### ${stage.title}`,
      '',
      `- Status: ${stage.status}`,
      `- Intended agent: ${stage.agent}`,
      `- Actual agent: ${stage.assignedAgent}`,
      `- Permission: ${stage.permission}`,
      ...(stage.fallbackReason ? [`- Fallback reason: ${stage.fallbackReason}`] : []),
      '',
      stage.result?.text ?? stage.error ?? '(no result)',
      '',
    );
  }

  if (run.error) lines.push('## Run error', '', run.error, '');
  return `${lines.join('\n')}\n`;
}
