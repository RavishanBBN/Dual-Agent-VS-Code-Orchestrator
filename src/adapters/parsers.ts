import type { AgentActivity, AgentStreamEvent, StageResult, TokenUsage } from '../core/types.js';
import { emptyUsage } from '../core/types.js';

const TITLE_LIMIT = 160;
/** Tool input and output are kept short: they are shown in the chat and stored with the run. */
const INPUT_LIMIT = 600;
const OUTPUT_LIMIT = 1_200;

function clip(value: string, limit: number): string {
  const single = limit === TITLE_LIMIT ? value.replace(/\s+/g, ' ').trim() : value.trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function stringAt(object: JsonObject | undefined, key: string): string {
  const value = object?.[key];
  return typeof value === 'string' ? value : '';
}

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
  /** Further events from the same line, such as one activity per tool call in a Claude message. */
  extraEvents?: AgentStreamEvent[];
  text?: string;
  sessionId?: string;
  /** Model the provider reported for the session. */
  model?: string;
  usage?: TokenUsage;
  terminal?: boolean;
  /** A provider-reported failure of the turn. The stage fails even if the process exits cleanly. */
  failure?: string;
  /** A provider-reported error that may have been recovered from, kept to explain a later failure. */
  error?: string;
}

/** Describes a Codex item other than a message, such as a command it ran or files it changed. */
function codexActivity(item: JsonObject | undefined): AgentActivity | undefined {
  const type = stringAt(item, 'type');
  if (type === 'command_execution') {
    const exitCode = typeof item?.exit_code === 'number' ? item.exit_code : undefined;
    const command = stringAt(item, 'command');
    const output = stringAt(item, 'aggregated_output');
    return {
      kind: 'command',
      tool: 'Shell',
      title: clip(command || 'Ran a command', TITLE_LIMIT),
      ...(command ? { input: clip(command, INPUT_LIMIT) } : {}),
      ...(output || exitCode !== undefined ? { output: clip(`${output}${exitCode ? `\n(exit code ${exitCode})` : ''}`, OUTPUT_LIMIT) } : {}),
      ...(exitCode !== undefined && exitCode !== 0 ? { failed: true } : {}),
    };
  }
  if (type === 'file_change') {
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    const lines = changes
      .map(asObject)
      .map((change) => `${stringAt(change, 'kind') || 'update'} ${stringAt(change, 'path')}`.trim())
      .filter(Boolean);
    return { kind: 'edit', tool: 'Edit', title: clip(lines.map((line) => line.split(' ').slice(1).join(' ')).join(', ') || 'Changed files', TITLE_LIMIT), input: clip(lines.join('\n'), INPUT_LIMIT) };
  }
  if (type === 'reasoning') {
    const text = stringAt(item, 'text');
    return text ? { kind: 'reasoning', tool: 'Thinking', title: clip(text.split('\n')[0] ?? '', TITLE_LIMIT), output: clip(text, OUTPUT_LIMIT) } : undefined;
  }
  if (type === 'web_search') {
    // A search carries its query; opening or reading a result page carries a URL, or nothing at all.
    const action = asObject(item?.action);
    const query = stringAt(item, 'query') || stringAt(action, 'query');
    const url = stringAt(action, 'url');
    const subject = query || url;
    return {
      kind: 'web',
      tool: query ? 'Web search' : 'Web page',
      title: clip(subject || 'Read a search result', TITLE_LIMIT),
      ...(subject ? { input: subject } : {}),
    };
  }
  if (type === 'mcp_tool_call') {
    const name = [stringAt(item, 'server'), stringAt(item, 'tool')].filter(Boolean).join('.');
    return { kind: 'tool', tool: name || 'Tool', title: clip(name, TITLE_LIMIT) };
  }
  return undefined;
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
    const activity = itemType === 'agent_message' ? undefined : codexActivity(item);
    return {
      ...(text && itemType === 'agent_message' ? { text } : {}),
      event: {
        agent: 'codex',
        category: itemType === 'agent_message' ? 'message' : 'tool',
        message: activity?.title ?? (text || `Completed ${itemType}.`),
        raw: value,
        ...(activity ? { activity } : {}),
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

/**
 * Claude reports uncached input, cache reads, and cache writes separately. They are combined so that, as for
 * Codex, input counts every input token and cached input is the part served from the cache.
 */
function claudeUsage(usage: JsonObject | undefined, cost: number | undefined): TokenUsage {
  const read = numberAt(usage, 'cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens');
  const written = numberAt(usage, 'cache_creation_input_tokens');
  return {
    inputTokens: numberAt(usage, 'input_tokens', 'inputTokens') + read + written,
    cachedInputTokens: read,
    outputTokens: numberAt(usage, 'output_tokens', 'outputTokens'),
    reasoningOutputTokens: numberAt(asObject(usage?.output_tokens_details), 'thinking_tokens', 'reasoning_tokens'),
    ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
  };
}

/** An edit's input as a compact diff, so the IN box shows what changed rather than raw JSON. */
function editPreview(input: JsonObject | undefined): string {
  const lines = (prefix: string, text: string): string =>
    text
      .split('\n')
      .slice(0, 6)
      .map((line) => `${prefix} ${line}`)
      .join('\n');
  const old = stringAt(input, 'old_string');
  const next = stringAt(input, 'new_string') || stringAt(input, 'new_source') || stringAt(input, 'content');
  return [old ? lines('-', old) : '', next ? lines('+', next) : ''].filter(Boolean).join('\n');
}

/** Describes one Claude tool call from its name and input, as Claude Code shows it: the tool, then its subject. */
function claudeActivity(name: string, input: JsonObject | undefined, id: string): AgentActivity {
  const file = stringAt(input, 'file_path') || stringAt(input, 'notebook_path') || stringAt(input, 'path');
  const make = (kind: AgentActivity['kind'], title: string, given: string): AgentActivity => ({
    kind,
    tool: name || 'Tool',
    title: clip(title, TITLE_LIMIT),
    ...(given ? { input: clip(given, INPUT_LIMIT) } : {}),
    ...(id ? { id } : {}),
  });
  switch (name) {
    case 'Read':
      return make('read', file, file);
    case 'Grep': {
      const pattern = stringAt(input, 'pattern');
      return make('search', `"${pattern}"${file ? ` in ${file}` : ''}`, [pattern, file, stringAt(input, 'glob')].filter(Boolean).join('  '));
    }
    case 'Glob':
      return make('search', stringAt(input, 'pattern'), [stringAt(input, 'pattern'), file].filter(Boolean).join('  '));
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write':
      return make('edit', file, `${file}\n${editPreview(input)}`.trim());
    case 'Bash':
    case 'PowerShell': {
      const command = stringAt(input, 'command');
      return make('command', stringAt(input, 'description') || command, command);
    }
    case 'WebFetch':
      return make('web', stringAt(input, 'url'), stringAt(input, 'url'));
    case 'WebSearch':
      return make('web', stringAt(input, 'query'), stringAt(input, 'query'));
    default:
      return make('tool', name, input ? JSON.stringify(input, null, 2) : '');
  }
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

  if (type === 'stream_event') {
    // Partial messages: only streamed text is used; complete messages still arrive as `assistant` events.
    const event = asObject(value.event);
    const delta = asObject(event?.delta);
    const text = event?.type === 'content_block_delta' && delta?.type === 'text_delta' ? stringAt(delta, 'text') : '';
    if (!text) return { ...(sessionId ? { sessionId } : {}) };
    return { ...(sessionId ? { sessionId } : {}), event: { agent: 'claude', category: 'message', message: '', delta: text } };
  }

  if (type === 'system' && value.subtype === 'init') {
    const model = stringAt(value, 'model');
    return {
      ...(sessionId ? { sessionId } : {}),
      ...(model ? { model } : {}),
      event: { agent: 'claude', category: 'lifecycle', message: model ? `Claude session started (${model}).` : 'Claude session started.', raw: value },
    };
  }

  if (type === 'assistant') {
    const message = asObject(value.message);
    const text = textContent(message?.content);
    const blocks = Array.isArray(message?.content) ? message.content.map(asObject) : [];
    const activities = blocks
      .filter((block) => block?.type === 'tool_use')
      .map((block) => claudeActivity(stringAt(block, 'name'), asObject(block?.input), stringAt(block, 'id')));
    const extraEvents = activities.map(
      (activity): AgentStreamEvent => ({ agent: 'claude', category: 'tool', message: activity.title, activity }),
    );
    return {
      ...(sessionId ? { sessionId } : {}),
      ...(text ? { text } : {}),
      ...(extraEvents.length ? { extraEvents } : {}),
      event: { agent: 'claude', category: 'message', message: text || 'Claude produced a message.', raw: value },
    };
  }

  if (type === 'user') {
    // Tool results come back as a user message, linked to the call by its ID.
    const message = asObject(value.message);
    const blocks = Array.isArray(message?.content) ? message.content.map(asObject) : [];
    const results = blocks
      .filter((block) => block?.type === 'tool_result' && stringAt(block, 'tool_use_id'))
      .map(
        (block): AgentStreamEvent => ({
          agent: 'claude',
          category: 'tool',
          message: '',
          activityResult: { id: stringAt(block, 'tool_use_id'), output: clip(textContent(block?.content), OUTPUT_LIMIT), failed: block?.is_error === true },
        }),
      );
    const [first, ...rest] = results;
    return { ...(sessionId ? { sessionId } : {}), ...(first ? { event: first } : {}), ...(rest.length ? { extraEvents: rest } : {}) };
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
      usage: claudeUsage(usage, cost),
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
  private model?: string;
  private usage: TokenUsage = emptyUsage();
  private eventCount = 0;
  private failure?: string;
  private lastError?: string;

  public add(parsed: ParsedLine | undefined): void {
    if (!parsed) return;
    this.eventCount += 1;
    if (parsed.text) this.lastText = parsed.text;
    if (parsed.sessionId) this.sessionId = parsed.sessionId;
    if (parsed.model) this.model = parsed.model;
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
      ...(this.model ? { model: this.model } : {}),
    };
  }
}
