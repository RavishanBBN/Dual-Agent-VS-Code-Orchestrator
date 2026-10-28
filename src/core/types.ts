export type AgentId = 'claude' | 'codex';
/**
 * `chat`, `edit`, `research`, `compare`, and `tdd` handle one message of a conversation; the others can also
 * run standalone. `compare` has both agents answer independently before one merges; `tdd` writes failing
 * tests first and then the code that passes them.
 */
export type WorkflowKind = 'implementation' | 'brainstorming' | 'chat' | 'edit' | 'research' | 'compare' | 'tdd' | 'agent';
/**
 * Which agents a message uses: both, with the first named leading and the second checking, or one alone,
 * without an independent check.
 */
export type AgentSelection = 'claude-codex' | 'codex-claude' | 'claude' | 'codex';
export const AGENT_SELECTIONS: readonly AgentSelection[] = ['claude-codex', 'codex-claude', 'claude', 'codex'];
/**
 * `agent` is the full toolset of the CLI in the folder itself (commands, installs, edits, the web), with the
 * user approving each command or edit the agent does not judge read-only, as in an interactive session.
 */
export type PermissionMode = 'read-only' | 'workspace-write' | 'agent';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'completed-with-findings'
  | 'failed'
  | 'cancelled';
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
/** Where implementation stages edit files: an isolated Git worktree, or the workspace itself. */
export type IsolationMode = 'worktree' | 'none';

export interface TokenUsage {
  /** Every input token, including those served from the provider's cache. */
  inputTokens: number;
  /** The part of the input served from the cache. */
  cachedInputTokens: number;
  outputTokens: number;
  /** The part of the output spent on reasoning or thinking, when the provider reports it. */
  reasoningOutputTokens: number;
  /** The API-equivalent price the Claude CLI estimates; subscription use is not billed per token. */
  estimatedCostUsd?: number;
}

export interface WorkflowStageDefinition {
  id: string;
  title: string;
  agent: AgentId;
  permission: PermissionMode;
  purpose: string;
  instructions: string;
  /** The stage reviews other work and must end with a machine-readable verdict. */
  review?: boolean;
  /** A failing verdict or failing verification at this stage starts a bounded fix round. */
  gate?: boolean;
  /** A failing verdict at this review adds one read-only Claude stage that revises the answer. */
  onFail?: 'revise';
  /**
   * `lean` gives the stage the workspace as a summary (status, changed files, a short diff, untracked file
   * names) instead of full contents; the agent reads what it needs. Every turn of an agent re-reads its
   * prompt, so a smaller one saves tokens many times over. `none` leaves the workspace out entirely and gives
   * the product description instead, for a quick reply to a greeting or a question about the assistant.
   */
  context?: 'lean' | 'none';
  /** The stage may search and read the web; other stages may only when the user turns web access on. */
  web?: boolean;
  /** When plan approval is enabled, the user must approve the work so far before this stage starts. */
  requiresApproval?: boolean;
  /** Fix round that added this stage; absent for template stages. */
  round?: number;
  /** The stage answers on its own, without seeing earlier stages' output, so two answers stay independent. */
  blind?: boolean;
  /** The checks after this stage are expected to fail, as freshly written tests do, so no repair follows. */
  expectFailingChecks?: boolean;
}

export type VerdictOutcome = 'pass' | 'fail' | 'missing';
export type FindingSeverity = 'blocker' | 'high' | 'medium' | 'low';

export interface ReviewFinding {
  severity: FindingSeverity;
  title: string;
  location?: string;
}

export interface ReviewVerdict {
  /** `missing` when the reviewer did not return a verdict that could be parsed. */
  outcome: VerdictOutcome;
  findings: ReviewFinding[];
}

/** One command the extension itself ran, such as a test suite after an editing stage. */
export interface CheckResult {
  command: string[];
  /** -1 when the command could not start or was stopped. */
  exitCode: number;
  durationMs: number;
  /** The most recent output of stdout and stderr combined. */
  output: string;
  timedOut?: boolean;
  /** Why the command could not run, when it did not start. */
  error?: string;
}

