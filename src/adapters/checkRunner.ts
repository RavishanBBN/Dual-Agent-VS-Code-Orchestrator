import { AgentExecutionError, limitDetail } from '../core/errors.js';
import { resolveExecutable } from '../core/executables.js';
import type { CheckResult } from '../core/types.js';
import { buildChildEnvironment, type BillingMode } from './environment.js';
import { runProcess, TailBuffer } from './processRunner.js';

/** Output kept per command for the record and the next reviewer's prompt. */
const OUTPUT_LIMIT = 16 * 1024;

export interface CheckRunnerConfiguration {
  timeoutMs: number;
  billingMode: BillingMode;
  environmentPassthrough?: readonly string[];
}

export interface CheckRunRequest {
  /** Each command is an argument vector; no shell is involved. */
  commands: readonly (readonly string[])[];
  cwd: string;
  signal: AbortSignal;
  /** Directories that must never supply a command's executable. */
  untrustedDirectories: readonly string[];
  onLine?: (line: string) => void;
}

/**
 * Runs commands in order, stopping at the first failure because later commands usually depend on
 * earlier ones (install, then test).
 *
 * These commands run with the user's permissions and outside any agent sandbox, and they execute
 * repository code that agents may have changed. That is why they exist only in user settings and need
 * consent for each run. Cancellation stops the run; every other failure is reported as a result.
 */
export async function runChecks(configuration: CheckRunnerConfiguration, request: CheckRunRequest): Promise<CheckResult[]> {
  const environment = buildChildEnvironment(process.env, {
    billingMode: configuration.billingMode,
    passthrough: configuration.environmentPassthrough ?? [],
  });
  const results: CheckResult[] = [];

  for (const command of request.commands) {
    const [name = '', ...args] = command;
    const started = Date.now();
    const output = new TailBuffer(OUTPUT_LIMIT);
    const base = { command: [...command] };
    let executable: string;
    try {
      // npm's node_modules/.bin inside the workspace is excluded like everything else there.
      executable = resolveExecutable(name, { environment, untrustedDirectories: request.untrustedDirectories });
    } catch (error) {
      results.push({ ...base, exitCode: -1, durationMs: 0, output: '', error: error instanceof Error ? error.message : String(error) });
      break;
    }

    try {
      const result = await runProcess({
        command: executable,
        args,
        cwd: request.cwd,
        timeoutMs: configuration.timeoutMs,
        signal: request.signal,
        environment,
        allowNonZeroExit: true,
        captureLimit: OUTPUT_LIMIT,
        onLine: ({ line }) => {
          output.append(line);
          request.onLine?.(line);
        },
      });
      results.push({ ...base, exitCode: result.exitCode, durationMs: Date.now() - started, output: output.toString() });
      if (result.exitCode !== 0) break;
    } catch (error) {
      if (request.signal.aborted) throw error;
      const timedOut = error instanceof AgentExecutionError && error.kind === 'timeout';
      const exitCode = error instanceof AgentExecutionError && error.exitCode !== undefined ? error.exitCode : -1;
      results.push({
        ...base,
        exitCode,
        durationMs: Date.now() - started,
        output: output.toString(),
        ...(timedOut ? { timedOut: true } : { error: limitDetail(error instanceof Error ? error.message : String(error), 500) }),
      });
      break;
    }
  }
  return results;
}
