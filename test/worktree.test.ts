import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveExecutable } from '../src/core/executables.js';
import { checkGit } from '../src/core/git.js';
import { captureGitSnapshot } from '../src/core/gitSnapshot.js';
import {
  applyWorktree,
  checkpointWorktree,
  createWorktree,
  listWorktreeChanges,
  readBaseFile,
  removeWorktree,
  restoreWorktree,
  worktreeExists,
  WorktreeError,
} from '../src/core/worktree.js';
import { isWindows, removeTemporaryDirectories, temporaryDirectory } from './helpers.js';

afterEach(removeTemporaryDirectories);

const git = resolveExecutable('git');
const TIMEOUT = { timeout: 60_000 };

function run(cwd: string, ...args: string[]): string {
  return execFileSync(git, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

/** A repository with one commit, plus a separate directory standing in for the extension's storage. */
async function repository(autocrlf = false): Promise<{ repo: string; storage: string }> {
  const root = await temporaryDirectory('worktree');
  const repo = path.join(root, 'repo');
  const storage = path.join(root, 'storage');
  await mkdir(repo);
  run(repo, 'init', '--quiet');
  run(repo, 'config', 'core.autocrlf', String(autocrlf));
  await writeFile(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
  await writeFile(path.join(repo, 'remove-me.txt'), 'obsolete\n');
  await writeFile(path.join(repo, '.gitignore'), 'ignored/\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '--quiet', '-m', 'initial');
  return { repo, storage };
}

/** Installs hooks that leave a marker file if Git ever runs them. */
async function plantHooks(repo: string): Promise<string> {
  const marker = path.join(path.dirname(repo), 'hook-ran');
  const script = `#!/bin/sh\necho "$0" >> "${marker.replace(/\\/g, '/')}"\n`;
  for (const hook of ['post-checkout', 'reference-transaction', 'post-commit', 'post-index-change']) {
    const file = path.join(repo, '.git', 'hooks', hook);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }
  return marker;
}

describe('isolated worktrees', () => {
  it('copies the workspace as it is, including uncommitted and untracked work, without touching the repository', TIMEOUT, async () => {
    const { repo, storage } = await repository();
    await writeFile(path.join(repo, 'tracked.txt'), 'one\nTWO (uncommitted)\nthree\n');
    await writeFile(path.join(repo, 'notes.md'), 'untracked notes\n');
    await writeFile(path.join(repo, '.env'), 'TOKEN=secret\n');
    await mkdir(path.join(repo, 'ignored'));
    await writeFile(path.join(repo, 'ignored', 'cache.bin'), 'cache');
    const statusBefore = run(repo, 'status', '--porcelain');
    const headBefore = run(repo, 'rev-parse', 'HEAD');

    const { info, warnings } = await createWorktree(repo, path.join(storage, 'run-1'));

    expect(await readFile(path.join(info.workingDirectory, 'tracked.txt'), 'utf8')).toContain('TWO (uncommitted)');
    expect(await readFile(path.join(info.workingDirectory, 'notes.md'), 'utf8')).toBe('untracked notes\n');
    expect(existsSync(path.join(info.workingDirectory, '.env'))).toBe(false);
    expect(existsSync(path.join(info.workingDirectory, 'ignored'))).toBe(false);
    expect(warnings[0]).toContain('.env (name suggests a secret)');
    // Agents start from a clean diff: the user's own changes are part of the base, not of the review.
    const snapshot = await captureGitSnapshot(info.workingDirectory);
    expect(snapshot).toMatchObject({ available: true, diff: '', status: '' });
    expect(await worktreeExists(info)).toBe(true);
    // The user's repository is exactly as it was.
    expect(run(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(run(repo, 'stash', 'list')).toBe('');
  });

  it('lists, shows, and applies the agents\' changes to the working tree only', TIMEOUT, async () => {
    const { repo, storage } = await repository();
    const { info } = await createWorktree(repo, path.join(storage, 'run-2'));
    await writeFile(path.join(info.path, 'tracked.txt'), 'one\ntwo\nthree\nfour\n');
    await writeFile(path.join(info.path, 'added.ts'), 'export const added = 1;\n');
    await rm(path.join(info.path, 'remove-me.txt'));

    const changes = await listWorktreeChanges(info);
    expect(changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'added.ts', status: 'added', symlink: false },
      { path: 'remove-me.txt', status: 'deleted', symlink: false },
      { path: 'tracked.txt', status: 'modified', symlink: false },
    ]);
    expect(await readBaseFile(info, 'tracked.txt')).toBe('one\ntwo\nthree\n');
    expect(await readBaseFile(info, 'added.ts')).toBe('');

    await applyWorktree(info);

    expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour\n');
    expect(await readFile(path.join(repo, 'added.ts'), 'utf8')).toBe('export const added = 1;\n');
    expect(existsSync(path.join(repo, 'remove-me.txt'))).toBe(false);
    // Nothing is staged: the user reviews and commits.
    expect(run(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('puts the worktree back to a checkpoint, undoing later edits, additions, and deletions but not ignored files', TIMEOUT, async () => {
    const { repo, storage } = await repository();
    const { info } = await createWorktree(repo, path.join(storage, 'run-checkpoint'));
    await writeFile(path.join(info.path, 'tracked.txt'), 'first edit\n');
    await writeFile(path.join(info.path, 'first.ts'), 'first\n');
    const checkpoint = await checkpointWorktree(info);

    await writeFile(path.join(info.path, 'tracked.txt'), 'second edit\n');
    await writeFile(path.join(info.path, 'second.ts'), 'second\n');
    await rm(path.join(info.path, 'remove-me.txt'));
    await mkdir(path.join(info.path, 'ignored'));
    await writeFile(path.join(info.path, 'ignored', 'cache.bin'), 'cache');

    await restoreWorktree(info, checkpoint);

    expect(await readFile(path.join(info.path, 'tracked.txt'), 'utf8')).toBe('first edit\n');
    expect(await readFile(path.join(info.path, 'first.ts'), 'utf8')).toBe('first\n');
    expect(await readFile(path.join(info.path, 'remove-me.txt'), 'utf8')).toBe('obsolete\n');
    expect(existsSync(path.join(info.path, 'second.ts'))).toBe(false);
    expect(existsSync(path.join(info.path, 'ignored', 'cache.bin'))).toBe(true);
    expect((await listWorktreeChanges(info)).map((change) => change.path).sort()).toEqual(['first.ts', 'tracked.txt']);
    await expect(restoreWorktree(info, '--orphan')).rejects.toThrow('not a valid Git tree');
  });

  it('refuses to apply over conflicting workspace edits and leaves the workspace untouched', TIMEOUT, async () => {
    const { repo, storage } = await repository();
    const { info } = await createWorktree(repo, path.join(storage, 'run-3'));
    await writeFile(path.join(info.path, 'tracked.txt'), 'one\nagent edit\nthree\n');
    await writeFile(path.join(info.path, 'added.ts'), 'export {};\n');
    await writeFile(path.join(repo, 'tracked.txt'), 'one\nuser edit\nthree\n');

    const error = await applyWorktree(info).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).message).toContain('do not apply cleanly');
    expect((error as WorktreeError).detail).toContain('tracked.txt');
    expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('one\nuser edit\nthree\n');
    // The patch is checked as a whole, so even the non-conflicting file was not written.
    expect(existsSync(path.join(repo, 'added.ts'))).toBe(false);
  });

  it('never runs repository hooks, which an agent with write access could plant', TIMEOUT, async () => {
    const { repo, storage } = await repository();
    const marker = await plantHooks(repo);

    const { info } = await createWorktree(repo, path.join(storage, 'run-4'));
    await writeFile(path.join(info.path, 'tracked.txt'), 'changed\n');
    await listWorktreeChanges(info);
    await applyWorktree(info);
    await removeWorktree(info, storage);
    expect(existsSync(marker)).toBe(false);

    // Control: the same hooks do run for a plain Git command, so the check above is meaningful.
    run(repo, 'worktree', 'add', '--quiet', '--detach', path.join(storage, 'control'), 'HEAD');
    expect(existsSync(marker)).toBe(true);
  });

  it('applies cleanly in a repository that checks files out with CRLF line endings', TIMEOUT, async () => {
    const { repo, storage } = await repository(true);
    // Re-checkout so the working tree really has CRLF endings.
    await rm(path.join(repo, 'tracked.txt'));
    run(repo, 'checkout', '--', 'tracked.txt');
    const { info } = await createWorktree(repo, path.join(storage, 'run-5'));
    const edited = (await readFile(path.join(info.path, 'tracked.txt'), 'utf8')).replace('two', 'TWO');
    await writeFile(path.join(info.path, 'tracked.txt'), edited);

    await applyWorktree(info);

    const result = await readFile(path.join(repo, 'tracked.txt'), 'utf8');
    expect(result.replace(/\r\n/g, '\n')).toBe('one\nTWO\nthree\n');
    if (isWindows) expect(result).toContain('\r\n');
  });

  it('maps a workspace folder inside a larger repository to the same folder in the worktree', TIMEOUT, async () => {
    const { repo, storage } = await repository();
    await mkdir(path.join(repo, 'packages', 'app'), { recursive: true });
    await writeFile(path.join(repo, 'packages', 'app', 'index.ts'), 'export {};\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '--quiet', '-m', 'app');

    const { info } = await createWorktree(path.join(repo, 'packages', 'app'), path.join(storage, 'run-6'));

    expect(path.resolve(info.repositoryRoot)).toBe(path.resolve(execFileSync(git, ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()));
    expect(path.relative(info.path, info.workingDirectory)).toBe(path.join('packages', 'app'));
    expect(existsSync(path.join(info.workingDirectory, 'index.ts'))).toBe(true);
  });

  it('removes a worktree and its registration, but never a path outside the extension storage', TIMEOUT, async () => {
    const { repo, storage } = await repository();
    const { info } = await createWorktree(repo, path.join(storage, 'run-7'));

    await expect(removeWorktree({ ...info, path: repo }, storage)).rejects.toThrow('outside the extension');
    await expect(removeWorktree({ ...info, path: storage }, storage)).rejects.toThrow('outside the extension');
    expect(existsSync(path.join(repo, 'tracked.txt'))).toBe(true);

    await removeWorktree(info, storage);
    expect(existsSync(info.path)).toBe(false);
    expect(await worktreeExists(info)).toBe(false);
    expect(run(repo, 'worktree', 'list')).not.toContain('run-7');
  });

  it('explains that a repository needs a commit first', TIMEOUT, async () => {
    const root = await temporaryDirectory('empty-repo');
    run(root, 'init', '--quiet');
    await expect(createWorktree(root, path.join(root, '..', `${path.basename(root)}-wt`))).rejects.toThrow('at least one commit');
  });
});

describe('checkGit', () => {
  it('reports Git and whether the workspace is a repository', TIMEOUT, async () => {
    const { repo } = await repository();
    expect(await checkGit(repo)).toMatchObject({ available: true, repository: true });
    const plain = await temporaryDirectory('plain');
    const health = await checkGit(plain);
    expect(health).toMatchObject({ available: true, repository: false });
    expect(health.detail).toContain('not a Git repository');
  });
});