export interface StageResult {
  text: string;
  providerSessionId?: string;
  usage: TokenUsage;
  rawEventCount: number;
  /** True when the provider continued an earlier session instead of starting a new one. */
  resumedSession?: boolean;
  /** Model the provider reported using, when it reports one. */
  model?: string;
  /** The account's usage limits as the provider last reported them. */
  quota?: QuotaReading;
}

/** One usage window of an account, such as the five-hour or the weekly limit. */
export interface QuotaWindow {
  /** As the provider names it, such as `five_hour` or `weekly`. */
  name: string;
  /** How much of the window is used, 0 to 100. */
  usedPercent: number;
  resetsAt?: string;
}

/** What a provider reported about the account's usage limits after a call. */
export interface QuotaReading {
  agent: AgentId;
  windows: QuotaWindow[];
  /** The provider refuses calls until `resetsAt`. */
  limited: boolean;
  resetsAt?: string;
  plan?: string;
  observedAt: string;
}

/** A third model's ruling on a disputed check, when a referee is configured. */
export interface RefereeRuling {
  referee: string;
  text: string;
  usage?: TokenUsage;
  model?: string;
  /** Why the referee could not rule; the revision then proceeds without it. */
  error?: string;
}

/** What the user had open in the editor when sending, so the agents start from it. */
export interface EditorContext {
  /** Path relative to the workspace folder. */
  file: string;
  startLine?: number;
  endLine?: number;
  /** The selected text, trimmed. */
  selection?: string;
  /** Errors and warnings VS Code reports for the file, one line each. */
  diagnostics?: string[];
}

/** Model and reasoning effort chosen for one agent; absent values use the CLI's own default. */
export interface AgentOptions {
  model?: string;
  effort?: string;
}

export type AttachmentKind = 'image' | 'pdf' | 'archive' | 'document' | 'notebook' | 'text';

/** A file the user attached to a message, stored in the extension's private storage. */
export interface AttachmentRef {
  id: string;
  /** The file's original name, for display. */
  name: string;
  kind: AttachmentKind;
  /** Absolute path of the stored copy, or of the workspace file for an `@` mention. */
  path: string;
  size: number;
  /** Media type of an image, such as `image/png`. */
  mediaType?: string;
  /** Extracted text for a PDF or Office file, or the listing of an archive. */
  textPath?: string;
  /** Folder an archive was unpacked into. */
  extractedPath?: string;
  /** Set for an `@`-mentioned workspace file, which is read in place rather than copied. */
  workspaceRelative?: string;
  /** What was skipped or could not be read, such as archive entries over the size limit. */
  notes?: string[];
}

export interface StageRecord extends WorkflowStageDefinition {
  assignedAgent: AgentId;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  result?: StageResult;
  error?: string;
  fallbackReason?: string;
  verdict?: ReviewVerdict;
  /** Verification commands the extension ran after this stage edited files. */
  checks?: CheckResult[];
  /** The steps the agent took, bounded so run history stays small. */
  activities?: AgentActivity[];
  /** A third model's ruling, when this check failed and a referee is configured. */
  referee?: RefereeRuling;
}

export interface WorktreeInfo {
  /** Root of the isolated worktree, inside the extension's private storage. */
  path: string;
  /** Directory agents run in: the worktree counterpart of the workspace folder. */
  workingDirectory: string;
  /** Root of the user's repository, where approved changes are applied. */
  repositoryRoot: string;
  /** Commit holding the workspace as it was when the run started, including uncommitted work. */
  baseCommit: string;
  state: 'active' | 'applied' | 'discarded';
  /** True once the configured setup commands have succeeded in this worktree. */
  setupCompleted?: boolean;
  /**
   * Set when the agents edit the folder itself rather than an isolated copy, for a folder without a Git
   * repository or for Agent mode: the hidden repository in private storage that holds the snapshot taken
   * first. `path`, `workingDirectory`, and `repositoryRoot` are then the folder, and `baseCommit` the snapshot.
   */
  gitDir?: string;
  /**
   * Why the folder is edited directly: Agent mode works on the real folder by design, while `folder` means it is
   * not a Git repository, so no isolated copy is possible for any mode.
   */
  snapshotFor?: 'agent' | 'folder';
}

