/**
 * Messages between the chat webview and the extension. The webview is treated as untrusted input: every
 * message is validated here before the extension acts on it, and anything malformed is dropped.
 */
import type { ActivityKind, AgentId, AgentOptions, RunStatus, WorkflowKind } from '../../core/types.js';

export const MESSAGE_LIMIT = 20_000;
export const GUIDANCE_LIMIT = 4_000;
/** Base64 for a 25 MB file, plus padding. */
const DATA_LIMIT = Math.ceil((25 * 1024 * 1024 * 4) / 3) + 4;
const MODES: readonly WorkflowKind[] = ['chat', 'research', 'edit', 'brainstorming', 'implementation'];
const ID = /^[A-Za-z0-9-]{1,64}$/;

// ---- Extension → webview ----

export interface AttachmentView {
  id: string;
  name: string;
  kind: string;
  size: string;
  /** Webview URI of an image's stored copy, for its thumbnail. */
  thumbnail?: string;
  notes?: string[];
}

export interface ActivityView {
  kind: ActivityKind;
  /** The tool's name, shown in bold, such as Bash, Read, or Shell. */
  tool: string;
  title: string;
  /** Shown as IN: the command, path, pattern, or edit. */
  input?: string;
  /** Shown as OUT. */
  output?: string;
  failed?: boolean;
  /** The step the agent is still waiting on. */
  running?: boolean;
}

/** Tokens one agent used; input includes cached input, and output includes reasoning. */
export interface UsageNumbers {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  /** The Claude CLI's API-equivalent estimate; subscriptions are not billed per token. */
  costUsd?: number;
}

export type UsageByAgent = Record<AgentId, UsageNumbers>;

export interface UsagePeriod {
  label: string;
  /** Messages and runs counted in the period. */
  runs: number;
  usage: UsageByAgent;
}

export interface FindingView {
  severity: string;
  title: string;
  location?: string;
}

export interface StageView {
  index: number;
  id: string;
  title: string;
  agent: AgentId;
  /** The agent's label, with its model when known, such as "Claude · opus". */
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  /** Markdown: the stage's final text, or what has streamed so far while it runs. */
  text: string;
  activities: ActivityView[];
  verdict?: { outcome: string; summary: string; findings: FindingView[] };
  error?: string;
  fallback?: string;
  /** Shown expanded by default: the answer the user should read, or the stage that is running. */
  primary: boolean;
  /** How long a finished stage took, such as "12s". */
  duration?: string;
  usage?: UsageNumbers;
}

export interface ChangeView {
  path: string;
  status: string;
}

