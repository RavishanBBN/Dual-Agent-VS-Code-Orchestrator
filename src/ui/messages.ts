import type { AgentStreamEvent, RunRecord, WorkflowKind } from '../core/types.js';

export const OBJECTIVE_LIMIT = 20_000;
const MESSAGE_LIMIT = 2_000;

export type DashboardMessage =
  | { type: 'ready' }
  | { type: 'start'; kind: WorkflowKind; objective: string; allowWrites: boolean }
  | { type: 'cancel' }
  | { type: 'doctor' }
  | { type: 'export' };

/** Validates a message from the webview; anything malformed is dropped. */
export function parseDashboardMessage(value: unknown): DashboardMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
      return { type: 'ready' };
    case 'cancel':
      return { type: 'cancel' };
    case 'doctor':
      return { type: 'doctor' };
    case 'export':
      return { type: 'export' };
    case 'start': {
      const { kind, objective, allowWrites } = message;
      if (kind !== 'implementation' && kind !== 'brainstorming') return undefined;
      if (typeof objective !== 'string' || objective.length > OBJECTIVE_LIMIT) return undefined;
      if (typeof allowWrites !== 'boolean') return undefined;
      return { type: 'start', kind, objective, allowWrites };
    }
    default:
      return undefined;
  }
}

function truncate(value: string): string {
  return value.length <= MESSAGE_LIMIT ? value : `${value.slice(0, MESSAGE_LIMIT)} [...]`;
}

/** The subset of a run the dashboard renders. Stage outputs and raw provider events stay in the host. */
export function runView(run: RunRecord) {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    usage: run.usage,
    warnings: (run.warnings ?? []).map(truncate),
    error: run.error === undefined ? null : truncate(run.error),
    stages: run.stages.map((stage) => ({
      title: stage.title,
      status: stage.status,
      assignedAgent: stage.assignedAgent,
      permission: stage.permission,
      fallback: Boolean(stage.fallbackReason),
    })),
  };
}

export function agentEventView(event: AgentStreamEvent) {
  return { agent: event.agent, category: event.category, message: truncate(event.message) };
}
