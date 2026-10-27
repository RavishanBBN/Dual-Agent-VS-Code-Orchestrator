import readline from 'node:readline';
import spawn from 'cross-spawn';

import { AgentExecutionError, classifyFailure } from '../core/errors.js';

export interface ProcessLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  input?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine?: (line: ProcessLine) => void;
}

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.killed) return;
  child.kill('SIGTERM');
  const forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  forceTimer.unref();
}

export function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!child.stdout || !child.stderr || !child.stdin) {
      reject(new AgentExecutionError('Failed to create piped streams for the agent process.', 'unavailable'));
      return;
    }

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    stdoutReader.on('line', (line) => {
      stdout += `${line}\n`;
      options.onLine?.({ stream: 'stdout', line });
    });
    stderrReader.on('line', (line) => {
      stderr += `${line}\n`;
      options.onLine?.({ stream: 'stderr', line });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, options.timeoutMs);
    timeout.unref();

    const abort = (): void => terminate(child);
    options.signal?.addEventListener('abort', abort, { once: true });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      reject(new AgentExecutionError(error.message, classifyFailure(error.message)));
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);

      const exitCode = code ?? -1;
      if (options.signal?.aborted) {
        reject(new AgentExecutionError('Agent execution cancelled.', 'cancelled', exitCode));
        return;
      }
      if (timedOut) {
        reject(new AgentExecutionError(`Agent stage timed out after ${options.timeoutMs} ms.`, 'timeout', exitCode));
        return;
      }
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim() || `Agent exited with code ${exitCode}.`;
        reject(new AgentExecutionError(detail, classifyFailure(detail), exitCode));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
