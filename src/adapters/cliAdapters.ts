import { access } from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentAdapter,
  AgentHealth,
  AgentId,
  AgentOptions,
  AgentRunRequest,
  PermissionMode,
  StageResult,
} from '../core/types.js';
import { isEffort, isModelName } from '../core/agentOptions.js';
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
  /** Default reasoning effort; a run's own choice takes precedence. */
  effort?: string;
  claudeMaxTurns?: number;
  /** Claude permission rules (for example `Bash(npm test:*)`) granted to workspace-write stages only. */
  claudeAllowedTools?: readonly string[];
  /** Extra environment variable names passed to the agent process. */
  environmentPassthrough?: readonly string[];
}

/** Session IDs are passed as arguments, so anything that could read as a flag is rejected. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Claude's built-in tools are allowlisted. Plan mode alone still offers Bash, PowerShell, WebFetch, and
 * publishing tools, and in print mode Claude Code runs commands it judges read-only without asking.
 */
const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob'];
const CLAUDE_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const CLAUDE_WEB_TOOLS = ['WebSearch', 'WebFetch'];
/** Arguments simple enough to put in an exact Bash rule without quoting. */
const RULE_ARGUMENT = /^[\w@%+=:,./-]+$/;

/**
 * Prefix rules for the verification commands, so Claude can run them, with extra arguments such as a single
 * test file, and nothing else. Claude Code checks each part of a compound command against the rule.
 */
export function commandRules(commands: readonly (readonly string[])[] | undefined): string[] {
  return (commands ?? [])
    .filter((command) => command.length > 0 && command.every((part) => RULE_ARGUMENT.test(part)))
    .map((command) => `Bash(${command.join(' ')}:*)`);
}
/** The tool a permission rule names, such as `Bash` for `Bash(npm test:*)`. */
const RULE_TOOL = /^([A-Za-z][A-Za-z0-9]*)(?:\(|$)/;

function claudeTools(writes: boolean, rules: readonly string[], web: boolean): string {
  const tools = new Set(writes ? [...CLAUDE_READ_TOOLS, ...CLAUDE_EDIT_TOOLS] : CLAUDE_READ_TOOLS);
  if (web) for (const tool of CLAUDE_WEB_TOOLS) tools.add(tool);
  for (const rule of rules) {
    const tool = RULE_TOOL.exec(rule)?.[1];
    if (tool) tools.add(tool);
  }
  return [...tools].join(',');
}

/** Repository files that can configure a provider, relative to the workspace root. */
const PROJECT_CONFIGURATION: Record<AgentId, readonly string[]> = {
  claude: [],
  codex: ['.codex'],
};

/** What a single run adds to an adapter's configuration. */
export interface RunArguments {
  options?: AgentOptions;
  images?: readonly string[];
  readableDirectories?: readonly string[];
  web?: boolean;
  allowedCommands?: readonly (readonly string[])[];
}

/** The run's model and effort, else the configured defaults; invalid values are skipped, never passed on. */
function chosen(agent: AgentId, configuration: AdapterConfiguration, run: RunArguments): AgentOptions {
  const model = [run.options?.model, configuration.model].find((value) => value !== undefined && isModelName(value));
  const effort = [run.options?.effort, configuration.effort].find((value) => value !== undefined && isEffort(agent, value));
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function claudeArguments(
  configuration: AdapterConfiguration,
  permission: PermissionMode,
  resumeSessionId?: string,
  run: RunArguments = {},
): string[] {
  const writes = permission === 'workspace-write';
  // Tool rules extend write stages only; a read-only stage can read and search (and use the web when allowed).
  const web = run.web === true;
  const rules = [
    ...(writes ? [...(configuration.claudeAllowedTools ?? []), ...commandRules(run.allowedCommands)] : []),
    ...(web ? CLAUDE_WEB_TOOLS : []),
  ];
  const args = [
    '-p',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--verbose',
    // Text arrives as it is written, so the chat can show it before the turn ends.
    '--include-partial-messages',
    '--max-turns',
    String(configuration.claudeMaxTurns ?? 24),
    // Print mode skips Claude Code's folder-trust prompt, so repository settings (hooks, permission rules,
    // MCP approvals) would otherwise apply without consent. Only the user's own settings are loaded.
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--permission-mode',
    writes ? 'acceptEdits' : 'plan',
    '--tools',
    claudeTools(writes, rules, web),
  ];
  if (rules.length) args.push('--allowedTools', ...rules);
  // Attachment folders are readable through the same Read, Grep, and Glob tools; nothing else is granted.
  for (const directory of run.readableDirectories ?? []) args.push('--add-dir', directory);
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  const { model, effort } = chosen('claude', configuration, run);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

function isMissingSession(error: unknown): boolean {
  return error instanceof AgentExecutionError && /no conversation found/i.test(error.message);
}

export function codexArguments(configuration: AdapterConfiguration, permission: PermissionMode, run: RunArguments = {}): string[] {
  const writes = permission === 'workspace-write';
  // `--search` is a top-level option, so it comes before the subcommand.
  const args = [...(run.web ? ['--search'] : []), 'exec', '--json'];
  // `--image` takes several values, so a fixed-arity flag always follows it before the stdin marker.
  for (const image of run.images ?? []) args.push('--image', image);
  args.push('--sandbox', writes ? 'workspace-write' : 'read-only');
  // Codex refuses folders outside Git by default; a read-only stage cannot change one, so chat works anywhere.
  if (!writes) args.push('--skip-git-repo-check');
  const { model, effort } = chosen('codex', configuration, run);
  if (model) args.push('--model', model);
  if (effort) args.push('--config', `model_reasoning_effort=${effort}`);
  args.push('-');
  return args;
}

abstract class CliAdapter implements AgentAdapter {
  public abstract readonly id: AgentId;

  public constructor(protected readonly configuration: AdapterConfiguration) {}

  protected abstract buildArguments(permission: PermissionMode, resumeSessionId: string | undefined, run: RunArguments): string[];
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
        args: this.buildArguments(request.permission, resumeSessionId, {
          ...(request.options ? { options: request.options } : {}),
          ...(request.images ? { images: request.images } : {}),
          ...(request.readableDirectories ? { readableDirectories: request.readableDirectories } : {}),
          ...(request.web ? { web: true } : {}),
          ...(request.allowedCommands ? { allowedCommands: request.allowedCommands } : {}),
        }),
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
          for (const event of parsed?.extraEvents ?? []) request.onEvent(event);
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

  protected buildArguments(permission: PermissionMode, _resumeSessionId: string | undefined, run: RunArguments): string[] {
    return codexArguments(this.configuration, permission, run);
  }

  protected parse(line: string): ParsedLine | undefined {
    return parseCodexLine(line);
  }
}

export class ClaudeCliAdapter extends CliAdapter {
  public readonly id = 'claude' as const;
  protected override readonly supportsResume = true;

  protected buildArguments(permission: PermissionMode, resumeSessionId: string | undefined, run: RunArguments): string[] {
    return claudeArguments(this.configuration, permission, resumeSessionId, run);
  }

  protected parse(line: string): ParsedLine | undefined {
    return parseClaudeLine(line);
  }
}
