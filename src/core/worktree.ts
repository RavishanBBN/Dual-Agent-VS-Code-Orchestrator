import { access, copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { isInsideDirectory } from './executables.js';
import { BOOKKEEPING_IDENTITY, DIFF_OPTIONS, resolveGit, runGit, type GitResult, type GitRunOptions } from './git.js';
import { SENSITIVE_NAME } from './gitSnapshot.js';
import type { WorktreeInfo } from './types.js';

/** Patches are applied in one piece, so a truncated one must never be used. */
const PATCH_LIMIT = 256 * 1024 * 1024;
const LISTED_SKIPS = 10;

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'type-changed';

export interface WorktreeChange {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  status: ChangeStatus;
  /** True when the change creates or keeps a symbolic link, which deserves a closer look before applying. */
  symlink: boolean;
}

export class WorktreeError extends Error {
  public constructor(
    message: string,
    /** Git's own explanation, when there is one. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface CreatedWorktree {
  info: WorktreeInfo;
  warnings: string[];
}

function firstLine(stderr: string): string {
  return stderr.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'Git exited without an explanation.';
}

async function git(
  executable: string,
  cwd: string,
  args: string[],
  action: string,
  options: GitRunOptions = {},
): Promise<GitResult> {
  const result = await runGit(executable, cwd, args, options);
  if (options.signal?.aborted) throw new WorktreeError('Cancelled.');
  if (!result.ok) {
    const remedy = /dubious ownership/i.test(result.stderr)
      ? ` The repository is owned by another user account; after verifying it is yours, run: git config --global --add safe.directory "${cwd.replace(/\\/g, '/')}"`
      : '';
    throw new WorktreeError(`${action} failed: ${firstLine(result.stderr)}${remedy}`, result.stderr.trim());
  }
  return result;
}

/** Copies untracked, non-ignored files so agents see the workspace as the user left it. */
async function copyUntracked(executable: string, repositoryRoot: string, worktreePath: string): Promise<string[]> {
  const listing = await git(executable, repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z'], 'Listing untracked files');
  const skipped: string[] = [];
  for (const relative of listing.stdout.split('\0').filter(Boolean)) {
    const source = path.join(repositoryRoot, relative);
    const target = path.join(worktreePath, relative);
    // Credentials would otherwise be written into the repository's object database by the base commit.
    if (SENSITIVE_NAME.test(path.basename(relative))) {
      skipped.push(`${relative} (name suggests a secret)`);
      continue;
    }
    const info = await lstat(source).catch(() => undefined);
    if (!info?.isFile() || !isInsideDirectory(target, worktreePath)) {
      skipped.push(`${relative} (${info?.isSymbolicLink() ? 'symbolic link' : 'not a regular file'})`);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  if (!skipped.length) return [];
  const listed = skipped.slice(0, LISTED_SKIPS).join(', ');
  const more = skipped.length > LISTED_SKIPS ? `, and ${skipped.length - LISTED_SKIPS} more` : '';
  return [`Untracked files not copied into the isolated worktree: ${listed}${more}.`];
}

/**
 * Creates a detached worktree at `worktreePath` whose base commit holds the workspace as it is now:
 * HEAD plus staged, unstaged, and untracked (non-ignored) changes. Ignored files such as `node_modules`
 * and `.env` are not present. The user's branch, index, stash, and files are not modified.
 */
export async function createWorktree(workspacePath: string, worktreePath: string, signal?: AbortSignal): Promise<CreatedWorktree> {
  const options = signal ? { signal } : {};
  const top = await git(resolveGit([workspacePath]), workspacePath, ['rev-parse', '--show-toplevel'], 'Finding the repository root', options);
  const repositoryRoot = path.resolve(top.stdout.trim());
  // The workspace may be a subfolder; nothing in the whole repository may supply Git from here on.
  const executable = resolveGit([workspacePath, repositoryRoot]);
  const prefix = (await git(executable, workspacePath, ['rev-parse', '--show-prefix'], 'Locating the workspace', options)).stdout.trim();

  const head = await runGit(executable, repositoryRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], options);
  if (!head.ok) {
    throw new WorktreeError(
      'An isolated worktree needs a repository with at least one commit. Commit once, or set dualAgent.isolation.mode to "none".',
    );
  }
  // `stash create` records staged and unstaged changes as a commit without touching the stash or the files.
  const stash = await git(executable, repositoryRoot, ['stash', 'create'], 'Recording uncommitted changes', {
    ...options,
    environment: BOOKKEEPING_IDENTITY,
  });
  const start = stash.stdout.trim() || head.stdout.trim();

  await mkdir(path.dirname(worktreePath), { recursive: true });
  await git(executable, repositoryRoot, ['worktree', 'add', '--detach', worktreePath, start], 'Creating the worktree', options);
  try {
    const warnings = await copyUntracked(executable, repositoryRoot, worktreePath);
    await git(executable, worktreePath, ['add', '-A'], 'Staging the base', options);
    const tree = (await git(executable, worktreePath, ['write-tree'], 'Recording the base', options)).stdout.trim();
    const base = (
      await git(executable, worktreePath, ['commit-tree', tree, '-p', start, '-m', 'Dual Agent run base'], 'Recording the base', {
        ...options,
        environment: BOOKKEEPING_IDENTITY,
      })
    ).stdout.trim();
    // The base commit becomes the worktree's HEAD, so `git diff HEAD` there shows only the agents' changes.
    await git(executable, worktreePath, ['update-ref', '--no-deref', 'HEAD', base], 'Recording the base', options);
    return {
      info: {
        path: worktreePath,
        workingDirectory: path.join(worktreePath, prefix),
        repositoryRoot,
        baseCommit: base,
        state: 'active',
      },
      warnings,
    };
  } catch (error) {
    await removeWorktreeFiles(executable, repositoryRoot, worktreePath);
    throw error;
  }
}

export async function worktreeExists(info: WorktreeInfo): Promise<boolean> {
  try {
    await access(path.join(info.path, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Stages everything in the worktree (never the user's repository) so new files appear in the diff. */
async function stageWorktree(executable: string, info: WorktreeInfo): Promise<void> {
  await git(executable, info.path, ['add', '-A'], 'Staging the worktree');
}

export async function listWorktreeChanges(info: WorktreeInfo): Promise<WorktreeChange[]> {
  const executable = resolveGit([info.repositoryRoot, info.path]);
  await stageWorktree(executable, info);
  const raw = await git(
    executable,
    info.path,
    ['diff', '--cached', '--raw', '-z', '--no-renames', ...DIFF_OPTIONS, info.baseCommit, '--'],
    'Listing changes',
  );
  const tokens = raw.stdout.split('\0');
  const changes: WorktreeChange[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    // Each entry is ":<old mode> <new mode> <old id> <new id> <status>" followed by the path.
    const [oldMode = '', newMode = '', , , letter = ''] = (tokens[index] ?? '').replace(/^:/, '').split(' ');
    const file = tokens[index + 1];
    if (!file) continue;
    const status: ChangeStatus =
      letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'T' ? 'type-changed' : 'modified';
    changes.push({ path: file, status, symlink: newMode === '120000' || (letter === 'D' && oldMode === '120000') });
  }
  return changes;
}

/**
 * Records every file in the worktree (ignored files excepted) as a Git tree, so the worktree can later be put
 * back to this point. Only the worktree's own index and the repository's object database are written.
 */
export async function checkpointWorktree(info: WorktreeInfo): Promise<string> {
  const executable = resolveGit([info.repositoryRoot, info.path]);
  await stageWorktree(executable, info);
  return (await git(executable, info.path, ['write-tree'], 'Recording a checkpoint')).stdout.trim();
}

/** Puts the worktree's files back to a checkpoint: later changes are reverted and files added since are deleted. */
export async function restoreWorktree(info: WorktreeInfo, tree: string): Promise<void> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree)) throw new WorktreeError('That checkpoint is not a valid Git tree.');
  const executable = resolveGit([info.repositoryRoot, info.path]);
  await stageWorktree(executable, info);
  await git(executable, info.path, ['read-tree', '--reset', '-u', tree], 'Restoring the checkpoint');
}

async function worktreePatch(executable: string, info: WorktreeInfo): Promise<Buffer> {
  await stageWorktree(executable, info);
  const patch = await git(
    executable,
    info.path,
    ['diff', '--cached', '--binary', '--full-index', '--no-renames', ...DIFF_OPTIONS, info.baseCommit, '--'],
    'Creating the patch',
    { outputLimit: PATCH_LIMIT, timeoutMs: 300_000 },
  );
  if (patch.truncated) throw new WorktreeError('The changes are too large to apply automatically. Open the worktree to copy them.');
  return patch.raw;
}

/**
 * Applies the worktree's changes to the user's working tree (not the index). The patch is checked first,
 * so a conflict with edits made since the run started leaves the workspace untouched.
 */
export async function applyWorktree(info: WorktreeInfo): Promise<void> {
  const executable = resolveGit([info.repositoryRoot, info.path]);
  const patch = await worktreePatch(executable, info);
  if (!patch.length) return;
  const apply = ['apply', '--binary', '--whitespace=nowarn'];
  const check = await runGit(executable, info.repositoryRoot, [...apply, '--check', '-'], { input: patch, timeoutMs: 300_000 });
  if (!check.ok) {
    throw new WorktreeError(
      'The changes do not apply cleanly, probably because the same files changed in the workspace since the run started. Nothing was changed.',
      check.stderr.trim(),
    );
  }
  await git(executable, info.repositoryRoot, [...apply, '-'], 'Applying the changes', { input: patch, timeoutMs: 300_000 });
}

/** Reads a file as it was in the run's base commit; empty when the file did not exist there. */
export async function readBaseFile(info: WorktreeInfo, relativePath: string): Promise<string> {
  const executable = resolveGit([info.repositoryRoot, info.path]);
  const spec = `${info.baseCommit}:${relativePath.replace(/\\/g, '/')}`;
  const result = await runGit(executable, info.path, ['cat-file', 'blob', spec]);
  return result.ok ? result.stdout : '';
}

async function removeWorktreeFiles(executable: string, repositoryRoot: string, worktreePath: string): Promise<void> {
  const removed = await runGit(executable, repositoryRoot, ['worktree', 'remove', '--force', worktreePath]);
  if (removed.ok) return;
  await rm(worktreePath, { recursive: true, force: true });
  await runGit(executable, repositoryRoot, ['worktree', 'prune']);
}

/**
 * Deletes the worktree and its registration. `allowedRoot` is the extension's worktree directory: a path
 * outside it is never deleted, whatever the run history says.
 */
export async function removeWorktree(info: WorktreeInfo, allowedRoot: string): Promise<void> {
  if (!isInsideDirectory(info.path, allowedRoot) || path.resolve(info.path) === path.resolve(allowedRoot)) {
    throw new WorktreeError(`Refusing to delete ${info.path} because it is outside the extension's worktree storage.`);
  }
  await removeWorktreeFiles(resolveGit([info.repositoryRoot]), info.repositoryRoot, info.path);
}