export interface ApprovalRecord {
  decidedAt: string;
  /** Guidance the user added when approving; it is included in later prompts as trusted input. */
  notes?: string;
}

export interface RunRecord {
  schemaVersion: 1;
  id: string;
  kind: WorkflowKind;
  objective: string;
  workspacePath: string;
  status: RunStatus;
  allowWrites: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  stages: StageRecord[];
  usage: Record<AgentId, TokenUsage>;
  /** Conditions that weakened the run without stopping it, such as an unavailable Git snapshot. */
  warnings?: string[];
  error?: string;
  /** Absent in runs recorded before isolation existed, which edited the workspace directly. */
  isolation?: IsolationMode;
  worktree?: WorktreeInfo;
  /** Setup commands run once in a new worktree before the first stage. */
  setupChecks?: CheckResult[];
  approval?: ApprovalRecord;
  /** Why the final gate did not pass; set when the run is completed with findings. */
  unresolved?: string;
  resumeCount?: number;
  /** The conversation this run answers a message of. */
  conversationId?: string;
  attachments?: AttachmentRef[];
  /** Models and efforts chosen for this run; missing entries use the configured defaults. */
  agentOptions?: Partial<Record<AgentId, AgentOptions>>;
  /** Earlier turns of the conversation, as given to agents that do not continue a session. */
  history?: string;
  /** Sessions from the conversation's previous turn that this run's first stage of each agent continues. */
  continueSessions?: Partial<Record<AgentId, string>>;
  /** The user allowed every stage of this run to search and read the web. */
  web?: boolean;
  /** Earlier turns a continued session missed because the other agent answered them alone, by agent. */
  catchUp?: Partial<Record<AgentId, string>>;
  /**
   * Set when the run stopped because every agent that could continue it was at its usage limit: the time the
   * first of those limits resets, after which the run can continue.
   */
  limitReset?: string;
  /** The run stopped because the machine went offline; it continues when the connection is back. */
  offlineSince?: string;
  /** Which agents the run uses; absent means both, with Claude leading. */
  agents?: AgentSelection;
  /** The user's project brief, given to every stage as their guidance. */
  brief?: string;
  /** The file and selection the user had open when sending. */
  editorContext?: EditorContext;
}

/** Everything about a new run beyond its kind, objective, folder, and consent. */
export interface StartOptions {
  conversationId?: string;
  attachments?: AttachmentRef[];
  agentOptions?: Partial<Record<AgentId, AgentOptions>>;
  history?: string;
  continueSessions?: Partial<Record<AgentId, string>>;
  /** An active worktree from the same conversation that this run keeps editing. */
  worktree?: WorktreeInfo;
  web?: boolean;
  catchUp?: Partial<Record<AgentId, string>>;
  agents?: AgentSelection;
  brief?: string;
  editorContext?: EditorContext;
}

export interface AgentRunRequest {
  /** Prompt for a new session. */
  prompt: string;
  cwd: string;
  permission: PermissionMode;
  signal: AbortSignal;
  onEvent: (event: AgentStreamEvent) => void;
  /** Directories that must never supply the agent executable, such as the workspace and its worktree. */
  untrustedDirectories?: readonly string[];
  /**
   * Continue this session with a shorter prompt. Adapters that cannot resume, or that find the session
   * gone, use `prompt` in a new session instead.
   */
  resume?: { sessionId: string; prompt: string };
  /** Model and effort for this run, already validated; absent values use the adapter's configuration. */
  options?: AgentOptions;
  /** Image files to attach to the prompt, for providers that take images as arguments. */
  images?: readonly string[];
  /** Folders outside the working directory the agent may read, such as the conversation's attachments. */
  readableDirectories?: readonly string[];
  /** The agent may search and read the web. */
  web?: boolean;
  /**
   * Commands the user consented to as verification commands, which an editing stage may run itself so it
   * can test its change before finishing.
   */
  allowedCommands?: readonly (readonly string[])[];
}

