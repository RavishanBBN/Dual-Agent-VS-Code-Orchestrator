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
    expect(tool?.event).toMatchObject({ category: 'tool', message: 'Ran a command', activity: { kind: 'command', tool: 'Shell', title: 'Ran a command' } });
    const failure = parseCodexLine('{"type":"turn.failed","error":{"message":"broken"}}');
    expect(failure?.event).toMatchObject({ category: 'diagnostic', message: 'broken' });
    const lifecycle = parseClaudeLine('{"type":"system","session_id":"s2"}');
    expect(lifecycle).toMatchObject({ sessionId: 's2', event: { category: 'lifecycle', message: 'system' } });
  });
});

describe('streamed text and agent activity', () => {
  it('streams Claude text deltas without treating them as the final text', () => {
    const delta = parseClaudeLine(
      '{"type":"stream_event","session_id":"s1","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}',
    );
    expect(delta).toMatchObject({ sessionId: 's1', event: { category: 'message', delta: 'Hel' } });
    expect(delta?.text).toBeUndefined();
    // Thinking and other partial events carry nothing to show.
    expect(parseClaudeLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}}')?.event).toBeUndefined();
  });

  it('records the model Claude reports and describes each tool call', () => {
    const init = parseClaudeLine('{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-5-5","tools":["Read"]}');
    expect(init).toMatchObject({ model: 'claude-opus-5-5', event: { category: 'lifecycle' } });
    const assistant = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/math.js' } },
            { type: 'tool_use', id: 'toolu_2', name: 'Grep', input: { pattern: 'average', path: 'src' } },
            { type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
            { type: 'tool_use', id: 'toolu_4', name: 'Edit', input: { file_path: 'a.js', old_string: 'x = 1', new_string: 'x = 2' } },
          ],
        },
      }),
    );
    expect(assistant?.extraEvents?.map((event) => event.activity)).toEqual([
      { kind: 'read', tool: 'Read', title: 'src/math.js', input: 'src/math.js', id: 'toolu_1' },
      { kind: 'search', tool: 'Grep', title: '"average" in src', input: 'average  src', id: 'toolu_2' },
      // Shown as Claude Code does: the command's description, with the command itself as input.
      { kind: 'command', tool: 'Bash', title: 'Run the tests', input: 'npm test', id: 'toolu_3' },
      { kind: 'edit', tool: 'Edit', title: 'a.js', input: 'a.js\n- x = 1\n+ x = 2', id: 'toolu_4' },
    ]);
    const result = parseClaudeLine(
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: [{ type: 'text', text: '2 passing' }], is_error: false }] } }),
    );
    expect(result?.event?.activityResult).toEqual({ id: 'toolu_3', output: '2 passing', failed: false });
    const accumulator = new StreamAccumulator();
    accumulator.add(init);
    accumulator.add(parseClaudeLine('{"type":"result","result":"done","usage":{}}'));
    expect(accumulator.result()).toMatchObject({ text: 'done', model: 'claude-opus-5-5' });
  });

  it('describes Codex commands, file changes, reasoning, and searches', () => {
    const command = parseCodexLine(
      '{"type":"item.completed","item":{"type":"command_execution","command":"node --test","aggregated_output":"1 failing","exit_code":1}}',
    );
    expect(command?.event?.activity).toEqual({
      kind: 'command',
      tool: 'Shell',
      title: 'node --test',
      input: 'node --test',
      output: '1 failing\n(exit code 1)',
      failed: true,
    });
    const change = parseCodexLine('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.js","kind":"update"},{"path":"b.js","kind":"add"}]}}');
    expect(change?.event?.activity).toEqual({ kind: 'edit', tool: 'Edit', title: 'a.js, b.js', input: 'update a.js\nadd b.js' });
    const reasoning = parseCodexLine('{"type":"item.completed","item":{"type":"reasoning","text":"Comparing the two\\nmore detail"}}');
    expect(reasoning?.event?.activity).toMatchObject({ kind: 'reasoning', tool: 'Thinking', title: 'Comparing the two' });
    const search = parseCodexLine('{"type":"item.completed","item":{"type":"web_search","query":"pdf.js worker"}}');
    expect(search?.event?.activity).toMatchObject({ kind: 'web', tool: 'Web search', title: 'pdf.js worker' });
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
