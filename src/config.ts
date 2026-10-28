import * as vscode from 'vscode';

import type { CheckRunnerConfiguration } from './adapters/checkRunner.js';
import type { AdapterConfiguration } from './adapters/cliAdapters.js';
import type { BillingMode } from './adapters/environment.js';
import { isEffort, isModelName } from './core/agentOptions.js';
import type { AgentId, IsolationMode } from './core/types.js';

export interface ExtensionConfiguration {
  codex: AdapterConfiguration;
  claude: AdapterConfiguration;
  maxContextCharacters: number;
  fallbackOnQuota: boolean;
  maxRuns: number;
  isolation: IsolationMode;
  setupCommands: string[][];
  verificationCommands: string[][];
  checks: CheckRunnerConfiguration;
  maxFixRounds: number;
  approvePlan: boolean;
  resumeClaudeSessions: boolean;
  redactSecrets: boolean;
  /** Continue a run that stopped at both agents' usage limits once the first limit resets. */
  autoContinue: boolean;
  /** Settings that were ignored because their values were invalid. */
  problems: string[];
}

const MAX_COMMANDS = 10;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 1_000;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.()]*$/;

export function readConfiguration(): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration('dualAgent');
  const problems: string[] = [];

  /**
   * Reads only the user (global) value. Every setting is machine-scoped in the manifest; reading the
   * global value directly keeps a repository's .vscode/settings.json from steering agents even if a
   * workspace value is present.
   */
  const user = <T>(key: string, fallback: T): T => {
    const inspected = configuration.inspect<T>(key);
    return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
  };

  const bounded = (key: string, fallback: number, min: number, max: number): number => {
    const value = user<unknown>(key, fallback);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`dualAgent.${key} must be a number; using ${fallback}.`);
      return fallback;
    }
    return Math.min(max, Math.max(min, value));
  };

  const model = (key: string): string => {
    const value = user<unknown>(key, '');
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed && !isModelName(trimmed)) {
      problems.push(`dualAgent.${key} is not a valid model name and was ignored.`);
      return '';
    }
    return trimmed;
  };

  const effort = (agent: AgentId): string => {
    const value = user<unknown>(`${agent}.effort`, '');
    if (value === '' || value === undefined) return '';
    if (typeof value === 'string' && isEffort(agent, value)) return value;
    problems.push(`dualAgent.${agent}.effort is not an effort level ${agent === 'claude' ? 'Claude' : 'Codex'} accepts and was ignored.`);
    return '';
  };

  const list = (key: string, valid: (entry: string) => boolean): string[] => {
    const value = user<unknown>(key, []);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => {
      const ok = typeof entry === 'string' && valid(entry);
      if (!ok) problems.push(`dualAgent.${key} entry ${JSON.stringify(entry)} was ignored.`);
      return ok;
    });
  };

  /** Reads a list of argument vectors. Commands run without a shell, so no quoting or expansion applies. */
  const commands = (key: string): string[][] => {
    const value = user<unknown>(key, []);
    if (!Array.isArray(value)) {
      if (value !== undefined) problems.push(`dualAgent.${key} must be a list of commands; it was ignored.`);
      return [];
    }
    const valid = value.filter((entry): entry is string[] => {
      const ok =
        Array.isArray(entry) &&
        entry.length > 0 &&
        entry.length <= MAX_ARGUMENTS &&
        entry.every((part) => typeof part === 'string' && part.length <= MAX_ARGUMENT_LENGTH && !/[\r\n\0]/.test(part)) &&
        typeof entry[0] === 'string' &&
        entry[0].trim().length > 0;
      if (!ok) problems.push(`dualAgent.${key} entry ${JSON.stringify(entry)} must be a non-empty list of arguments and was ignored.`);
      return ok;
    });
    if (valid.length > MAX_COMMANDS) problems.push(`dualAgent.${key} lists more than ${MAX_COMMANDS} commands; only the first ${MAX_COMMANDS} are used.`);
    return valid.slice(0, MAX_COMMANDS).map((entry) => [entry[0]?.trim() ?? '', ...entry.slice(1)]);
  };

  const command = (key: string, fallback: string): string => {
    const value = user<unknown>(key, fallback);
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };

  const timeoutMs = bounded('timeoutMinutes', 30, 1, 180) * 60_000;
  const billingMode: BillingMode = user<unknown>('billingMode', 'subscription') === 'environment' ? 'environment' : 'subscription';
  const environmentPassthrough = list('environment.passthrough', (entry) => ENVIRONMENT_NAME_PATTERN.test(entry));
  const codexModel = model('codex.model');
  const claudeModel = model('claude.model');
  const codexEffort = effort('codex');
  const claudeEffort = effort('claude');
  // Tool rules are passed as separate arguments; one that looks like a flag could change the CLI's behavior.
  const claudeAllowedTools = list(
    'claude.allowedTools',
    (entry) => entry.trim().length > 0 && entry.length <= 200 && !entry.trim().startsWith('-') && !/[\r\n\0]/.test(entry),
  ).map((entry) => entry.trim());

  return {
    codex: {
      command: command('codex.command', 'codex'),
      timeoutMs,
      billingMode,
      environmentPassthrough,
      ...(codexModel ? { model: codexModel } : {}),
      ...(codexEffort ? { effort: codexEffort } : {}),
    },
    claude: {
      command: command('claude.command', 'claude'),
      timeoutMs,
      billingMode,
      environmentPassthrough,
      claudeMaxTurns: Math.round(bounded('claude.maxTurns', 24, 1, 100)),
      claudeAllowedTools,
      ...(claudeModel ? { model: claudeModel } : {}),
      ...(claudeEffort ? { effort: claudeEffort } : {}),
    },
    maxContextCharacters: Math.round(bounded('context.maxCharacters', 90_000, 10_000, 300_000)),
    fallbackOnQuota: user<unknown>('fallbackOnQuota', true) !== false,
    maxRuns: Math.round(bounded('history.maxRuns', 100, 5, 500)),
    isolation: user<unknown>('isolation.mode', 'worktree') === 'none' ? 'none' : 'worktree',
    setupCommands: commands('isolation.setupCommands'),
    verificationCommands: commands('verification.commands'),
    checks: {
      timeoutMs: bounded('verification.timeoutMinutes', 10, 1, 120) * 60_000,
      billingMode,
      environmentPassthrough,
    },
    maxFixRounds: Math.round(bounded('workflow.maxFixRounds', 1, 0, 3)),
    approvePlan: user<unknown>('workflow.approvePlan', true) !== false,
    resumeClaudeSessions: user<unknown>('claude.resumeSessions', true) !== false,
    redactSecrets: user<unknown>('privacy.redactSecrets', true) !== false,
    autoContinue: user<unknown>('limits.autoContinue', true) !== false,
    problems,
  };
}
