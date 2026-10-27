import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runProcess } from '../src/adapters/processRunner.js';
import { AgentExecutionError } from '../src/core/errors.js';
import { isWindows, removeTemporaryDirectories, sleep, temporaryDirectory, writeFakeCli } from './helpers.js';

afterEach(removeTemporaryDirectories);

const node = process.execPath;

/** A parent that starts a long-lived grandchild sharing its pipes, like an agent running a tool. */
function parentWithGrandchild(marker: string, delay: number): string {
  const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), ${delay})`;
  return `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' });
setInterval(() => undefined, 1000);`;
}

async function failure(promise: Promise<unknown>): Promise<AgentExecutionError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AgentExecutionError);
  return error as AgentExecutionError;
}

describe('runProcess', () => {
  it('returns output and the exit code', async () => {
    const result = await runProcess({ command: node, args: ['-e', "console.log('hello')"], cwd: process.cwd(), timeoutMs: 10_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hello\n' });
  });

  it('refuses a command that is not an absolute path', async () => {
    const error = await failure(runProcess({ command: 'node', args: ['-v'], cwd: process.cwd(), timeoutMs: 10_000 }));
    expect(error.kind).toBe('invalid');
  });

  it('does not start a process when the signal is already aborted', async () => {
    const directory = await temporaryDirectory('runner');
    const marker = path.join(directory, 'started.txt');
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      runProcess({
        command: node,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        cwd: directory,
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    );
    expect(error.kind).toBe('cancelled');
    await sleep(500);
    expect(existsSync(marker)).toBe(false);
  });

  it('classifies failures from stderr, never from output that may contain repository text', async () => {
    const script = `console.log('AbortController timeoutMs usage limit 429 not found');
console.error('Error: 401 Unauthorized');
process.exit(1);`;
    const error = await failure(runProcess({ command: node, args: ['-e', script], cwd: process.cwd(), timeoutMs: 10_000 }));
    expect(error.kind).toBe('authentication');
    expect(error.message).not.toContain('AbortController');
  });

  it('keeps only the most recent output', async () => {
    const script = "for (let i = 0; i < 20000; i += 1) console.log('line ' + i)";
    const result = await runProcess({
      command: node,
      args: ['-e', script],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      captureLimit: 1_000,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stdout).toContain('line 19999');
  });

  it('survives a process that exits before reading its input', async () => {
    const error = await failure(
      runProcess({ command: node, args: ['-e', 'process.exit(3)'], cwd: process.cwd(), input: 'x'.repeat(4_000_000), timeoutMs: 10_000 }),
    );
    expect(error.exitCode).toBe(3);
  });

  it('times out and stops the process', async () => {
    const error = await failure(
      runProcess({ command: node, args: ['-e', 'setInterval(() => undefined, 1000)'], cwd: process.cwd(), timeoutMs: 300 }),
    );
    expect(error.kind).toBe('timeout');
  });

  it('cancellation terminates descendants, not just the direct child', { timeout: 20_000 }, async () => {
    const directory = await temporaryDirectory('runner');
    const marker = path.join(directory, 'grandchild.txt');
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 500);
    const error = await failure(
      runProcess({ command: node, args: ['-e', parentWithGrandchild(marker, 2_500)], cwd: directory, timeoutMs: 30_000, signal: controller.signal }),
    );
    expect(error.kind).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(2_400);
    await sleep(3_000);
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(isWindows)('cancellation stops an agent launched through a .cmd shim', { timeout: 20_000 }, async () => {
    const directory = await temporaryDirectory('runner');
    const marker = path.join(directory, 'agent.txt');
    const shim = await writeFakeCli(
      directory,
      'slowagent',
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'still editing'), 2500);`,
    );
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 500);
    const error = await failure(runProcess({ command: shim, args: [], cwd: directory, timeoutMs: 30_000, signal: controller.signal }));
    expect(error.kind).toBe('cancelled');
    // Before the fix only cmd.exe died, and the promise waited for the agent to finish on its own.
    expect(Date.now() - started).toBeLessThan(2_400);
    await sleep(3_000);
    expect(existsSync(marker)).toBe(false);
  });
});
