export type AgentId = 'claude' | 'codex';
export type WorkflowKind = 'implementation' | 'brainstorming';
export type PermissionMode = 'read-only' | 'workspace-write';
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
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
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
  /** When plan approval is enabled, the user must approve the work so far before this stage starts. */
  requiresApproval?: boolean;
  /** Fix round that added this stage; absent for template stages. */
  round?: number;
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
}

export interface AgentStreamEvent {
  agent: AgentId;
  category: 'lifecycle' | 'message' | 'tool' | 'usage' | 'diagnostic';
  message: string;
  raw?: unknown;
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
