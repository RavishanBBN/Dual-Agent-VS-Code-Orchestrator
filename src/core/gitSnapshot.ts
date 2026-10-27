import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import spawn from 'cross-spawn';

import { isInsideDirectory, resolveExecutable } from './executables.js';
import { processTreeSpawnOptions, terminateProcessTree } from './processTree.js';
import type { GitSnapshot, UntrackedFile } from './types.js';

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const UNTRACKED_FILE_LIMIT = 40;
const UNTRACKED_FILE_BYTES = 32 * 1024;
/** Untracked files whose names suggest credentials are listed but never read into a prompt. */
const SENSITIVE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx)|.*(?:secret|credential|password).*)$/i;

/**
 * Overrides repository configuration that could run programs during read-only commands
 * (filesystem monitors, external diff and textconv drivers) and avoids taking optional index locks
 * that would contend with an agent's own Git commands.
 */
const HARDENING = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'color.ui=false', '--no-optional-locks'];
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color'];

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}),
  };
}

function runGit(git: string, cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    const child = spawn(git, [...HARDENING, ...args], {
      cwd,
      env: gitEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...processTreeSpawnOptions(),
    });
    const timer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), GIT_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = OUTPUT_LIMIT - size;
      if (chunk.length <= room) {
        chunks.push(chunk);
        size += chunk.length;
        return;
      }
      chunks.push(chunk.subarray(0, room));
      truncated = true;
      terminateProcessTree(child, 'SIGKILL');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: '', stderr: error.message, truncated: false });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 || truncated, stdout: Buffer.concat(chunks).toString('utf8'), stderr, truncated });
    });
  });
}

function unavailable(warning: string): GitSnapshot {
  return { available: false, status: '', diff: '', diffStat: '', untracked: [], warnings: [warning] };
}

export function describeGitFailure(stderr: string, cwd: string): string {
  const detail = stderr.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'Git exited without an explanation.';
  if (/dubious ownership/i.test(stderr)) {
    return `Git refused this workspace because it is owned by a different user account ("dubious ownership"), so agents receive no diff. After verifying the folder is yours, run: git config --global --add safe.directory "${cwd.replace(/\\/g, '/')}"`;
  }
  if (/not a git repository/i.test(stderr)) return 'The workspace is not a Git repository, so agents receive no diff.';
  return `Git snapshot unavailable, so agents receive no diff: ${detail.slice(0, 300)}`;
}

async function readUntracked(cwd: string, listing: string): Promise<{ files: UntrackedFile[]; warnings: string[] }> {
  const paths = listing.split('\0').filter(Boolean);
  const files: UntrackedFile[] = [];
  const root = await realpath(cwd);

  for (const relative of paths.slice(0, UNTRACKED_FILE_LIMIT)) {
    const absolute = path.resolve(cwd, relative);
    if (SENSITIVE_NAME.test(path.basename(relative))) {
      files.push({ path: relative, omitted: 'name suggests a secret' });
      continue;
    }
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) files.push({ path: relative, omitted: 'symbolic link' });
      else if (!info.isFile()) files.push({ path: relative, omitted: 'not a regular file' });
      else if (info.size > UNTRACKED_FILE_BYTES) files.push({ path: relative, omitted: `larger than ${UNTRACKED_FILE_BYTES / 1024} KB` });
      // A linked parent directory could still point outside the workspace.
      else if (!isInsideDirectory(await realpath(absolute), root)) files.push({ path: relative, omitted: 'outside the workspace' });
      else {
        const content = await readFile(absolute);
        if (content.subarray(0, 8_000).includes(0)) files.push({ path: relative, omitted: 'binary' });
        else files.push({ path: relative, content: content.toString('utf8') });
      }
    } catch {
      files.push({ path: relative, omitted: 'unreadable' });
    }
  }

  const warnings =
    paths.length > UNTRACKED_FILE_LIMIT
      ? [`${paths.length - UNTRACKED_FILE_LIMIT} more untracked files were not listed for agents.`]
      : [];
  return { files, warnings };
}

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {
  let git: string;
  try {
    // Never let the workspace supply git: on Windows a planted git.exe there would otherwise run first.
    git = resolveExecutable('git', { untrustedDirectories: [cwd] });
  } catch (error) {
    return unavailable(`Git is unavailable, so agents receive no diff: ${error instanceof Error ? error.message : String(error)}`);
  }

  const probe = await runGit(git, cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!probe.ok || probe.stdout.trim() !== 'true') return unavailable(describeGitFailure(probe.stderr, cwd));

  const hasHead = (await runGit(git, cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
  // Compare against HEAD so staged changes are reviewed too; a repository without commits has no HEAD.
  const diffs = (extra: string[]): string[][] =>
    hasHead
      ? [['diff', ...DIFF_OPTIONS, ...extra, 'HEAD', '--']]
      : [
          ['diff', ...DIFF_OPTIONS, ...extra, '--cached', '--'],
          ['diff', ...DIFF_OPTIONS, ...extra, '--'],
        ];

  const [status, diffParts, statParts, untrackedListing] = await Promise.all([
    runGit(git, cwd, ['status', '--short']),
    Promise.all(diffs(['--unified=3']).map((args) => runGit(git, cwd, args))),
    Promise.all(diffs(['--stat']).map((args) => runGit(git, cwd, args))),
    runGit(git, cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  const warnings: string[] = [];
  const failed = [status, ...diffParts, ...statParts, untrackedListing].find((result) => !result.ok);
  if (failed) warnings.push(describeGitFailure(failed.stderr, cwd));
  if (diffParts.some((result) => result.truncated)) {
    warnings.push(`The working-tree diff exceeded ${OUTPUT_LIMIT / 1024 / 1024} MB and was truncated.`);
  }

  const untracked = untrackedListing.ok ? await readUntracked(cwd, untrackedListing.stdout) : { files: [], warnings: [] };
  return {
    available: true,
    status: status.stdout.trimEnd(),
    diff: diffParts.map((result) => result.stdout.trimEnd()).filter(Boolean).join('\n'),
    diffStat: statParts.map((result) => result.stdout.trimEnd()).filter(Boolean).join('\n'),
    untracked: untracked.files,
    warnings: [...warnings, ...untracked.warnings],
  };
}
