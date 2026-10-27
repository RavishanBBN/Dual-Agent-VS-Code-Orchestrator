import * as vscode from 'vscode';

import type { AdapterConfiguration } from './adapters/cliAdapters.js';
import type { BillingMode } from './adapters/environment.js';

export interface ExtensionConfiguration {
  codex: AdapterConfiguration;
  claude: AdapterConfiguration;
  maxContextCharacters: number;
  fallbackOnQuota: boolean;
  maxRuns: number;
  /** Settings that were ignored because their values were invalid. */
  problems: string[];
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;
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
    if (trimmed && !MODEL_PATTERN.test(trimmed)) {
      problems.push(`dualAgent.${key} is not a valid model name and was ignored.`);
      return '';
    }
    return trimmed;
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

  const command = (key: string, fallback: string): string => {
    const value = user<unknown>(key, fallback);
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };

  const timeoutMs = bounded('timeoutMinutes', 30, 1, 180) * 60_000;
  const billingMode: BillingMode = user<unknown>('billingMode', 'subscription') === 'environment' ? 'environment' : 'subscription';
  const environmentPassthrough = list('environment.passthrough', (entry) => ENVIRONMENT_NAME_PATTERN.test(entry));
  const codexModel = model('codex.model');
  const claudeModel = model('claude.model');
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
    },
    claude: {
      command: command('claude.command', 'claude'),
      timeoutMs,
      billingMode,
      environmentPassthrough,
      claudeMaxTurns: Math.round(bounded('claude.maxTurns', 24, 1, 100)),
      claudeAllowedTools,
      ...(claudeModel ? { model: claudeModel } : {}),
    },
    maxContextCharacters: Math.round(bounded('context.maxCharacters', 90_000, 10_000, 300_000)),
    fallbackOnQuota: user<unknown>('fallbackOnQuota', true) !== false,
    maxRuns: Math.round(bounded('history.maxRuns', 50, 5, 500)),
    problems,
  };
}
