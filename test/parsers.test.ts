import { describe, expect, it } from 'vitest';

import { parseClaudeLine, parseCodexLine, StreamAccumulator } from '../src/adapters/parsers.js';

describe('provider stream parsers', () => {
  it('parses Codex thread, message, and usage events', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"thr_1"}')?.sessionId).toBe('thr_1');
    const message = parseCodexLine(
      '{"type":"item.completed","item":{"type":"agent_message","text":"review complete"}}',
    );
    expect(message?.text).toBe('review complete');
    const usage = parseCodexLine(
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3,"reasoning_output_tokens":2}}',
    );
    expect(usage?.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 3,
      reasoningOutputTokens: 2,
    });
  });

  it('parses Claude assistant and result events', () => {
    const assistant = parseClaudeLine(
      '{"type":"assistant","session_id":"ses_1","message":{"content":[{"type":"text","text":"working"}]}}',
    );
    expect(assistant?.text).toBe('working');
    const result = parseClaudeLine(
      '{"type":"result","session_id":"ses_1","result":"done","total_cost_usd":0.12,"usage":{"input_tokens":20,"cache_read_input_tokens":5,"output_tokens":4}}',
    );
    expect(result?.text).toBe('done');
    expect(result?.usage?.estimatedCostUsd).toBe(0.12);
  });

  it('ignores non-JSON lines and accumulates the last final text', () => {
    expect(parseCodexLine('plain text')).toBeUndefined();
    const accumulator = new StreamAccumulator();
    accumulator.add(parseClaudeLine('{"type":"assistant","message":{"content":"draft"}}'));
    accumulator.add(parseClaudeLine('{"type":"result","result":"final","usage":{"output_tokens":2}}'));
    expect(accumulator.result()).toMatchObject({ text: 'final', rawEventCount: 2 });
  });

  it('classifies tool, failure, and lifecycle events without inventing final text', () => {
    const tool = parseCodexLine('{"type":"item.completed","item":{"type":"command_execution"}}');
    expect(tool?.event).toMatchObject({ category: 'tool', message: 'Completed command_execution.' });
    const failure = parseCodexLine('{"type":"turn.failed","error":{"message":"broken"}}');
    expect(failure?.event).toMatchObject({ category: 'diagnostic', message: 'broken' });
    const lifecycle = parseClaudeLine('{"type":"system","session_id":"s2"}');
    expect(lifecycle).toMatchObject({ sessionId: 's2', event: { category: 'lifecycle', message: 'system' } });
  });
});

describe('provider failure reporting', () => {
  it('never treats a Claude error result as stage output', () => {
    const parsed = parseClaudeLine(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 500","usage":{"input_tokens":3}}',
    );
    expect(parsed?.text).toBeUndefined();
    expect(parsed?.failure).toBe('API Error: 500');
    expect(parsed?.usage?.inputTokens).toBe(3);
    const accumulator = new StreamAccumulator();
    accumulator.add(parseClaudeLine('{"type":"assistant","message":{"content":"partial"}}'));
    accumulator.add(parsed);
    expect(accumulator.failureMessage()).toBe('API Error: 500');
  });

  it('reports Claude errors that are listed only in the errors array, such as an unknown session', () => {
    const parsed = parseClaudeLine(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: abc"],"usage":{}}',
    );
    expect(parsed?.failure).toBe('No conversation found with session ID: abc');
    expect(parseClaudeLine('{"type":"result","subtype":"error_max_turns","is_error":true}')?.failure).toBe(
      'Claude stopped with error_max_turns.',
    );
  });

  it('separates Codex turn failures from recoverable error events', () => {
    const error = parseCodexLine('{"type":"error","message":"stream disconnected; retrying"}');
    expect(error).toMatchObject({ error: 'stream disconnected; retrying' });
    expect(error?.failure).toBeUndefined();
    const failed = parseCodexLine('{"type":"turn.failed","error":{"message":"usage limit"}}');
    expect(failed?.failure).toBe('usage limit');
    const accumulator = new StreamAccumulator();
    accumulator.add(error);
    expect(accumulator.failureMessage()).toBeUndefined();
    expect(accumulator.errorMessage()).toBe('stream disconnected; retrying');
  });
});
