/** Builds what the chat shows from conversations, runs, and live agent activity. No VS Code imports. */
import { formatSize } from '../../core/context.js';
import type { Conversation, ConversationTurn } from '../../core/conversation.js';
import { describeOutcome, finalStage } from '../../core/conversation.js';
import { canResume } from '../../core/orchestrator.js';
import type { AgentActivity, AgentId, AgentStreamEvent, AttachmentRef, RunRecord, StageRecord, TokenUsage } from '../../core/types.js';
import { checksPassed } from '../../core/types.js';
import { sumByAgent, totalTokens } from '../../core/usage.js';
import { onlyMinorFindings, summarizeVerdict } from '../../core/verdict.js';
import type { WorktreeChange } from '../../core/worktree.js';
import { describeCheck, relativeTime } from '../presentation.js';
import type {
  ActivityView,
  AttachmentView,
  ConversationSummary,
  StageView,
  Tone,
  TurnView,
  UsageByAgent,
  UsageNumbers,
  UsagePeriod,
} from './protocol.js';

/** Text streamed by the stage that is running, which the run record does not hold yet. Steps are on the stage. */
export interface LiveStage {
  text: string;
  /** A Claude message just ended, so the next streamed text starts a new paragraph. */
  breakNext?: boolean;
}

function duration(stage: StageRecord): string | undefined {
  if (!stage.startedAt || !stage.completedAt) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(stage.completedAt) - Date.parse(stage.startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return undefined;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A stage's steps for display; while the stage runs, a last step without a result is still in progress. */
function activityViews(activities: readonly AgentActivity[] | undefined, running: boolean): ActivityView[] {
  const list = activities ?? [];
  return list.map((activity, index) => ({
    kind: activity.kind,
    tool: activity.tool,
    title: activity.title,
    ...(activity.input ? { input: activity.input } : {}),
    ...(activity.output ? { output: activity.output } : {}),
    ...(activity.failed ? { failed: true } : {}),
    ...(running && index === list.length - 1 && activity.output === undefined && activity.kind !== 'reasoning' ? { running: true } : {}),
  }));
}

export interface TranscriptInput {
  conversation: Conversation;
  runs: ReadonlyMap<string, RunRecord>;
  /** Live state by run ID, then stage ID. */
  live: ReadonlyMap<string, ReadonlyMap<string, LiveStage>>;
  /** Changes waiting for review in a run's worktree, by run ID. */
  changes: ReadonlyMap<string, readonly WorktreeChange[]>;
  activeRunId?: string;
  awaitingApprovalRunId?: string;
  /** Webview URI for an image attachment's thumbnail. */
  thumbnail: (attachment: AttachmentRef) => string | undefined;
}

const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' };

export function usageNumbers(usage: TokenUsage): UsageNumbers {
  return {
    input: usage.inputTokens,
    cached: usage.cachedInputTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningOutputTokens,
    ...(usage.estimatedCostUsd !== undefined ? { costUsd: usage.estimatedCostUsd } : {}),
  };
}

function byAgent(usage: Record<AgentId, TokenUsage>): UsageByAgent {
  return { claude: usageNumbers(usage.claude), codex: usageNumbers(usage.codex) };
}

const used = (usage: Record<AgentId, TokenUsage>): boolean => totalTokens(usage.claude) + totalTokens(usage.codex) > 0;

export interface UsageWindow {
  /** All runs in the workspace's history, including the one running. */
  runs: Iterable<RunRecord>;
  /** Local midnight today, and seven days before, in milliseconds. */
  dayStartMs: number;
  weekStartMs: number;
}

/**
 * Token totals for the current conversation, today, the last seven days, and every run in the history.
 * A conversation counts the usage kept on its turns, so totals survive the pruning of old runs.
 */
export function usageOverview(conversation: Conversation | undefined, window: UsageWindow): UsagePeriod[] {
  const runs = [...window.runs];
  const byId = new Map(runs.map((run) => [run.id, run]));
  const conversationUsage = (conversation?.turns ?? []).flatMap((turn) => {
    const usage = (turn.runId ? byId.get(turn.runId)?.usage : undefined) ?? turn.usage;
    return usage ? [usage] : [];
  });
  const since = (start: number): RunRecord[] => runs.filter((run) => Date.parse(run.createdAt) >= start);
  const period = (label: string, items: Record<AgentId, TokenUsage>[]): UsagePeriod => ({
    label,
    runs: items.filter(used).length,
    usage: byAgent(sumByAgent(items)),
  });
  return [
    period('This conversation', conversationUsage),
    period('Today', since(window.dayStartMs).map((run) => run.usage)),
    period('Last 7 days', since(window.weekStartMs).map((run) => run.usage)),
    period('All runs', runs.map((run) => run.usage)),
  ];
}

export function attachmentView(attachment: AttachmentRef, thumbnail?: string): AttachmentView {
  return {
    id: attachment.id,
    name: attachment.workspaceRelative ?? attachment.name,
    kind: attachment.workspaceRelative ? 'workspace file' : attachment.kind,
    size: formatSize(attachment.size),
    ...(thumbnail ? { thumbnail } : {}),
    ...(attachment.notes?.length ? { notes: attachment.notes } : {}),
  };
}

function stageLabel(run: RunRecord, stage: StageRecord): string {
  const agent = stage.assignedAgent;
  const model = stage.result?.model ?? run.agentOptions?.[agent]?.model;
  const fallback = agent !== stage.agent ? ' (standing in)' : '';
  return `${AGENT_NAMES[agent]}${model ? ` · ${model}` : ''}${fallback}`;
}

function toneOf(run: RunRecord): Tone {
  if (run.status === 'failed') return 'bad';
  if (run.status === 'cancelled') return 'neutral';
  if (run.status === 'completed-with-findings') return 'warn';
  const reviews = run.stages.filter((stage) => stage.review && stage.status === 'completed');
  const last = reviews.at(-1);
  if (!last?.verdict || last.verdict.outcome === 'pass') return 'good';
  return run.kind === 'chat' && onlyMinorFindings(last.verdict) ? 'good' : 'warn';
}

function stageViews(run: RunRecord, live: ReadonlyMap<string, LiveStage> | undefined, active: boolean): StageView[] {
  const final = finalStage(run);
  return run.stages.map((stage, index): StageView => {
    const streaming = live?.get(stage.id);
    const running = active && stage.status === 'running';
    const text = stage.status === 'completed' ? (stage.result?.text ?? '') : running ? (streaming?.text ?? '') : '';
    const view: StageView = {
      index,
      id: stage.id,
      title: stage.title,
      agent: stage.assignedAgent,
      label: stageLabel(run, stage),
      status: stage.status,
      text,
      activities: activityViews(stage.activities, running),
      primary: running || stage === final || (stage.status === 'failed' && !final),
    };
    if (stage.verdict) {
      view.verdict = {
        outcome: stage.verdict.outcome,
        summary: summarizeVerdict(stage.verdict),
        findings: stage.verdict.findings.map((finding) => ({
          severity: finding.severity,
          title: finding.title,
          ...(finding.location ? { location: finding.location } : {}),
        })),
      };
    }
    if (stage.error) view.error = stage.error;
    if (stage.fallbackReason) view.fallback = stage.fallbackReason;
    const took = duration(stage);
    if (took) view.duration = took;
    if (stage.result && totalTokens(stage.result.usage) > 0) view.usage = usageNumbers(stage.result.usage);
    return view;
  });
}

const CHANGE_LETTERS: Record<WorktreeChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D', 'type-changed': 'T' };

function turnView(turn: ConversationTurn, input: TranscriptInput, latestEditRun: string | undefined): TurnView {
  const run = turn.runId ? input.runs.get(turn.runId) : undefined;
  const active = run !== undefined && run.id === input.activeRunId;
  const view: TurnView = {
    id: turn.id,
    mode: turn.mode,
    message: turn.message,
    attachments: turn.attachments.map((attachment) => attachmentView(attachment, attachment.kind === 'image' ? input.thumbnail(attachment) : undefined)),
    createdAt: turn.createdAt,
    status: run?.status ?? turn.status ?? 'starting',
    stages: run ? stageViews(run, input.live.get(run.id), active) : [],
    checks: [],
    awaitingApproval: run !== undefined && run.id === input.awaitingApprovalRunId,
    canResume: run !== undefined && !active && canResume(run),
  };
  if (turn.runId) view.runId = turn.runId;
  if (run && !active) view.outcome = { text: describeOutcome(run), tone: toneOf(run) };
  else if (!run && turn.outcome) view.outcome = { text: turn.outcome, tone: turn.status === 'failed' ? 'bad' : 'neutral' };
  if (!run && turn.answer) {
    // The run was pruned from history; the turn still holds the answer.
    view.stages = [
      { index: 0, id: 'answer', title: 'Answer', agent: 'claude', label: 'Claude', status: 'completed', text: turn.answer, activities: [], primary: true },
    ];
  }
  if (!run && turn.usage && used(turn.usage)) view.usage = byAgent(turn.usage);
  const error = run?.error ?? turn.error;
  if (error && view.status !== 'completed') view.error = error;
  if (run) {
    const checked = [...run.stages].reverse().find((stage) => stage.checks?.length);
    view.checks = (checked?.checks ?? []).map((check) => ({ command: check.command.join(' '), passed: checksPassed([check]), summary: describeCheck(check) }));
    if (used(run.usage)) view.usage = byAgent(run.usage);
    // The worktree is shared by the conversation's edit turns, so only the latest one shows its changes.
    if (run.worktree && run.id === latestEditRun && !active) {
      const files = (input.changes.get(run.id) ?? []).map((change) => ({ path: change.path, status: CHANGE_LETTERS[change.status] }));
      view.changes = { runId: run.id, files, state: run.worktree.state };
    }
  }
  return view;
}

export function transcript(input: TranscriptInput): TurnView[] {
  const latestEditRun = [...input.conversation.turns]
    .reverse()
    .map((turn) => (turn.runId ? input.runs.get(turn.runId) : undefined))
    .find((run) => run?.worktree)?.id;
  return input.conversation.turns.map((turn) => turnView(turn, input, latestEditRun));
}

export function conversationSummaries(conversations: readonly Conversation[], nowMs: number): ConversationSummary[] {
  return conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    updated: relativeTime(conversation.updatedAt, nowMs),
    turns: conversation.turns.length,
  }));
}

/**
 * Adds an agent event to the live view of a running stage. Claude's text is built from its streamed
 * fragments, with a paragraph break between messages; Codex sends each message whole.
 */
export function applyLiveEvent(stage: LiveStage, event: AgentStreamEvent): void {
  if (event.delta !== undefined) {
    if (stage.breakNext && stage.text) stage.text += '\n\n';
    stage.breakNext = false;
    stage.text += event.delta;
  } else if (event.category === 'message') {
    if (event.agent === 'claude') stage.breakNext = true;
    else if (event.message) stage.text += `${stage.text ? '\n\n' : ''}${event.message}`;
  }
}
