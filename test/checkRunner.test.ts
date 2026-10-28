import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runChecks, type CheckRunnerConfiguration } from '../src/adapters/checkRunner.js';
import { removeTemporaryDirectories, temporaryDirectory, writeFakeCli } from './helpers.js';

afterEach(removeTemporaryDirectories);

const configuration: CheckRunnerConfiguration = { timeoutMs: 15_000, billingMode: 'subscription' };

async function layout(): Promise<{ bin: string; workspace: string }> {
  const root = await temporaryDirectory('checks');
  const bin = path.join(root, 'bin');
  const workspace = path.join(root, 'workspace');
  await mkdir(bin);
  await mkdir(workspace);
  return { bin, workspace };
}

const request = (workspace: string, commands: string[][], signal = new AbortController().signal) => ({
  commands,
  cwd: workspace,
  signal,
  untrustedDirectories: [workspace],
});

describe('runChecks', () => {
  it('records exit codes and combined output, and stops at the first failure', { timeout: 30_000 }, async () => {
    const { bin, workspace } = await layout();
    const pass = await writeFakeCli(bin, 'passing', `console.log('cwd=' + process.cwd()); console.error('warn line');`);
    const fail = await writeFakeCli(bin, 'failing', `console.log('1 test failed'); process.exit(3);`);
    const never = await writeFakeCli(bin, 'never', `console.log('should not run');`);
    const lines: string[] = [];

    const results = await runChecks(configuration, { ...request(workspace, [[pass, '--flag'], [fail], [never]]), onLine: (line) => lines.push(line) });

    expect(results.map((result) => result.exitCode)).toEqual([0, 3]);
    expect(results[0]?.output).toContain(`cwd=${workspace}`);
    expect(results[0]?.output).toContain('warn line');
    expect(results[0]?.command).toEqual([pass, '--flag']);
    expect(results[1]?.output).toContain('1 test failed');
    expect(lines).toContain('1 test failed');
  });

  it('reports a command it cannot find or must not run instead of throwing', { timeout: 30_000 }, async () => {
    const { workspace } = await layout();
    const planted = await writeFakeCli(workspace, 'planted', `console.log('ran');`);

    const [missing] = await runChecks(configuration, request(workspace, [['dual-agent-no-such-command']]));
    const [refused] = await runChecks(configuration, request(workspace, [[planted]]));

    expect(missing).toMatchObject({ exitCode: -1, output: '' });
    expect(missing?.error).toContain('not found');
    expect(refused?.error).toContain('inside the workspace');
  });

  it('records a timeout as a failed check', { timeout: 30_000 }, async () => {
    const { bin, workspace } = await layout();
    const slow = await writeFakeCli(bin, 'slow', `console.log('started'); setTimeout(() => {}, 60000);`);
    const [result] = await runChecks({ ...configuration, timeoutMs: 1_000 }, request(workspace, [[slow]]));
    expect(result?.timedOut).toBe(true);
    expect(result?.output).toContain('started');
  });

  it('propagates cancellation so the run stops', { timeout: 30_000 }, async () => {
    const { bin, workspace } = await layout();
    const slow = await writeFakeCli(bin, 'slow', `setTimeout(() => {}, 60000);`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await expect(runChecks(configuration, request(workspace, [[slow]], controller.signal))).rejects.toThrow('cancelled');
  });
});
