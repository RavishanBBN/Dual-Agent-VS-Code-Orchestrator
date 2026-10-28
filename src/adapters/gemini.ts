/**
 * Gemini CLI as an optional referee: when Codex's check finds problems with Claude's answer, Gemini rules on
 * each finding before Claude revises, so a disagreement between the two agents has an independent third view.
 * It always runs in Gemini's read-only plan mode, with the prompt on standard input and JSON output.
 */
import { isModelName } from '../core/agentOptions.js';
import { AgentExecutionError, classifyFailure } from '../core/errors.js';
import { resolveExecutable } from '../core/executables.js';
import type { TokenUsage } from '../core/types.js';
import { buildChildEnvironment, type BillingMode } from './environment.js';
import { runProcess } from './processRunner.js';

export interface RefereeConfiguration {
  command: string;
  timeoutMs: number;
  billingMode: BillingMode;
  environmentPassthrough?: readonly string[];
  model?: string;
}

export interface RefereeRequest {
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  untrustedDirectories?: readonly string[];
}

export interface RefereeResult {
  text: string;
  usage?: TokenUsage;
  model?: string;
}

/** Decides disputed findings; implemented by Gemini CLI. */
export interface RefereeAdapter {
  readonly name: string;
  rule(request: RefereeRequest): Promise<RefereeResult>;
  doctor(signal?: AbortSignal): Promise<{ available: boolean; version?: string; detail: string }>;
}

/** Output beyond this is not a ruling; it is cut rather than kept in memory. */
const OUTPUT_LIMIT = 2 * 1024 * 1024;

const numberAt = (value: unknown, key: string): number => {
  const field = (value as Record<string, unknown> | null)?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : 0;
};

/** Gemini's JSON result: the response, its per-model token stats, and an error when the call failed. */
export function parseGeminiOutput(stdout: string): RefereeResult {
  const start = stdout.indexOf('{');
  if (start < 0) throw new AgentExecutionError(stdout.trim() || 'Gemini returned no output.', classifyFailure(stdout));
  let parsed: { response?: unknown; stats?: { models?: Record<string, { tokens?: Record<string, unknown> }> }; error?: { message?: unknown } };
  try {
    parsed = JSON.parse(stdout.slice(start)) as typeof parsed;
  } catch {
    throw new AgentExecutionError('Gemini returned output that is not JSON.', 'unknown');
  }
  if (parsed.error) {
    const message = typeof parsed.error.message === 'string' ? parsed.error.message : JSON.stringify(parsed.error);
    throw new AgentExecutionError(message, classifyFailure(message));
  }
  const text = typeof parsed.response === 'string' ? parsed.response.trim() : '';
  if (!text) throw new AgentExecutionError('Gemini completed without a response.', 'unknown');
  const models = Object.entries(parsed.stats?.models ?? {});
  const usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  for (const [, model] of models) {
    usage.inputTokens += numberAt(model.tokens, 'prompt');
    usage.cachedInputTokens += numberAt(model.tokens, 'cached');
    usage.reasoningOutputTokens += numberAt(model.tokens, 'thoughts');
    usage.outputTokens += numberAt(model.tokens, 'candidates') + numberAt(model.tokens, 'thoughts');
  }
  const model = models[0]?.[0];
  return { text, usage, ...(model ? { model } : {}) };
}

export class GeminiReferee implements RefereeAdapter {
  public readonly name = 'Gemini';

  public constructor(private readonly configuration: RefereeConfiguration) {}

  private environment(): NodeJS.ProcessEnv {
    return buildChildEnvironment(process.env, {
      billingMode: this.configuration.billingMode,
      ...(this.configuration.environmentPassthrough ? { passthrough: this.configuration.environmentPassthrough } : {}),
    });
  }

  public async rule(request: RefereeRequest): Promise<RefereeResult> {
    const executable = resolveExecutable(this.configuration.command, { untrustedDirectories: [request.cwd, ...(request.untrustedDirectories ?? [])] });
    const model = this.configuration.model && isModelName(this.configuration.model) ? this.configuration.model : undefined;
    let stdout = '';
    await runProcess({
      command: executable,
      // The prompt is too long for a command line, so it goes on standard input with a short instruction.
      args: ['--output-format', 'json', '--approval-mode', 'plan', ...(model ? ['--model', model] : []), '-p', 'Follow the instructions on standard input.'],
      cwd: request.cwd,
      input: request.prompt,
      environment: this.environment(),
      timeoutMs: this.configuration.timeoutMs,
      signal: request.signal,
      onLine: ({ stream, line }) => {
        if (stream === 'stdout' && stdout.length < OUTPUT_LIMIT) stdout += `${line}\n`;
      },
    });
    return parseGeminiOutput(stdout);
  }

  public async doctor(signal?: AbortSignal): Promise<{ available: boolean; version?: string; detail: string }> {
    try {
      const executable = resolveExecutable(this.configuration.command, { untrustedDirectories: [] });
      const result = await runProcess({
        command: executable,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 15_000,
        environment: this.environment(),
        ...(signal ? { signal } : {}),
      });
      const version = (result.stdout || result.stderr).trim().split('\n')[0] ?? '';
      return { available: true, version, detail: `Gemini CLI resolved to ${executable}.` };
    } catch (error) {
      return { available: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
