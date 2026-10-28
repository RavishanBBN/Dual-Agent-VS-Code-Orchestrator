import type { TokenUsage } from './types.js';

export type FailureKind = 'quota' | 'authentication' | 'network' | 'unavailable' | 'cancelled' | 'timeout' | 'invalid' | 'unknown';

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

/** The machine is offline, so no agent can run; the run continues when the connection is back. */
export class ConnectionLostError extends AgentExecutionError {
  public constructor(message: string) {
    super(message, 'network');
    this.name = 'ConnectionLostError';
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
  // What Claude Code, Codex, and Node report when the connection fails, checked before any generic timeout.
  if (
    /\b(?:enotfound|econnrefused|econnreset|econnaborted|enetunreach|enetdown|ehostunreach|eai_again|etimedout)\b|getaddrinfo|connection (?:error|refused|reset|closed|failed|timed out)|network (?:error|is unreachable|is down|unavailable)|fetch failed|socket hang up|error sending request|stream disconnected|failed to connect|unable to connect|could not resolve host|dns error|failed to lookup address|tcp connect error|no internet|(?:you are|appear to be) offline/.test(
      value,
    )
  ) {
    return 'network';
  }
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
  // A connection error while the machine is online is one provider's outage, which the other agent can cover.
  return error instanceof AgentExecutionError && ['quota', 'network', 'unavailable', 'timeout'].includes(error.kind);
}
