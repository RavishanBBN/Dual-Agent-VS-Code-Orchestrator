export type AgentId = 'claude' | 'codex';
export type WorkflowKind = 'implementation' | 'brainstorming';
export type PermissionMode = 'read-only' | 'workspace-write';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

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
}

export interface StageResult {
  text: string;
  providerSessionId?: string;
  usage: TokenUsage;
  rawEventCount: number;
}

export interface StageRecord extends WorkflowStageDefinition {
  assignedAgent: AgentId;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  result?: StageResult;
  error?: string;
  fallbackReason?: string;
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
  error?: string;
}

export interface AgentRunRequest {
  prompt: string;
  cwd: string;
  permission: PermissionMode;
  signal: AbortSignal;
  onEvent: (event: AgentStreamEvent) => void;
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
  doctor(signal?: AbortSignal): Promise<AgentHealth>;
  run(request: AgentRunRequest): Promise<StageResult>;
}

export interface RunStore {
  list(): Promise<RunRecord[]>;
  save(run: RunRecord): Promise<void>;
  latest(): Promise<RunRecord | undefined>;
}

export interface OrchestratorEvent {
  type: 'run-updated' | 'agent-event';
  run: RunRecord;
  agentEvent?: AgentStreamEvent;
}

export interface OrchestratorOptions {
  maxContextCharacters: number;
  fallbackOnQuota: boolean;
}

export interface GitSnapshot {
  status: string;
  diff: string;
  diffStat: string;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
});
