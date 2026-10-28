import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeTargets, reachable } from '../src/adapters/connectivity.js';
import { LocalUsageScanner } from '../src/adapters/localUsage.js';
import { AgentExecutionError, canFallback, classifyFailure } from '../src/core/errors.js';
import { AgentLimits } from '../src/core/limits.js';
import { localDay } from '../src/core/usage.js';
import { ContinuationScheduler, NETWORK_RETRY_MS } from '../src/ui/continuations.js';
import { machineUsage } from '../src/ui/chat/transcript.js';
import { removeTemporaryDirectories, temporaryDirectory } from './helpers.js';

afterEach(removeTemporaryDirectories);

describe('lost connections', () => {
  it('recognizes what Claude Code, Codex, and Node report when the connection fails', () => {
    for (const message of [
      'API Error: Connection error.',
      'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
      'getaddrinfo ENOTFOUND api.anthropic.com',
      'connect ECONNREFUSED 127.0.0.1:443',
      'TypeError: fetch failed',
      'dns error: failed to lookup address information',
    ]) {
      expect(classifyFailure(message), message).toBe('network');
    }
    expect(classifyFailure('Stage timed out after 30 minutes')).toBe('timeout');
    expect(classifyFailure("You've hit your session limit · resets 5pm")).toBe('quota');
    // Online, a connection error is one provider's outage, which the other agent can cover.
    expect(canFallback(new AgentExecutionError('API Error: Connection error.', 'network'))).toBe(true);
  });

  it('probes a host by opening a connection, and goes through a configured proxy', async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      expect(await reachable([{ host: '127.0.0.1', port }])).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await reachable([{ host: '127.0.0.1', port }], 1_000)).toBe(false);
    expect(probeTargets({ HTTPS_PROXY: 'http://proxy.example:3128' })).toEqual([{ host: 'proxy.example', port: 3128 }]);
    expect(probeTargets({}).map((target) => target.host)).toContain('api.anthropic.com');
  });

  it('checks a run waiting for the network again every 15 seconds', async () => {
    vi.useFakeTimers();
    try {
      let now = Date.parse('2026-10-28T12:00:00Z');
      const fire = vi.fn(async (): Promise<'retry' | 'done'> => (fire.mock.calls.length < 2 ? 'retry' : 'done'));
      const scheduler = new ContinuationScheduler([], () => undefined, fire, () => now);
      scheduler.schedule({ runId: 'r1', at: new Date(now + 1_000).toISOString(), commands: '', network: true });
      now += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fire).toHaveBeenCalledTimes(1);
      expect(Date.parse(scheduler.get('r1')?.at ?? '') - now).toBe(NETWORK_RETRY_MS);
      now += NETWORK_RETRY_MS;
      await vi.advanceTimersByTimeAsync(NETWORK_RETRY_MS);
      expect(fire).toHaveBeenCalledTimes(2);
      expect(scheduler.get('r1')).toBeUndefined();
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('limits from account readings', () => {
  it('sets an agent aside until a reached or all but used-up window resets, and ignores the rest', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const limits = new AgentLimits([], () => now);
    const later = '2026-10-28T15:00:00.000Z';
    expect(limits.observe({ agent: 'codex', windows: [{ name: 'five_hour', usedPercent: 60, resetsAt: later }], limited: false, observedAt: '' })).toBeUndefined();
    expect(limits.observe({ agent: 'codex', windows: [{ name: 'five_hour', usedPercent: 99, resetsAt: later }], limited: false, observedAt: '' })?.until).toBe(later);
    // A limit whose reset has already passed says nothing about now.
    expect(limits.observe({ agent: 'claude', windows: [], limited: true, resetsAt: '2026-10-28T11:00:00.000Z', observedAt: '' })).toBeUndefined();
    expect(limits.active('claude')).toBeUndefined();
  });
});

describe('usage on this machine', () => {
  const now = new Date();
  const at = (minutesAgo: number): string => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  async function homes(): Promise<{ claude: string; codex: string; claudeFile: string; codexFile: string }> {
    const root = await temporaryDirectory('local-usage');
    const claude = path.join(root, '.claude');
    const codex = path.join(root, '.codex');
    const project = path.join(claude, 'projects', 'f--Work');
    await mkdir(path.join(project, 'session-1', 'subagents'), { recursive: true });
    const day = path.join(codex, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    await mkdir(day, { recursive: true });
    const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 50 };
    const claudeFile = path.join(project, 'session-1.jsonl');
    await writeFile(
      claudeFile,
      [
        JSON.stringify({ type: 'user', timestamp: at(5), message: { content: 'a private question' } }),
        // One message written as two content blocks, each with the message's usage, counts once.
        JSON.stringify({ type: 'assistant', timestamp: at(4), requestId: 'req_1', message: { id: 'msg_1', usage, content: [{ type: 'text', text: 'secret' }] } }),
        JSON.stringify({ type: 'assistant', timestamp: at(4), requestId: 'req_1', message: { id: 'msg_1', usage, content: [{ type: 'tool_use' }] } }),
        '{"type":"assistant","usage" this line is cut',
      ].join('\n') + '\n',
    );
    await writeFile(
      path.join(project, 'session-1', 'subagents', 'agent-a1.jsonl'),
      JSON.stringify({ type: 'assistant', timestamp: at(3), requestId: 'req_2', message: { id: 'msg_2', usage: { input_tokens: 5, output_tokens: 5 } } }) + '\n',
    );
    const limits = { primary: { used_percent: 40, window_minutes: 300, resets_at: Math.round(now.getTime() / 1000) + 3_600 }, secondary: { used_percent: 10, window_minutes: 10_080 } };
    const total = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: input / 2, output_tokens: output, reasoning_output_tokens: 0 });
    const codexFile = path.join(day, 'rollout-2026-10-28T10-00-00-01a18293-75f3-7921-a048-13110c5e8d2a.jsonl');
    await writeFile(
      codexFile,
      [
        JSON.stringify({ timestamp: at(30), type: 'session_meta', payload: { cwd: '/private' } }),
        JSON.stringify({ timestamp: at(20), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total(1_000, 100) }, rate_limits: limits } }),
        // Codex repeats its running total; only growth counts.
        JSON.stringify({ timestamp: at(19), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total(1_000, 100) }, rate_limits: limits } }),
        JSON.stringify({ timestamp: at(10), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total(3_000, 300) }, rate_limits: limits } }),
      ].join('\n') + '\n',
    );
    return { claude, codex, claudeFile, codexFile };
  }

  it('counts every message once, including subagents, from both CLIs\' logs', async () => {
    const { claude, codex } = await homes();
    const report = await new LocalUsageScanner({ claude, codex }).scan();
    const today = localDay(now);
    expect(report.claude[today]).toEqual({ inputTokens: 1_115, cachedInputTokens: 1_000, outputTokens: 55, reasoningOutputTokens: 0 });
    expect(report.codex[today]).toEqual({ inputTokens: 3_000, cachedInputTokens: 1_500, outputTokens: 300, reasoningOutputTokens: 0 });
    expect(report.quotas).toHaveLength(1);
    expect(report.quotas[0]).toMatchObject({ agent: 'codex', limited: false });
    expect(report.quotas[0]?.windows.find((window) => window.name === 'five_hour')?.usedPercent).toBe(40);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(JSON.stringify(report)).not.toContain('private');
  });

  it('reads only what was appended, and finds a usage limit Claude reported in a terminal', async () => {
    const { claude, codex, claudeFile, codexFile } = await homes();
    const scanner = new LocalUsageScanner({ claude, codex });
    await scanner.scan();
    await appendFile(
      claudeFile,
      JSON.stringify({ type: 'assistant', timestamp: at(1), isApiErrorMessage: true, message: { id: 'err', content: [{ type: 'text', text: "You've hit your session limit · resets in 2 hours" }] } }) + '\n',
    );
    await appendFile(codexFile, JSON.stringify({ timestamp: at(0), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 3_500, output_tokens: 320 } } } }) + '\n');
    const report = await scanner.scan();
    const today = localDay(now);
    expect(report.claude[today]?.outputTokens).toBe(55);
    expect(report.codex[today]?.inputTokens).toBe(3_500);
    const limit = report.quotas.find((reading) => reading.agent === 'claude');
    expect(limit?.limited).toBe(true);
    expect(Date.parse(limit?.resetsAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('adds up today and the last seven days for the usage panel', () => {
    const today = localDay(now);
    const old = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3));
    const tokens = (input: number) => ({ inputTokens: input, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 });
    const [day, week] = machineUsage({ claude: { [today]: tokens(10), [old]: tokens(5) }, codex: { [old]: tokens(7) } }, now);
    expect(day).toMatchObject({ label: 'Today', runs: 1, usage: { claude: { input: 10 }, codex: { input: 0 } } });
    expect(week).toMatchObject({ label: 'Last 7 days', runs: 2, usage: { claude: { input: 15 }, codex: { input: 7 } } });
  });
});
