import { access, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
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
import { codexQuota, parseClaudeLine, parseCodexLine, StreamAccumulator, type ParsedLine } from './parsers.js';
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
  /**
   * How Agent-mode stages ask the user before a command or edit: an MCP configuration file naming the
   * extension's permission bridge, and the bridge's tool. Without it Agent mode cannot run commands.
   */
  permissionBridge?: { configFile: string; tool: string };
  /** Codex in Agent mode may reach the network from its sandbox, so it can install packages. */
  codexAgentNetwork?: boolean;
  /**
   * Claude may use the MCP servers in the user's own Claude configuration. Off by default: a server can read
   * and send data, so it is the user's choice. With it on, Claude loads servers as it does in the user's terminal.
   */
  claudeUserMcp?: boolean;
}

/** Session IDs are passed as arguments, so anything that could read as a flag is rejected. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Claude's built-in tools are allowlisted. Plan mode alone still offers Bash, PowerShell, WebFetch, and
 * publishing tools, and in print mode Claude Code runs commands it judges read-only without asking.
 */
const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob', 'TodoWrite'];
const CLAUDE_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const CLAUDE_WEB_TOOLS = ['WebSearch', 'WebFetch'];
/** Agent mode gets the shell too; everything Claude does not judge read-only goes to the permission bridge. */
const CLAUDE_AGENT_TOOLS = [...CLAUDE_READ_TOOLS, ...CLAUDE_EDIT_TOOLS, 'Bash', ...CLAUDE_WEB_TOOLS];
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
  if (permission === 'agent') return claudeAgentArguments(configuration, resumeSessionId, run);
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
    ...(configuration.claudeUserMcp ? [] : ['--strict-mcp-config']),
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

/**
 * Agent mode: the full toolset in the folder itself. Claude Code runs what it judges read-only and asks the
 * permission bridge, and so the user, before anything else; the user's own allowed-tool rules still apply.
 */
function claudeAgentArguments(configuration: AdapterConfiguration, resumeSessionId: string | undefined, run: RunArguments): string[] {
  const bridge = configuration.permissionBridge;
  if (!bridge) throw new AgentExecutionError('Agent mode needs the permission bridge, which is not running.', 'invalid');
  const rules = configuration.claudeAllowedTools ?? [];
  const args = [
    '-p',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--max-turns',
    String(configuration.claudeMaxTurns ?? 24),
    '--setting-sources',
    'user',
    // Only the bridge's MCP server starts, unless the user allowed their own servers too.
    ...(configuration.claudeUserMcp ? [] : ['--strict-mcp-config']),
    '--mcp-config',
    bridge.configFile,
    '--permission-prompt-tool',
    bridge.tool,
    '--permission-mode',
    'default',
    '--tools',
    claudeTools(false, [...CLAUDE_AGENT_TOOLS, ...rules], false),
  ];
  if (rules.length) args.push('--allowedTools', ...rules);
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
  const writes = permission !== 'read-only';
  // `--search` is a top-level option, so it comes before the subcommand.
  const args = [...(run.web || permission === 'agent' ? ['--search'] : []), 'exec', '--json'];
  // `--image` takes several values, so a fixed-arity flag always follows it before the stdin marker.
  for (const image of run.images ?? []) args.push('--image', image);
  args.push('--sandbox', writes ? 'workspace-write' : 'read-only');
  // Codex exec cannot ask before a command, so in Agent mode it works inside its sandbox, with the network
  // when that is allowed so it can install packages there.
  if (permission === 'agent' && configuration.codexAgentNetwork !== false) args.push('--config', 'sandbox_workspace_write.network_access=true');
  // Codex refuses folders outside Git by default. A read-only stage cannot change one, and an editing stage
  // works in an isolated worktree or in a folder the extension snapshotted first, so both may run anywhere.
  args.push('--skip-git-repo-check');
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

/** Codex thread IDs are UUIDs; anything else is never used in a path. */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the account's usage limits from the session log Codex wrote for `threadId`. Codex records them there,
 * not in `exec --json` output. Only that thread's log is opened, and only its rate-limit fields are read.
 */
export async function readCodexQuota(
  threadId: string,
  home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  now = new Date(),
): Promise<StageResult['quota']> {
  if (!THREAD_ID.test(threadId)) return undefined;
  const pad = (value: number): string => String(value).padStart(2, '0');
  // A session that started just before midnight is filed under the previous day.
  for (const day of [now, new Date(now.getTime() - 86_400_000)]) {
    const folder = path.join(home, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    const name = (await readdir(folder).catch(() => [] as string[])).find((entry) => entry.endsWith(`${threadId}.jsonl`));
    if (!name) continue;
    const lines = (await readFile(path.join(folder, name), 'utf8').catch(() => '')).split(/\r?\n/);
    for (const line of lines.reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const entry = JSON.parse(line) as { payload?: { rate_limits?: Record<string, unknown> } };
        const quota = codexQuota(entry.payload?.rate_limits, now);
        if (quota) return quota;
      } catch {
        // A partly written line; an earlier one may still hold the limits.
      }
    }
    return undefined;
  }
  return undefined;
}

export class CodexCliAdapter extends CliAdapter {
  public readonly id = 'codex' as const;

  public override async run(request: AgentRunRequest): Promise<StageResult> {
    const result = await super.run(request);
    const quota = result.providerSessionId ? await readCodexQuota(result.providerSessionId).catch(() => undefined) : undefined;
    return quota ? { ...result, quota } : result;
  }

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
