import type { AgentStreamEvent, StageResult, TokenUsage } from '../core/types.js';
import { emptyUsage } from '../core/types.js';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonObject) : undefined;
}

function numberAt(object: JsonObject | undefined, ...keys: string[]): number {
  if (!object) return 0;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const object = asObject(entry);
      return typeof object?.text === 'string' ? object.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export interface ParsedLine {
  event?: AgentStreamEvent;
  text?: string;
  sessionId?: string;
  usage?: TokenUsage;
  terminal?: boolean;
  /** A provider-reported failure of the turn. The stage fails even if the process exits cleanly. */
  failure?: string;
  /** A provider-reported error that may have been recovered from, kept to explain a later failure. */
  error?: string;
}

export function parseCodexLine(line: string): ParsedLine | undefined {
  let value: JsonObject;
  try {
    value = JSON.parse(line) as JsonObject;
  } catch {
    return undefined;
  }

  const type = typeof value.type === 'string' ? value.type : 'unknown';
  if (type === 'thread.started' && typeof value.thread_id === 'string') {
    return {
      sessionId: value.thread_id,
      event: { agent: 'codex', category: 'lifecycle', message: 'Codex thread started.', raw: value },
    };
  }

  if (type === 'item.completed') {
    const item = asObject(value.item);
    const itemType = typeof item?.type === 'string' ? item.type : 'item';
    const text = typeof item?.text === 'string' ? item.text : '';
    return {
      ...(text && itemType === 'agent_message' ? { text } : {}),
      event: {
        agent: 'codex',
        category: itemType === 'agent_message' ? 'message' : 'tool',
        message: text || `Completed ${itemType}.`,
        raw: value,
      },
    };
  }

  if (type === 'turn.completed') {
    const usage = asObject(value.usage);
    return {
      terminal: true,
      usage: {
        inputTokens: numberAt(usage, 'input_tokens', 'inputTokens'),
        cachedInputTokens: numberAt(usage, 'cached_input_tokens', 'cachedInputTokens'),
        outputTokens: numberAt(usage, 'output_tokens', 'outputTokens'),
        reasoningOutputTokens: numberAt(usage, 'reasoning_output_tokens', 'reasoningOutputTokens'),
      },
      event: { agent: 'codex', category: 'usage', message: 'Codex turn completed.', raw: value },
    };
  }

  if (type === 'turn.failed' || type === 'error') {
    const error = asObject(value.error);
    const message =
      typeof value.message === 'string'
        ? value.message
        : typeof error?.message === 'string'
          ? error.message
          : 'Codex reported a failure.';
    return {
      ...(type === 'turn.failed' ? { failure: message } : { error: message }),
      event: { agent: 'codex', category: 'diagnostic', message, raw: value },
    };
  }

  return { event: { agent: 'codex', category: 'lifecycle', message: type, raw: value } };
}

export function parseClaudeLine(line: string): ParsedLine | undefined {
  let value: JsonObject;
  try {
    value = JSON.parse(line) as JsonObject;
  } catch {
    return undefined;
  }

  const type = typeof value.type === 'string' ? value.type : 'unknown';
  const sessionId = typeof value.session_id === 'string' ? value.session_id : undefined;

  if (type === 'assistant') {
    const message = asObject(value.message);
    const text = textContent(message?.content);
    return {
      ...(sessionId ? { sessionId } : {}),
      ...(text ? { text } : {}),
      event: { agent: 'claude', category: 'message', message: text || 'Claude produced a message.', raw: value },
    };
  }

  if (type === 'result') {
    const usage = asObject(value.usage);
    const result = typeof value.result === 'string' ? value.result : textContent(value.result);
    const cost = typeof value.total_cost_usd === 'number' ? value.total_cost_usd : undefined;
    const subtype = typeof value.subtype === 'string' ? value.subtype : 'success';
    // An error result's text describes the failure; it must never become the stage output.
    const failed = value.is_error === true || subtype.startsWith('error');
    // Errors such as an unknown --resume session are reported only in `errors`.
    const errors = Array.isArray(value.errors) ? value.errors.filter((entry): entry is string => typeof entry === 'string') : [];
    const failure = result || errors.join('; ') || `Claude stopped with ${subtype}.`;
    return {
      terminal: true,
      ...(sessionId ? { sessionId } : {}),
      ...(failed ? { failure } : result ? { text: result } : {}),
      usage: {
        inputTokens: numberAt(usage, 'input_tokens', 'inputTokens'),
        cachedInputTokens: numberAt(usage, 'cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens'),
        outputTokens: numberAt(usage, 'output_tokens', 'outputTokens'),
        reasoningOutputTokens: 0,
        ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
      },
      event: {
        agent: 'claude',
        category: failed ? 'diagnostic' : 'usage',
        message: failed ? `Claude turn failed (${subtype}).` : 'Claude turn completed.',
        raw: value,
      },
    };
  }

  return {
    ...(sessionId ? { sessionId } : {}),
    event: { agent: 'claude', category: type.includes('tool') ? 'tool' : 'lifecycle', message: type, raw: value },
  };
}

export class StreamAccumulator {
  private lastText = '';
  private sessionId?: string;
  private usage: TokenUsage = emptyUsage();
  private eventCount = 0;
  private failure?: string;
  private lastError?: string;

  public add(parsed: ParsedLine | undefined): void {
    if (!parsed) return;
    this.eventCount += 1;
    if (parsed.text) this.lastText = parsed.text;
    if (parsed.sessionId) this.sessionId = parsed.sessionId;
    if (parsed.usage) this.usage = parsed.usage;
    if (parsed.failure) this.failure = parsed.failure;
    if (parsed.error) this.lastError = parsed.error;
  }

  /** The definitive turn failure, if the provider reported one. */
  public failureMessage(): string | undefined {
    return this.failure;
  }

  /** The best provider-reported explanation for a failed process. */
  public errorMessage(): string | undefined {
    return this.failure ?? this.lastError;
  }

  public result(): StageResult {
    return {
      text: this.lastText,
      usage: this.usage,
      rawEventCount: this.eventCount,
      ...(this.sessionId ? { providerSessionId: this.sessionId } : {}),
    };
  }
}