export interface CheckView {
  command: string;
  passed: boolean;
  summary: string;
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface TurnView {
  id: string;
  mode: WorkflowKind;
  message: string;
  attachments: AttachmentView[];
  createdAt: string;
  status: RunStatus | 'starting';
  runId?: string;
  stages: StageView[];
  outcome?: { text: string; tone: Tone };
  error?: string;
  /** Changes in the conversation's worktree after this turn, when they are still waiting for review. */
  changes?: { runId: string; files: ChangeView[]; state: 'active' | 'applied' | 'discarded' };
  checks: CheckView[];
  awaitingApproval: boolean;
  /** Tokens the message used, including failed attempts. */
  usage?: UsageByAgent;
  canResume: boolean;
  /** Retry or edit is possible: nothing is running and the message has finished or stopped. */
  canRetry: boolean;
  /** The run stopped at the agents' usage limits: when they reset, and when it continues on its own if it will. */
  paused?: { runId: string; reset: string; continuesAt?: string };
}

export interface ModelChoice {
  id: string;
  label: string;
  efforts: string[];
}

export interface AgentChoices {
  /** Empty id means the CLI's own default. */
  models: ModelChoice[];
  /** Efforts offered when no model, or a custom model, is chosen. */
  efforts: string[];
}

export interface ComposerView {
  mode: WorkflowKind;
  /** Agents may search and read the web; Research mode always may. */
  web: boolean;
  options: Record<AgentId, AgentOptions>;
  pending: AttachmentView[];
  choices: Record<AgentId, AgentChoices>;
  /** The earlier message being edited; sending replaces it and the messages after it. */
  editing?: { turnId: string; preview: string };
}

/** A message waiting for the current one to finish, or for the agents' limits to reset. */
export interface QueuedView {
  id: string;
  text: string;
  mode: WorkflowKind;
  /** The conversation's title, when it is not the one shown. */
  conversation?: string;
}

/** An agent at its usage limit. */
export interface LimitView {
  agent: AgentId;
  /** When the limit resets, such as "3:05 PM". */
  until: string;
  /** No reset time was given, so `until` is when the agent is tried again. */
  estimated: boolean;
}

export interface ConsentView {
  turnId: string;
  mode: WorkflowKind;
  details: string[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updated: string;
  turns: number;
}

export interface ChatState {
  /** Why the chat cannot run here, such as an untrusted or missing folder. */
  blocked?: string;
  folder?: string;
  conversationId?: string;
  title: string;
  conversations: ConversationSummary[];
  turns: TurnView[];
  /** A run is active anywhere in this window, so sending is disabled. */
  running: boolean;
  composer: ComposerView;
  consent?: ConsentView;
  /** A short message for the user, such as a refused attachment. */
  notice?: { text: string; tone: Tone };
  /** Token totals for this conversation, today, the last 7 days, and all runs in this workspace. */
  usage: UsagePeriod[];
  queue: QueuedView[];
  /** Agents at their usage limits; while one is, the other works alone. */
  limits: LimitView[];
}

export type HostMessage =
  | { type: 'state'; state: ChatState }
  | { type: 'mentions'; query: string; items: { path: string; description: string }[] }
  | { type: 'focus' }
  | { type: 'showUsage' }
  /** Puts an earlier message's text in the composer for editing. */
  | { type: 'fillComposer'; text: string };

// ---- Webview → extension ----

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; mode: WorkflowKind }
  | { type: 'stop' }
  | { type: 'newConversation' }
  | { type: 'openConversation'; id: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'pickFiles' }
  | { type: 'attachData'; name: string; data: string }
  | { type: 'attachTooLarge'; name: string }
  | { type: 'removeAttachment'; id: string }
  | { type: 'searchMentions'; query: string }
  | { type: 'addMention'; path: string }
  | { type: 'setMode'; mode: WorkflowKind }
  | { type: 'setWeb'; enabled: boolean }
  | { type: 'setOptions'; agent: AgentId; model: string; effort: string }
  | { type: 'customModel'; agent: AgentId }
  | { type: 'consent'; turnId: string; decision: 'once' | 'conversation' | 'deny' }
  | { type: 'approve'; notes: string }
  | { type: 'reject' }
  | { type: 'reviewPlan'; runId: string }
  | { type: 'reviewChanges'; runId: string }
  | { type: 'openChange'; runId: string; path: string; status: string }
  | { type: 'applyChanges'; runId: string }
  | { type: 'discardChanges'; runId: string }
  | { type: 'openStage'; runId: string; index: number }
  | { type: 'openReport'; runId: string }
  | { type: 'resume'; runId: string }
  | { type: 'openLink'; href: string }
  | { type: 'openFile'; path: string }
  | { type: 'copy'; text: string }
  | { type: 'dismissNotice' }
  | { type: 'retry'; turnId: string }
  | { type: 'editMessage'; turnId: string }
  | { type: 'cancelEdit' }
  | { type: 'unqueue'; id: string }
  | { type: 'continueAfterLimit'; runId: string }
  | { type: 'cancelContinuation'; runId: string }
  /** A script error or blocked content in the webview, reported so it reaches the output log. */
  | { type: 'pageError'; message: string };

type Fields = Record<string, unknown>;

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function mode(value: unknown): value is WorkflowKind {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function agent(value: unknown): value is AgentId {
  return value === 'claude' || value === 'codex';
}

/** Returns the message if it is well formed, otherwise undefined. */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as Fields;
  switch (message.type) {
    case 'ready':
    case 'stop':
    case 'newConversation':
    case 'pickFiles':
    case 'reject':
    case 'dismissNotice':
    case 'cancelEdit':
      return { type: message.type };
    case 'retry':
    case 'editMessage':
      return id(message.turnId) ? { type: message.type, turnId: message.turnId } : undefined;
    case 'unqueue':
      return id(message.id) ? { type: 'unqueue', id: message.id } : undefined;
    case 'continueAfterLimit':
    case 'cancelContinuation':
      return id(message.runId) ? { type: message.type, runId: message.runId } : undefined;
    case 'send':
      return text(message.text, MESSAGE_LIMIT) && message.text.trim() && mode(message.mode)
        ? { type: 'send', text: message.text, mode: message.mode }
        : undefined;
    case 'openConversation':
    case 'deleteConversation':
    case 'removeAttachment':
      return id(message.id) ? { type: message.type, id: message.id } : undefined;
    case 'attachData':
      return text(message.name, 260) && message.name.trim() && text(message.data, DATA_LIMIT) && /^[A-Za-z0-9+/]+={0,2}$/.test(message.data)
        ? { type: 'attachData', name: message.name, data: message.data }
        : undefined;
    case 'attachTooLarge':
      return text(message.name, 260) ? { type: 'attachTooLarge', name: message.name } : undefined;
    case 'searchMentions':
      return text(message.query, 200) ? { type: 'searchMentions', query: message.query } : undefined;
    case 'addMention':
      return text(message.path, 1_000) && message.path.trim() ? { type: 'addMention', path: message.path } : undefined;
    case 'setMode':
      return mode(message.mode) ? { type: 'setMode', mode: message.mode } : undefined;
    case 'setWeb':
      return typeof message.enabled === 'boolean' ? { type: 'setWeb', enabled: message.enabled } : undefined;
    case 'setOptions':
      return agent(message.agent) && text(message.model, 128) && text(message.effort, 16)
        ? { type: 'setOptions', agent: message.agent, model: message.model, effort: message.effort }
        : undefined;
    case 'customModel':
      return agent(message.agent) ? { type: 'customModel', agent: message.agent } : undefined;
    case 'consent':
      return id(message.turnId) && (message.decision === 'once' || message.decision === 'conversation' || message.decision === 'deny')
        ? { type: 'consent', turnId: message.turnId, decision: message.decision }
        : undefined;
    case 'approve':
      return text(message.notes, GUIDANCE_LIMIT) ? { type: 'approve', notes: message.notes } : undefined;
    case 'reviewPlan':
    case 'reviewChanges':
    case 'applyChanges':
    case 'discardChanges':
    case 'openReport':
    case 'resume':
      return id(message.runId) ? { type: message.type, runId: message.runId } : undefined;
    case 'openChange':
      return id(message.runId) && text(message.path, 1_000) && text(message.status, 20)
        ? { type: 'openChange', runId: message.runId, path: message.path, status: message.status }
        : undefined;
    case 'openStage':
      return id(message.runId) && Number.isInteger(message.index) && (message.index as number) >= 0 && (message.index as number) < 100
        ? { type: 'openStage', runId: message.runId, index: message.index as number }
        : undefined;
    case 'openLink':
      return text(message.href, 2_000) ? { type: 'openLink', href: message.href } : undefined;
    case 'openFile':
      return text(message.path, 1_000) && message.path.trim() ? { type: 'openFile', path: message.path } : undefined;
    case 'copy':
      return text(message.text, 1_000_000) ? { type: 'copy', text: message.text } : undefined;
    case 'pageError':
      return typeof message.message === 'string' ? { type: 'pageError', message: message.message.slice(0, 2_000) } : undefined;
    default:
      return undefined;
  }
}

/**
 * A file reference from agent output, such as `src/math.js:12` or `F:/repo/math.js:12:3`, split into the
 * path and the 1-based line it points at.
 */
export function fileReference(value: string): { path: string; line?: number } {
  const match = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(value.trim().replace(/#L(\d+)(?:-L?\d+)?$/, ':$1'));
  const file = match?.[1] ?? value;
  const line = match?.[2] ? Number(match[2]) : undefined;
  return line && line > 0 ? { path: file, line } : { path: file };
}

/**
 * Where a link from agent output may lead. Only web and mail links open, after confirmation; anything
 * else, including `command:`, `file:`, and `vscode:` URIs, is refused.
 */
export function linkTarget(href: string): { kind: 'external'; url: string } | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? { kind: 'external', url: url.toString() } : undefined;
}
