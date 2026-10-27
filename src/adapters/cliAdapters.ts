import type {
  AgentAdapter,
  AgentHealth,
  AgentId,
  AgentRunRequest,
  PermissionMode,
  StageResult,
} from '../core/types.js';
import { AgentExecutionError } from '../core/errors.js';
import { parseClaudeLine, parseCodexLine, StreamAccumulator } from './parsers.js';
import { runProcess } from './processRunner.js';

export interface AdapterConfiguration {
  command: string;
  timeoutMs: number;
  billingMode: 'subscription' | 'environment';
  model?: string;
  claudeMaxTurns?: number;
}

function childEnvironment(mode: AdapterConfiguration['billingMode']): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (mode === 'subscription') {
    delete environment.ANTHROPIC_API_KEY;
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
  }
  return environment;
}

abstract class CliAdapter implements AgentAdapter {
  public abstract readonly id: AgentId;

  public constructor(protected readonly configuration: AdapterConfiguration) {}

  protected abstract buildArguments(permission: PermissionMode): string[];
  protected abstract parse(line: string): ReturnType<typeof parseCodexLine>;

  public async doctor(signal?: AbortSignal): Promise<AgentHealth> {
    try {
      const result = await runProcess({
        command: this.configuration.command,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        environment: childEnvironment(this.configuration.billingMode),
        ...(signal ? { signal } : {}),
      });
      const version = (result.stdout || result.stderr).trim();
      return { agent: this.id, available: true, version, detail: `${this.id} CLI is available.` };
    } catch (error) {
      return {
        agent: this.id,
        available: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async run(request: AgentRunRequest): Promise<StageResult> {
    const accumulator = new StreamAccumulator();
    let diagnostic = '';
    await runProcess({
      command: this.configuration.command,
      args: this.buildArguments(request.permission),
      cwd: request.cwd,
      input: request.prompt,
      timeoutMs: this.configuration.timeoutMs,
      signal: request.signal,
      environment: childEnvironment(this.configuration.billingMode),
      onLine: ({ stream, line }) => {
        if (stream === 'stderr') {
          diagnostic = `${diagnostic}\n${line}`.trim();
          request.onEvent({ agent: this.id, category: 'diagnostic', message: line });
          return;
        }
        const parsed = this.parse(line);
        accumulator.add(parsed);
        if (parsed?.event) request.onEvent(parsed.event);
      },
    });
    const result = accumulator.result();
    if (!result.text.trim()) {
      throw new AgentExecutionError(
        diagnostic || `${this.id} completed without a final response.`,
        'unknown',
      );
    }
    return result;
  }
}

export class CodexCliAdapter extends CliAdapter {
  public readonly id = 'codex' as const;

  protected buildArguments(permission: PermissionMode): string[] {
    const args = ['exec', '--json', '--sandbox', permission === 'workspace-write' ? 'workspace-write' : 'read-only'];
    if (this.configuration.model) args.push('--model', this.configuration.model);
    args.push('-');
    return args;
  }

  protected parse(line: string): ReturnType<typeof parseCodexLine> {
    return parseCodexLine(line);
  }
}

export class ClaudeCliAdapter extends CliAdapter {
  public readonly id = 'claude' as const;

  protected buildArguments(permission: PermissionMode): string[] {
    const args = [
      '-p',
      '--input-format',
      'text',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      String(this.configuration.claudeMaxTurns ?? 24),
      '--permission-mode',
      permission === 'workspace-write' ? 'acceptEdits' : 'plan',
    ];
    if (this.configuration.model) args.push('--model', this.configuration.model);
    return args;
  }

  protected parse(line: string): ReturnType<typeof parseClaudeLine> {
    return parseClaudeLine(line);
  }
}
