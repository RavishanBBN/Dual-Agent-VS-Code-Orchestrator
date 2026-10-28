import { describeCheck } from '../core/context.js';
import { canResume, editsFiles } from '../core/orchestrator.js';
import { statusLabel } from '../core/report.js';
import type { CheckResult, IsolationMode, RunRecord, StageRecord, TokenUsage, WorkflowKind } from '../core/types.js';
import { checksPassed } from '../core/types.js';
import { summarizeVerdict } from '../core/verdict.js';
import type { WorktreeChange } from '../core/worktree.js';

/** Maximum objective length accepted from the input box or an editor selection. */
export const OBJECTIVE_LIMIT = 20_000;
/** Maximum guidance length accepted when approving a plan. */
export const NOTES_LIMIT = 4_000;

/** A codicon id and an optional theme color id, mapped to ThemeIcon and ThemeColor by the view. */
export interface IconSpec {
  id: string;
  color?: string;
}

const PASSED: IconSpec = { id: 'pass', color: 'testing.iconPassed' };
const FAILED: IconSpec = { id: 'error', color: 'testing.iconFailed' };
const WARNING: IconSpec = { id: 'warning', color: 'list.warningForeground' };

/** Escapes text from agents or repositories so a Markdown tooltip shows it literally. */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

function oneLine(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function relativeTime(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function runLabel(run: RunRecord): string {
  return oneLine(run.objective, 80) || '(no objective)';
}

/** "3/7" for the stage currently running or waiting, counting fix-round stages. */
export function stageProgress(run: RunRecord): string | undefined {
  const index = run.stages.findIndex((stage) => stage.status === 'running' || stage.status === 'pending');
  return index === -1 ? undefined : `${index + 1}/${run.stages.length}`;
}

export function runDescription(run: RunRecord, nowMs: number, active: boolean): string {
  const progress = active ? stageProgress(run) : undefined;
  const status = active && run.status === 'running' && progress ? `stage ${progress}` : statusLabel(run.status);
  return [status, run.kind, relativeTime(run.updatedAt, nowMs)].filter(Boolean).join(' · ');
}

export function runIcon(run: RunRecord, active: boolean): IconSpec {
  if (active && run.status === 'awaiting-approval') return { id: 'debug-pause', color: 'list.warningForeground' };
  if (active) return { id: 'sync~spin' };
  switch (run.status) {
    case 'completed':
      return PASSED;
    case 'completed-with-findings':
      return WARNING;
    case 'failed':
      return FAILED;
    case 'cancelled':
      return { id: 'circle-slash' };
    default:
      // A run recorded as active by a window that is gone.
      return { id: 'question' };
  }
}

/** Space-separated flags that `view/item/context` menus match with `viewItem =~ /\bflag\b/`. */
export function runContextValue(run: RunRecord, active: boolean): string {
  const flags = ['run'];
  if (active) flags.push('active');
  if (active && run.status === 'awaiting-approval') flags.push('awaitingApproval');
  if (!active && canResume(run)) flags.push('resumable');
  if (!active && run.worktree?.state === 'active') flags.push('worktree');
  return flags.join(' ');
}

function usageText(usage: TokenUsage): string {
  const total = usage.inputTokens + usage.outputTokens;
  return total ? `${usage.inputTokens.toLocaleString('en-US')} in / ${usage.outputTokens.toLocaleString('en-US')} out` : 'none';
}

function isolationText(run: RunRecord): string {
  if (!editsFiles(run.kind)) return 'read-only';
  if (!run.worktree) return run.isolation === 'worktree' ? 'isolated worktree (not created yet)' : 'edits the workspace directly';
  if (run.worktree.state === 'active') return 'isolated worktree: changes waiting for review';
  return `isolated worktree: changes ${run.worktree.state}`;
}

/** Markdown for a run's hover. Everything that comes from the user, agents, or the repository is escaped. */
export function runTooltip(run: RunRecord): string {
  const lines = [
    `**${escapeMarkdown(runLabel(run))}**`,
    '',
    `Status: ${escapeMarkdown(statusLabel(run.status))}  `,
    `Workflow: ${run.kind}  `,
    `Files: ${escapeMarkdown(isolationText(run))}  `,
    `Workspace: ${escapeMarkdown(run.workspacePath)}  `,
    `Usage: Claude ${usageText(run.usage.claude)}; Codex ${usageText(run.usage.codex)}`,
  ];
  if (run.resumeCount) lines.push(`Resumed ${run.resumeCount} time(s)`);
  if (run.unresolved) lines.push('', `**Unresolved:** ${escapeMarkdown(run.unresolved)}`);
  if (run.error) lines.push('', `**Error:** ${escapeMarkdown(oneLine(run.error, 500))}`);
  if (run.warnings?.length) lines.push('', '**Warnings**', ...run.warnings.map((warning) => `- ${escapeMarkdown(oneLine(warning, 300))}`));
  return lines.join('\n');
}

export function stageIcon(stage: StageRecord): IconSpec {
  switch (stage.status) {
    case 'running':
      return { id: 'sync~spin' };
    case 'completed':
      if (stage.checks?.length && !checksPassed(stage.checks)) return WARNING;
      return stage.verdict && stage.verdict.outcome !== 'pass' ? WARNING : PASSED;
    case 'failed':
      return FAILED;
    case 'cancelled':
      return { id: 'circle-slash' };
    case 'skipped':
      return { id: 'debug-step-over' };
    default:
      return { id: 'circle-large-outline' };
  }
}

export function stageDescription(stage: StageRecord): string {
  const parts = [
    stage.assignedAgent === stage.agent ? stage.assignedAgent : `${stage.assignedAgent} (fallback)`,
    stage.permission === 'agent' ? 'runs commands' : stage.permission === 'workspace-write' ? 'edits files' : 'read-only',
  ];
  if (stage.verdict) parts.push(summarizeVerdict(stage.verdict));
  if (stage.checks?.length) parts.push(checksPassed(stage.checks) ? 'checks passed' : 'checks failed');
  return parts.join(' · ');
}

export function stageTooltip(stage: StageRecord): string {
  const lines = [`**${escapeMarkdown(stage.title)}**`, '', escapeMarkdown(stage.purpose)];
  if (stage.result?.resumedSession) lines.push('', 'Continued the previous Claude session.');
  if (stage.fallbackReason) lines.push('', `Fallback: ${escapeMarkdown(oneLine(stage.fallbackReason, 300))}`);
  if (stage.verdict?.findings.length) {
    lines.push('', ...stage.verdict.findings.slice(0, 10).map((item) => `- ${item.severity}: ${escapeMarkdown(item.title)}`));
  }
  if (stage.error) lines.push('', `**Error:** ${escapeMarkdown(oneLine(stage.error, 300))}`);
  lines.push('', 'Click to open the full output.');
  return lines.join('\n');
}

export function checkLabel(check: CheckResult): string {
  return check.command.join(' ');
}

export function checkIcon(check: CheckResult): IconSpec {
  return checksPassed([check]) ? PASSED : FAILED;
}

export { describeCheck };

const CHANGE_LETTERS: Record<WorktreeChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D', 'type-changed': 'T' };

export function changeDescription(change: WorktreeChange): string {
  const directory = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
  return [directory, CHANGE_LETTERS[change.status], change.symlink ? 'symbolic link' : ''].filter(Boolean).join(' · ');
}

export function changeName(change: WorktreeChange): string {
  return change.path.slice(change.path.lastIndexOf('/') + 1);
}

/** Text of the confirmation shown before applying a run's worktree changes. */
export function applyDetail(run: RunRecord, changes: readonly WorktreeChange[]): string {
  const listed = changes.slice(0, 20).map((change) => `${CHANGE_LETTERS[change.status]}  ${change.path}`);
  if (changes.length > listed.length) listed.push(`…and ${changes.length - listed.length} more`);
  const notes: string[] = [];
  if (run.status !== 'completed') {
    notes.push(`This run ended as "${statusLabel(run.status)}", so its changes did not pass the final gate.`);
  }
  if (changes.some((change) => change.symlink)) notes.push('Some changes create symbolic links; check where they point.');
  notes.push('Changes are written to the working tree only. Nothing is staged or committed, and conflicting files leave the workspace untouched.');
  return [...listed, '', ...notes].join('\n');
}

export interface ConsentSettings {
  isolation: IsolationMode;
  approvePlan: boolean;
  setupCommands: readonly (readonly string[])[];
  verificationCommands: readonly (readonly string[])[];
  maxFixRounds: number;
  /** Whether Codex's sandbox may reach the network in Agent mode. */
  codex?: { codexAgentNetwork?: boolean };
}

function commandList(commands: readonly (readonly string[])[]): string {
  return commands.map((command) => command.join(' ')).join(', ');
}

/** What Agent mode may do, which differs from the isolated editing of the other modes. */
function agentConsent(settings: ConsentSettings, folder: string): string[] {
  return [
    `The lead agent works in ${folder} itself, on your machine, as Claude Code or Codex do in a terminal: it can run commands, install packages, and edit files.`,
    'Claude asks you before each command or edit it does not judge read-only. Codex cannot ask first, so when Codex leads it works inside its own sandbox, which can write only in the folder' +
      (settings.codex?.codexAgentNetwork === false ? ' and cannot reach the network.' : ' but can reach the network to install packages.'),
    'Dual Agent takes a snapshot of the folder first, so file changes can be undone from the chat. Installed software and other effects outside the folder cannot be undone.',
    'When the work is done, the other agent checks the result.',
  ];
}

/** The facts the user consents to before a run edits files. */
export function consentDetail(settings: ConsentSettings, folder: string, resuming: boolean, kind: WorkflowKind = 'implementation'): string {
  const lines =
    kind === 'agent'
      ? agentConsent(settings, folder)
      : [
          settings.isolation === 'worktree'
            ? `Agents edit an isolated Git worktree of ${folder}. When the run ends you review the diff and choose whether to apply it. A folder without Git is edited directly after a snapshot instead, and you keep or undo the changes.`
            : `Agents edit files in ${folder} directly (dualAgent.isolation.mode is "none").`,
        ];
  if (kind === 'implementation' && settings.approvePlan && !resuming) lines.push('You approve the plan and its review before any file is edited.');
  if (kind === 'edit') lines.push('Claude makes the change, then Codex reviews the diff.');
  if (kind === 'tdd') lines.push('Codex writes failing tests for the behavior, Claude makes them pass, then Codex reviews.');
  if (settings.maxFixRounds > 0 && kind !== 'agent') {
    lines.push(`If ${kind === 'edit' || kind === 'tdd' ? "Codex's review" : 'the final verification'} fails, Claude gets up to ${settings.maxFixRounds} fix round(s).`);
  }
  if (settings.setupCommands.length) lines.push(`Before the first stage, the extension runs in the worktree: ${commandList(settings.setupCommands)}.`);
  if (settings.verificationCommands.length) {
    lines.push(`After each editing stage, the extension runs: ${commandList(settings.verificationCommands)}.`);
  }
  if (settings.setupCommands.length || settings.verificationCommands.length) {
    lines.push(
      'These commands execute repository code, including code the agents changed, with your permissions and outside any agent sandbox.',
    );
  }
  return lines.join('\n\n');
}

/** Status bar text for the active run. */
export function statusBarText(run: RunRecord): { text: string; tooltip: string; attention: boolean } {
  if (run.status === 'awaiting-approval') {
    return { text: '$(debug-pause) Dual Agent: approve plan', tooltip: 'The plan is ready. Click to approve or reject it.', attention: true };
  }
  const current = run.stages.find((stage) => stage.status === 'running');
  const progress = stageProgress(run);
  return {
    text: `$(sync~spin) Dual Agent${progress ? ` ${progress}` : ''}`,
    tooltip: current ? `${current.title} (${current.assignedAgent}). Click to show the run.` : 'Preparing the run.',
    attention: false,
  };
}
