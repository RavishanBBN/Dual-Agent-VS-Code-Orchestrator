import { execFileSync } from 'node:child_process';
import { copyFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureGitSnapshot, describeGitFailure } from '../src/core/gitSnapshot.js';
import { resolveExecutable } from '../src/core/executables.js';
import { isWindows, removeTemporaryDirectories, temporaryDirectory } from './helpers.js';

afterEach(removeTemporaryDirectories);

const git = resolveExecutable('git');

function run(cwd: string, ...args: string[]): void {
  execFileSync(git, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

async function repository(): Promise<string> {
  const directory = await temporaryDirectory('git');
  run(directory, 'init', '--quiet');
  await writeFile(path.join(directory, 'tracked.txt'), 'original\n');
  run(directory, 'add', 'tracked.txt');
  run(directory, 'commit', '--quiet', '-m', 'initial');
  return directory;
}

describe('captureGitSnapshot', () => {
  it('includes staged and unstaged changes plus readable untracked files', { timeout: 30_000 }, async () => {
    const directory = await repository();
    await writeFile(path.join(directory, 'tracked.txt'), 'changed\n');
    await writeFile(path.join(directory, 'staged.txt'), 'staged content\n');
    run(directory, 'add', 'staged.txt');
    await writeFile(path.join(directory, 'new-module.ts'), 'export const created = true;\n');
    await writeFile(path.join(directory, '.env'), 'API_KEY=secret-value\n');
    await writeFile(path.join(directory, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(directory, 'large.txt'), 'x'.repeat(40 * 1024));

    const snapshot = await captureGitSnapshot(directory);

    expect(snapshot.available).toBe(true);
    expect(snapshot.diff).toContain('+changed');
    expect(snapshot.diff).toContain('+staged content');
    expect(snapshot.status).toContain('new-module.ts');
    const byPath = Object.fromEntries(snapshot.untracked.map((file) => [file.path, file]));
    expect(byPath['new-module.ts']?.content).toContain('created = true');
    expect(byPath['.env']).toEqual({ path: '.env', omitted: 'name suggests a secret' });
    expect(byPath['image.bin']?.omitted).toBe('binary');
    expect(byPath['large.txt']?.omitted).toContain('larger than');
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
  });

  it('describes staged files in a repository without commits', { timeout: 30_000 }, async () => {
    const directory = await temporaryDirectory('git');
    run(directory, 'init', '--quiet');
    await writeFile(path.join(directory, 'first.txt'), 'first file\n');
    run(directory, 'add', 'first.txt');
    const snapshot = await captureGitSnapshot(directory);
    expect(snapshot.available).toBe(true);
    expect(snapshot.diff).toContain('+first file');
  });

  it('reports a folder that is not a repository instead of returning an empty diff silently', async () => {
    const directory = await temporaryDirectory('plain');
    const snapshot = await captureGitSnapshot(directory);
    expect(snapshot.available).toBe(false);
    expect(snapshot.warnings[0]).toContain('not a Git repository');
  });

  it.skipIf(isWindows)('does not follow untracked symbolic links', { timeout: 30_000 }, async () => {
    const directory = await repository();
    const outside = await temporaryDirectory('outside');
    await writeFile(path.join(outside, 'private.txt'), 'private data\n');
    await symlink(path.join(outside, 'private.txt'), path.join(directory, 'link.txt'));
    const snapshot = await captureGitSnapshot(directory);
    expect(snapshot.untracked).toContainEqual({ path: 'link.txt', omitted: 'symbolic link' });
    expect(JSON.stringify(snapshot)).not.toContain('private data');
  });

  it.runIf(isWindows)('never runs a git.exe planted in the workspace', { timeout: 30_000 }, async () => {
    const directory = await repository();
    // whoami.exe prints the user name, so running it instead of Git would be visible in the status.
    await copyFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), path.join(directory, 'git.exe'));
    const hardening = process.env.NoDefaultCurrentDirectoryInExePath;
    // Simulates a normal desktop session, where Windows looks in the current directory first.
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      const snapshot = await captureGitSnapshot(directory);
      expect(snapshot.available).toBe(true);
      expect(snapshot.status).toContain('git.exe');
    } finally {
      if (hardening !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = hardening;
    }
  });
});

describe('describeGitFailure', () => {
  it('explains dubious ownership with the safe.directory remedy', () => {
    const message = describeGitFailure("fatal: detected dubious ownership in repository at 'C:/repo'", 'C:\\repo');
    expect(message).toContain('different user account');
    expect(message).toContain('safe.directory "C:/repo"');
  });
});
