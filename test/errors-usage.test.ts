import { describe, expect, it } from 'vitest';

import { AgentExecutionError, canFallback, classifyFailure } from '../src/core/errors.js';
import { addUsage } from '../src/core/usage.js';

describe('failure classification', () => {
  it.each([
    ['usage limit reached', 'quota'],
    ['401 unauthorized', 'authentication'],
    ['command not found', 'unavailable'],
    ['timed out', 'timeout'],
    ['request cancelled', 'cancelled'],
    ['400 unsupported option', 'invalid'],
    ['unexpected', 'unknown'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(classifyFailure(message)).toBe(expected);
  });

  it('falls back only for bounded operational failures', () => {
    expect(canFallback(new AgentExecutionError('limit', 'quota'))).toBe(true);
    expect(canFallback(new AgentExecutionError('bad input', 'invalid'))).toBe(false);
    expect(canFallback(new Error('generic'))).toBe(false);
  });
});

describe('usage aggregation', () => {
  it('adds tokens and optional reported cost', () => {
    expect(
      addUsage(
        { inputTokens: 2, cachedInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 1, estimatedCostUsd: 0.1 },
        { inputTokens: 5, cachedInputTokens: 2, outputTokens: 7, reasoningOutputTokens: 4, estimatedCostUsd: 0.2 },
      ),
    ).toEqual({
      inputTokens: 7,
      cachedInputTokens: 3,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      estimatedCostUsd: 0.30000000000000004,
    });
  });
});

describe('failure classification boundaries', () => {
  it.each([
    ['new AbortController()', 'unknown'],
    ['timeoutMs exceeded the budget', 'unknown'],
    ['file not found: src/a.ts', 'unknown'],
    ['Request timed out', 'timeout'],
    ['Operation aborted by user', 'cancelled'],
    ['rate_limit_error', 'quota'],
    ['codex was not found on PATH. Install it or configure an absolute path.', 'unavailable'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(classifyFailure(message)).toBe(expected);
  });

  it('caps long error details and keeps the end', () => {
    const error = new AgentExecutionError(`${'x'.repeat(5_000)} final cause`, 'unknown');
    expect(error.message.length).toBeLessThan(2_100);
    expect(error.message).toContain('final cause');
  });
});