export type ActivityKind = 'read' | 'search' | 'edit' | 'command' | 'web' | 'reasoning' | 'todo' | 'tool';

/** One step an agent took, such as reading a file or running a command. */
export interface AgentActivity {
  kind: ActivityKind;
  /** The tool as the agent names it, such as Bash, Read, or Shell. */
  tool: string;
  /** A one-line description, such as the command's purpose or the file read. */
  title: string;
  /** What the tool was given: the command, path, pattern, or edit. */
  input?: string;
  /** What it returned, trimmed. */
  output?: string;
  failed?: boolean;
  /** Provider ID that links a later result to this step. */
  id?: string;
}

/** The result of an earlier step, which Claude reports separately from the call. */
export interface ActivityResult {
  id: string;
  output: string;
  failed: boolean;
}

export interface AgentStreamEvent {
  agent: AgentId;
  category: 'lifecycle' | 'message' | 'tool' | 'usage' | 'diagnostic';
  message: string;
  raw?: unknown;
  /** Text the agent has just written, streamed before its message is complete. */
  delta?: string;
  activity?: AgentActivity;
  activityResult?: ActivityResult;
  /** The account's usage limits, when the provider reports them during the call. */
  quota?: QuotaReading;
}

export interface AgentHealth {
  agent: AgentId;
  available: boolean;
  version?: string;
  detail: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  doctor(signal?: AbortSignal, workspacePath?: string): Promise<AgentHealth>;
  run(request: AgentRunRequest): Promise<StageResult>;
  /** Reports repository-controlled configuration that this provider may apply to a run. */
  preflightWarnings?(workspacePath: string): Promise<string[]>;
}

export interface RunStore {
  list(): Promise<RunRecord[]>;
  save(run: RunRecord): Promise<void>;
  latest(): Promise<RunRecord | undefined>;
}

export interface OrchestratorEvent {
  type: 'run-updated' | 'agent-event' | 'log';
  run: RunRecord;
  agentEvent?: AgentStreamEvent;
  /** Stage an agent event belongs to. */
  stageId?: string;
  /** Orchestrator activity such as a stage starting or a verification command's output. */
  message?: string;
}

export interface OrchestratorOptions {
  maxContextCharacters: number;
  fallbackOnQuota: boolean;
  /** Where implementation runs edit files. Defaults to the workspace itself. */
  isolation?: IsolationMode;
  /** Fix rounds allowed after a failing final gate. */
  maxFixRounds?: number;
  /** Ask the user to approve the plan before the first editing stage. */
  approvePlan?: boolean;
  /** Agents whose stages continue that agent's previous session within a run. */
  resumeSessions?: readonly AgentId[];
  /** Commands run in a new worktree before the first stage, such as installing dependencies. */
  setupCommands?: readonly (readonly string[])[];
  /** Commands run after every editing stage; their results are given to the next reviewer. */
  verificationCommands?: readonly (readonly string[])[];
  /** Mask credentials in what prompts quote; on unless set to false. */
  redactSecrets?: boolean;
}

export interface ApprovalDecision {
  approved: boolean;
  notes?: string;
}

export interface UntrackedFile {
  path: string;
  /** Text content, present only for small, regular, non-sensitive files inside the workspace. */
  content?: string;
  /** Why the content was not included. */
  omitted?: string;
}

export interface GitSnapshot {
  /** False when Git could not describe the workspace; the other fields are then empty. */
  available: boolean;
  status: string;
  diff: string;
  diffStat: string;
  untracked: UntrackedFile[];
  warnings: string[];
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
});

export function checksPassed(results: readonly CheckResult[]): boolean {
  return results.every((result) => result.exitCode === 0 && !result.error && !result.timedOut);
}

/** Statuses after which a run no longer changes unless it is resumed. */
export function isFinished(status: RunStatus): boolean {
  return status === 'completed' || status === 'completed-with-findings' || status === 'failed' || status === 'cancelled';
}
