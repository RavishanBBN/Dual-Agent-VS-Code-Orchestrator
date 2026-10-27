export type FailureKind = 'quota' | 'authentication' | 'unavailable' | 'cancelled' | 'timeout' | 'invalid' | 'unknown';

export class AgentExecutionError extends Error {
  public constructor(
    message: string,
    public readonly kind: FailureKind,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

export function classifyFailure(message: string): FailureKind {
  const value = message.toLowerCase();
  if (/cancelled|canceled|abort/.test(value)) return 'cancelled';
  if (/timed? out|timeout/.test(value)) return 'timeout';
  if (/usage limit|rate limit|quota|too many requests|429/.test(value)) return 'quota';
  if (/not logged in|unauthorized|authentication|invalid.*token|401/.test(value)) return 'authentication';
  if (/not found|enoent|is not recognized|command not found|unavailable|503/.test(value)) return 'unavailable';
  if (/invalid argument|bad request|unsupported|400/.test(value)) return 'invalid';
  return 'unknown';
}

export function canFallback(error: unknown): boolean {
  return error instanceof AgentExecutionError && ['quota', 'unavailable', 'timeout'].includes(error.kind);
}
