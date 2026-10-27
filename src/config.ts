import * as vscode from 'vscode';

import type { AdapterConfiguration } from './adapters/cliAdapters.js';

export interface ExtensionConfiguration {
  codex: AdapterConfiguration;
  claude: AdapterConfiguration;
  maxContextCharacters: number;
  fallbackOnQuota: boolean;
  maxRuns: number;
}

export function readConfiguration(): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration('dualAgent');
  const timeoutMs = configuration.get<number>('timeoutMinutes', 30) * 60_000;
  const billingMode = configuration.get<'subscription' | 'environment'>('billingMode', 'subscription');
  const codexModel = configuration.get<string>('codex.model', '').trim();
  const claudeModel = configuration.get<string>('claude.model', '').trim();
  return {
    codex: {
      command: configuration.get<string>('codex.command', 'codex'),
      timeoutMs,
      billingMode,
      ...(codexModel ? { model: codexModel } : {}),
    },
    claude: {
      command: configuration.get<string>('claude.command', 'claude'),
      timeoutMs,
      billingMode,
      claudeMaxTurns: configuration.get<number>('claude.maxTurns', 24),
      ...(claudeModel ? { model: claudeModel } : {}),
    },
    maxContextCharacters: configuration.get<number>('context.maxCharacters', 90_000),
    fallbackOnQuota: configuration.get<boolean>('fallbackOnQuota', true),
    maxRuns: configuration.get<number>('history.maxRuns', 50),
  };
}
