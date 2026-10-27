import path from 'node:path';
import readline from 'node:readline';
import spawn from 'cross-spawn';

import { AgentExecutionError, classifyFailure, limitDetail } from '../core/errors.js';
import { processTreeSpawnOptions, terminateProcessTree } from '../core/processTree.js';

export interface ProcessLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface ProcessRunOptions {
  /** Absolute executable path; see resolveExecutable. */
  command: string;
  args: string[];
  cwd: string;
  input?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine?: (line: ProcessLine) => void;
  /** Characters of each stream retained for the result. Older output is discarded. */
  captureLimit?: number;
}

export interface ProcessRunResult {
  exitCode: number;
  /** The most recent `captureLimit` characters of stdout. */
  stdout: string;
  /** The most recent `captureLimit` characters of stderr. */
  stderr: string;
}

const DEFAULT_CAPTURE_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 2_000;
/** How long to wait for pipes held open by an escaped descendant after the process exits. */
const DRAIN_GRACE_MS = 5_000;

class TailBuffer {
  private value = '';

  public constructor(private readonly limit: number) {}

  public append(line: string): void {
    this.value += `${line}\n`;
    if (this.value.length > this.limit * 2) this.value = this.value.slice(-this.limit);
  }

  public toString(): string {
    return this.value.length > this.limit ? this.value.slice(-this.limit) : this.value;
  }
}

export function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  if (!path.isAbsolute(options.command)) {
    return Promise.reject(
      new AgentExecutionError(`Refusing to start "${options.command}" without an absolute executable path.`, 'invalid'),
    );
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(options.command) && !path.isAbsolute(process.env.ComSpec ?? '')) {
    // cross-spawn runs batch shims through COMSPEC, falling back to a bare "cmd.exe" lookup.
    return Promise.reject(new AgentExecutionError('COMSPEC must be an absolute path to run a batch shim.', 'invalid'));
  }
  // An abort that happened before the listener is attached would otherwise never be observed.
  if (options.signal?.aborted) return Promise.reject(new AgentExecutionError('Agent execution cancelled.', 'cancelled'));

  return new Promise((resolve, reject) => {
    const stdout = new TailBuffer(options.captureLimit ?? DEFAULT_CAPTURE_LIMIT);
    const stderr = new TailBuffer(options.captureLimit ?? DEFAULT_CAPTURE_LIMIT);
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    let stopping = false;
    let timedOut = false;

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...processTreeSpawnOptions(),
    });

    const later = (callback: () => void, delay: number): void => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      timers.push(timer);
    };

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      child.stdout?.destroy();
      child.stderr?.destroy();

      const exitCode = code ?? -1;
      if (options.signal?.aborted) {
        reject(new AgentExecutionError('Agent execution cancelled.', 'cancelled', exitCode));
      } else if (timedOut) {
        reject(new AgentExecutionError(`Agent stage timed out after ${options.timeoutMs} ms.`, 'timeout', exitCode));
      } else if (exitCode !== 0) {
        // Only stderr is classified: stdout carries agent output, including repository content.
        const detail = limitDetail(stderr.toString()) || `Process exited with code ${exitCode}.`;
        reject(new AgentExecutionError(detail, classifyFailure(detail), exitCode));
      } else {
        resolve({ exitCode, stdout: stdout.toString(), stderr: stderr.toString() });
      }
    };

    function stop(): void {
      if (stopping) return;
      stopping = true;
      terminateProcessTree(child, 'SIGTERM');
      later(() => terminateProcessTree(child, 'SIGKILL'), KILL_GRACE_MS);
      later(() => finish(null), KILL_GRACE_MS + DRAIN_GRACE_MS);
    }

    if (!child.stdout || !child.stderr || !child.stdin) {
      stop();
      reject(new AgentExecutionError('Failed to create piped streams for the agent process.', 'unavailable'));
      return;
    }

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (settled) return;
      stdout.append(line);
      options.onLine?.({ stream: 'stdout', line });
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (settled) return;
      stderr.append(line);
      options.onLine?.({ stream: 'stderr', line });
    });

    later(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', stop, { once: true });

    child.once('error', (error) => {
      // Later errors (for example a failed kill) are covered by the stop timers.
      if (child.pid !== undefined || settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      reject(new AgentExecutionError(error.message, classifyFailure(error.message)));
    });
    child.once('exit', (code) => later(() => finish(code), DRAIN_GRACE_MS));
    child.once('close', (code) => finish(code));

    // A process that exits before reading its input makes the write fail with EPIPE; the exit code reports it.
    child.stdin.on('error', () => undefined);
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
