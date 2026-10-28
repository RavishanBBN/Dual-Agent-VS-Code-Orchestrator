import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isInsideDirectory } from './executables.js';
import { describeGitFailure, DIFF_OPTIONS, resolveGit, runGit } from './git.js';
import type { GitSnapshot, UntrackedFile } from './types.js';

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const UNTRACKED_FILE_LIMIT = 40;
const UNTRACKED_FILE_BYTES = 32 * 1024;
/** Untracked files whose names suggest credentials are listed but never read into a prompt. */
export const SENSITIVE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx)|.*(?:secret|credential|password).*)$/i;

export { describeGitFailure };

function unavailable(warning: string): GitSnapshot {
  return { available: false, status: '', diff: '', diffStat: '', untracked: [], warnings: [warning] };
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

export async function captureGitSnapshot(cwd: string, untrustedDirectories: readonly string[] = []): Promise<GitSnapshot> {
  let git: string;
  try {
    // Never let the workspace supply git: on Windows a planted git.exe there would otherwise run first.
    git = resolveGit([cwd, ...untrustedDirectories]);
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
