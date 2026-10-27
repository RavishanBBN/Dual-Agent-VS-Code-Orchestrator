import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GitSnapshot } from './types.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    return error instanceof Error ? `[git unavailable: ${error.message}]` : '[git unavailable]';
  }
}

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const [status, diff, diffStat] = await Promise.all([
    git(cwd, ['status', '--short']),
    git(cwd, ['diff', '--no-ext-diff', '--unified=3']),
    git(cwd, ['diff', '--stat']),
  ]);
  return { status, diff, diffStat };
}
