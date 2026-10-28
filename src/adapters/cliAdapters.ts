import { access } from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentAdapter,
  AgentHealth,
  AgentId,
  AgentRunRequest,
  PermissionMode,
  StageResult,
} from '../core/types.js';
import { AgentExecutionError, classifyFailure, limitDetail } from '../core/errors.js';
import { resolveExecutable } from '../core/executables.js';
import { buildChildEnvironment, type BillingMode } from './environment.js';
import { parseClaudeLine, parseCodexLine, StreamAccumulator, type ParsedLine } from './parsers.js';
import { runProcess } from './processRunner.js';

export interface AdapterConfiguration {
  command: string;
  timeoutMs: number;
  billingMode: BillingMode;
  model?: string;
  claudeMaxTurns?: number;
  /** Claude permission rules (for example `Bash(npm test:*)`) granted to workspace-write stages only. */
  claudeAllowedTools?: readonly string[];
  /** Extra environment variable names passed to the agent process. */
  environmentPassthrough?: readonly string[];
}

/** Session IDs are passed as arguments, so anything that could read as a flag is rejected. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Repository files that can configure a provider, relative to the workspace root. */
const PROJECT_CONFIGURATION: Record<AgentId, readonly string[]> = {
  claude: [],
  codex: ['.codex'],
};

export function claudeArguments(
  configuration: AdapterConfiguration,
  permission: PermissionMode,
  resumeSessionId?: string,
): string[] {
  const writes = permission === 'workspace-write';
  const args = [
    '-p',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(configuration.claudeMaxTurns ?? 24),
    // Print mode skips Claude Code's folder-trust prompt, so repository settings (hooks, permission rules,
    // MCP approvals) would otherwise apply without consent. Only the user's own settings are loaded.
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--permission-mode',
    writes ? 'acceptEdits' : 'plan',
  ];
  if (writes && configuration.claudeAllowedTools?.length) args.push('--allowedTools', ...configuration.claudeAllowedTools);
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  if (configuration.model) args.push('--model', configuration.model);
  return args;
}

function isMissingSession(error: unknown): boolean {
  return error instanceof AgentExecutionError && /no conversation found/i.test(error.message);
}

export function codexArguments(configuration: AdapterConfiguration, permission: PermissionMode): string[] {
  const args = ['exec', '--json', '--sandbox', permission === 'workspace-write' ? 'workspace-write' : 'read-only'];
  if (configuration.model) args.push('--model', configuration.model);
  args.push('-');
  return args;
}

abstract class CliAdapter implements AgentAdapter {
  public abstract readonly id: AgentId;

  public constructor(protected readonly configuration: AdapterConfiguration) {}

  protected abstract buildArguments(permission: PermissionMode, resumeSessionId?: string): string[];
  protected abstract parse(line: string): ParsedLine | undefined;
  /** Whether this provider's CLI can continue a session non-interactively with the same flags. */
  protected readonly supportsResume: boolean = false;

  private environment(): NodeJS.ProcessEnv {
    return buildChildEnvironment(process.env, {
      billingMode: this.configuration.billingMode,
      passthrough: this.configuration.environmentPassthrough ?? [],
    });
  }

