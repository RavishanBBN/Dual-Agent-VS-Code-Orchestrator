import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCodexQuota } from '../src/adapters/cliAdapters.js';
import { claudeQuota, codexQuota, parseClaudeLine, StreamAccumulator } from '../src/adapters/parsers.js';
import { removeTemporaryDirectories, temporaryDirectory } from './helpers.js';

afterEach(removeTemporaryDirectories);

const NOW = new Date('2026-10-28T12:30:00Z');

// The shapes below are the CLIs' own output, captured from Claude Code 2.1.312 and Codex 0.165.0.
const claudeEvent = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1793202000,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: 1793202000, status: 'allowed' } },
  },
  session_id: 's1',
};
const codexLimits = {
  limit_id: 'codex',
  primary: { used_percent: 44, window_minutes: 300, resets_at: 1793207010 },
  secondary: { used_percent: 22, window_minutes: 10080, resets_at: 1793774111 },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  plan_type: 'plus',
  rate_limit_reached_type: null,
};

describe('reading the accounts\' usage limits', () => {
  it('reads Claude\'s rate-limit event from the stream, and carries it to the stage result', () => {
    const parsed = parseClaudeLine(JSON.stringify(claudeEvent));
    expect(parsed?.quota).toMatchObject({
      agent: 'claude',
      limited: false,
      windows: [{ name: 'five_hour', usedPercent: 60, resetsAt: new Date(1793202000 * 1000).toISOString() }],
    });
    expect(parsed?.event?.quota).toBe(parsed?.quota);
    const accumulator = new StreamAccumulator();
    accumulator.add(parsed);
    expect(accumulator.result().quota?.windows[0]?.usedPercent).toBe(60);
    // A rejected status means the limit is reached until the reset.
    expect(claudeQuota({ ...claudeEvent.rate_limit_info, status: 'rejected' })?.limited).toBe(true);
  });

  it('reads Codex\'s five-hour and weekly windows, and knows when one is used up', () => {
    expect(codexQuota(codexLimits, NOW)).toEqual({
      agent: 'codex',
      windows: [
        { name: 'five_hour', usedPercent: 44, resetsAt: new Date(1793207010 * 1000).toISOString() },
        { name: 'weekly', usedPercent: 22, resetsAt: new Date(1793774111 * 1000).toISOString() },
      ],
      limited: false,
      plan: 'plus',
      observedAt: NOW.toISOString(),
    });
    const weeklyOut = codexQuota({ ...codexLimits, secondary: { ...codexLimits.secondary, used_percent: 100 }, rate_limit_reached_type: 'secondary' }, NOW);
    expect(weeklyOut).toMatchObject({ limited: true, resetsAt: new Date(1793774111 * 1000).toISOString() });
  });

  it('finds the run\'s own Codex session log, and nothing else', async () => {
    const home = await temporaryDirectory('codex-home');
    const thread = '01a18293-75f3-7921-a048-13110c5e8d2a';
    const folder = path.join(home, 'sessions', '2026', '10', String(NOW.getDate()).padStart(2, '0'));
    await mkdir(folder, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: {} }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: codexLimits } }),
      '{"type":"event_msg","payload":{"type":"task_comp',
    ];
    await writeFile(path.join(folder, `rollout-2026-10-28T18-24-29-${thread}.jsonl`), lines.join('\n'));
    expect((await readCodexQuota(thread, home, NOW))?.windows.map((window) => window.usedPercent)).toEqual([44, 22]);
    expect(await readCodexQuota('../../secrets', home, NOW)).toBeUndefined();
    expect(await readCodexQuota('01a18293-75f3-7921-a048-000000000000', home, NOW)).toBeUndefined();
  });
});
