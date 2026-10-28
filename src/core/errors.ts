import type { TokenUsage } from './types.js';

export type FailureKind = 'quota' | 'authentication' | 'unavailable' | 'cancelled' | 'timeout' | 'invalid' | 'unknown';

/** Error details are persisted and shown to the user, so they are capped. */
export const ERROR_DETAIL_LIMIT = 2_000;

export class AgentExecutionError extends Error {
  public constructor(
    message: string,
    public readonly kind: FailureKind,
    public readonly exitCode?: number,
    /** Usage the provider reported before the attempt failed. */
    public readonly usage?: TokenUsage,
  ) {
    super(limitDetail(message));
    this.name = 'AgentExecutionError';
  }
}

/** Every agent that could run the stage is at its usage limit; the run can continue after `resetAt`. */
export class LimitReachedError extends AgentExecutionError {
  public constructor(
    message: string,
    public readonly resetAt: string,
  ) {
    super(message, 'quota');
    this.name = 'LimitReachedError';
  }
}

export function isQuotaError(error: unknown): error is AgentExecutionError {
  return error instanceof AgentExecutionError && error.kind === 'quota';
}

export function limitDetail(message: string, limit = ERROR_DETAIL_LIMIT): string {
  const value = message.trim();
  return value.length <= limit ? value : `[...] ${value.slice(value.length - limit)}`;
}

/**
 * Classifies a provider or process error message. Callers must pass provider-reported error text or
 * process stderr, never the agent's output stream, because that stream contains repository content.
 */
export function classifyFailure(message: string): FailureKind {
  const value = message.toLowerCase();
  if (/\b(?:cancelled|canceled|aborted)\b/.test(value)) return 'cancelled';
  if (/\btimed? out\b|\btimeout\b/.test(value)) return 'timeout';
  if (
    /usage limit|rate[ _-]limit|\bquota\b|too many requests|\b429\b|\blimit reached\b|hit your (?:usage )?limit|(?:5-hour|weekly|daily|session) limit|credit balance is too low|out of (?:credits|tokens)|insufficient (?:credits|balance)/.test(
      value,
    )
  ) {
    return 'quota';
  }
  if (/not logged in|unauthori[sz]ed|authentication|invalid[^\n]{0,40}\btoken\b|\b401\b/.test(value)) return 'authentication';
  if (/command not found|is not recognized|\benoent\b|not found on path|executable not found|\bunavailable\b|\boverloaded\b|\b503\b/.test(value)) {
    return 'unavailable';
  }
  if (/invalid argument|bad request|\bunsupported\b|\b400\b/.test(value)) return 'invalid';
  return 'unknown';
}

export function canFallback(error: unknown): boolean {
  return error instanceof AgentExecutionError && ['quota', 'unavailable', 'timeout'].includes(error.kind);
}