  public async doctor(signal?: AbortSignal, workspacePath?: string): Promise<AgentHealth> {
    try {
      const environment = this.environment();
      const executable = resolveExecutable(this.configuration.command, {
        environment,
        untrustedDirectories: workspacePath ? [workspacePath] : [],
      });
      const result = await runProcess({
        command: executable,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        environment,
        ...(signal ? { signal } : {}),
      });
      const version = (result.stdout || result.stderr).trim().split('\n')[0] ?? '';
      return { agent: this.id, available: true, version, detail: `${this.id} CLI resolved to ${executable}.` };
    } catch (error) {
      return {
        agent: this.id,
        available: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async preflightWarnings(workspacePath: string): Promise<string[]> {
    const warnings: string[] = [];
    for (const entry of PROJECT_CONFIGURATION[this.id]) {
      try {
        await access(path.join(workspacePath, entry));
        warnings.push(
          `The repository contains ${entry}. ${this.id} can apply project-level configuration from it; review it before running agents in this workspace.`,
        );
      } catch {
        // Not present.
      }
    }
    return warnings;
  }

  public async run(request: AgentRunRequest): Promise<StageResult> {
    const resume = request.resume;
    if (resume && this.supportsResume && SESSION_ID.test(resume.sessionId)) {
      try {
        return { ...(await this.execute(request, resume.prompt, resume.sessionId)), resumedSession: true };
      } catch (error) {
        // A session can disappear (cleaned up, or created on another machine); the stage then starts fresh.
        if (!isMissingSession(error) || request.signal.aborted) throw error;
        request.onEvent({
          agent: this.id,
          category: 'diagnostic',
          message: `Session ${resume.sessionId} could not be resumed; starting a new session.`,
        });
      }
    }
    return this.execute(request, request.prompt);
  }

  private async execute(request: AgentRunRequest, prompt: string, resumeSessionId?: string): Promise<StageResult> {
    const accumulator = new StreamAccumulator();
    const environment = this.environment();
    // The workspace and its worktree are excluded so a planted codex.cmd or claude.exe can never be selected.
    const executable = resolveExecutable(this.configuration.command, {
      environment,
      untrustedDirectories: [request.cwd, ...(request.untrustedDirectories ?? [])],
    });
    let diagnostic = '';

    try {
      await runProcess({
        command: executable,
        args: this.buildArguments(request.permission, resumeSessionId),
        cwd: request.cwd,
        input: prompt,
        timeoutMs: this.configuration.timeoutMs,
        signal: request.signal,
        environment,
        onLine: ({ stream, line }) => {
          if (stream === 'stderr') {
            diagnostic = limitDetail(`${diagnostic}\n${line}`);
            request.onEvent({ agent: this.id, category: 'diagnostic', message: line });
            return;
          }
          const parsed = this.parse(line);
          accumulator.add(parsed);
          if (parsed?.event) request.onEvent(parsed.event);
        },
      });
    } catch (error) {
      throw this.describeFailure(error, accumulator);
    }

    const result = accumulator.result();
    const failure = accumulator.failureMessage();
    if (failure) throw new AgentExecutionError(failure, classifyFailure(failure), 0, result.usage);
    if (!result.text.trim()) {
      throw new AgentExecutionError(
        diagnostic || `${this.id} completed without a final response.`,
        'unknown',
        0,
        result.usage,
      );
    }
    return result;
  }

  /** Prefers the provider's structured error over process output, and keeps the usage already spent. */
  private describeFailure(error: unknown, accumulator: StreamAccumulator): Error {
    if (!(error instanceof AgentExecutionError)) return error instanceof Error ? error : new Error(String(error));
    const usage = accumulator.result().usage;
    const reported = accumulator.errorMessage();
    if (reported && error.kind !== 'cancelled' && error.kind !== 'timeout') {
      return new AgentExecutionError(reported, classifyFailure(reported), error.exitCode, usage);
    }
    return new AgentExecutionError(error.message, error.kind, error.exitCode, usage);
  }
}

export class CodexCliAdapter extends CliAdapter {
  public readonly id = 'codex' as const;

  protected buildArguments(permission: PermissionMode): string[] {
    return codexArguments(this.configuration, permission);
  }

  protected parse(line: string): ParsedLine | undefined {
    return parseCodexLine(line);
  }
}

export class ClaudeCliAdapter extends CliAdapter {
  public readonly id = 'claude' as const;
  protected override readonly supportsResume = true;

  protected buildArguments(permission: PermissionMode, resumeSessionId?: string): string[] {
    return claudeArguments(this.configuration, permission, resumeSessionId);
  }

  protected parse(line: string): ParsedLine | undefined {
    return parseClaudeLine(line);
  }
}
