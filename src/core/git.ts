import os from 'node:os';
import spawn from 'cross-spawn';

import { resolveExecutable } from './executables.js';
import { processTreeSpawnOptions, terminateProcessTree } from './processTree.js';

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Overrides repository configuration that could run programs during the extension's own Git commands:
 * filesystem monitors, and hooks (a worktree checkout runs `post-checkout`, a ref update runs
 * `reference-transaction`). Hooks live in `.git`, which an agent with write access could change. Optional
 * index locks are avoided so status reads do not contend with an agent's own Git commands.
 */
const HARDENING = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${os.devNull}`,
  '-c',
  'core.quotePath=false',
  '-c',
  'color.ui=false',
  ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
  '--no-optional-locks',
];

/** Disables external diff and textconv drivers, which repository configuration can point at programs. */
export const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color'];

/** Identity for the extension's own bookkeeping commits, so they work without a configured user. */
export const BOOKKEEPING_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Dual Agent Orchestrator',
  GIT_AUTHOR_EMAIL: 'dual-agent@localhost',
  GIT_COMMITTER_NAME: 'Dual Agent Orchestrator',
  GIT_COMMITTER_EMAIL: 'dual-agent@localhost',
};

export interface GitResult {
  ok: boolean;
  stdout: string;
  /** Standard output as bytes, for content that must not be decoded, such as patches. */
  raw: Buffer;
  stderr: string;
  truncated: boolean;
}

export interface GitRunOptions {
  /** Written to the command's standard input. */
  input?: string | Buffer;
  outputLimit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Variables added to the inherited environment. */
  environment?: NodeJS.ProcessEnv;
}

/** Resolves Git to an absolute path; the given directories (the workspace) never supply it. */
export function resolveGit(untrustedDirectories: readonly string[]): string {
  return resolveExecutable('git', { untrustedDirectories });
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}),
    ...extra,
  };
}

export function runGit(git: string, cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitResult> {
  const limit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  if (options.signal?.aborted) {
    return Promise.resolve({ ok: false, stdout: '', raw: Buffer.alloc(0), stderr: 'Git command cancelled.', truncated: false });
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    const child = spawn(git, [...HARDENING, ...args], {
      cwd,
      env: gitEnvironment(options.environment),
      shell: false,
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...processTreeSpawnOptions(),
    });
    const stop = (): void => terminateProcessTree(child, 'SIGKILL');
    const timer = setTimeout(stop, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();
    options.signal?.addEventListener('abort', stop, { once: true });
    const settle = (result: GitResult): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = limit - size;
      if (chunk.length <= room) {
        chunks.push(chunk);
        size += chunk.length;
        return;
      }
      chunks.push(chunk.subarray(0, room));
      truncated = true;
      stop();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) =>
      settle({ ok: false, stdout: '', raw: Buffer.alloc(0), stderr: error.message, truncated: false }),
    );
    child.once('close', (code) => {
      const aborted = options.signal?.aborted === true;
      const raw = Buffer.concat(chunks);
      settle({
        ok: !aborted && (code === 0 || truncated),
        stdout: raw.toString('utf8'),
        raw,
        stderr: aborted ? 'Git command cancelled.' : stderr,
        truncated,
      });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
  });
}

/** Describes a failed Git command in terms the user can act on. */
export function describeGitFailure(stderr: string, cwd: string): string {
  const detail = stderr.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'Git exited without an explanation.';
  if (/dubious ownership/i.test(stderr)) {
    return `Git refused this workspace because it is owned by a different user account ("dubious ownership"), so agents receive no diff. After verifying the folder is yours, run: git config --global --add safe.directory "${cwd.replace(/\\/g, '/')}"`;
  }
  if (/not a git repository/i.test(stderr)) return 'The workspace is not a Git repository, so agents receive no diff.';
  return `Git snapshot unavailable, so agents receive no diff: ${detail.slice(0, 300)}`;
}

export interface GitHealth {
  available: boolean;
  version?: string;
  /** Whether the workspace is a usable Git repository. */
  repository: boolean;
  detail: string;
}

/** Reports whether Git is installed and whether it accepts the workspace as a repository. */
export async function checkGit(workspacePath?: string): Promise<GitHealth> {
  let git: string;
  try {
    git = resolveGit(workspacePath ? [workspacePath] : []);
  } catch (error) {
    return { available: false, repository: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const version = await runGit(git, os.homedir(), ['--version'], { timeoutMs: 10_000 });
  if (!version.ok) return { available: false, repository: false, detail: version.stderr.trim() || 'git --version failed.' };
  const versionText = version.stdout.trim();
  if (!workspacePath) return { available: true, version: versionText, repository: false, detail: `Git resolved to ${git}.` };
  const probe = await runGit(git, workspacePath, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 10_000 });
  if (probe.ok && probe.stdout.trim() === 'true') {
    return { available: true, version: versionText, repository: true, detail: `Git resolved to ${git}; the workspace is a repository.` };
  }
  return { available: true, version: versionText, repository: false, detail: describeGitFailure(probe.stderr, workspacePath) };
}
