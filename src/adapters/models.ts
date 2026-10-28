import { CODEX_EFFORTS, isModelName } from '../core/agentOptions.js';
import { resolveExecutable } from '../core/executables.js';
import type { AdapterConfiguration } from './cliAdapters.js';
import { buildChildEnvironment } from './environment.js';
import { runProcess } from './processRunner.js';

/** A model the Codex CLI offers, with the reasoning efforts that model accepts. */
export interface CodexModel {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort?: string;
}

/** The catalog includes each model's full instructions, so it is far larger than ordinary CLI output. */
const CATALOG_LIMIT = 32 * 1024 * 1024;
const EFFORT_PATTERN = /^[a-z]{2,16}$/;

function effortName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value : typeof value === 'object' && value !== null ? (value as { effort?: unknown }).effort : undefined;
  return typeof name === 'string' && EFFORT_PATTERN.test(name) ? name : undefined;
}

/** Reads `codex debug models` output, keeping listed models with valid names and efforts. */
export function parseCodexCatalog(output: string): CodexModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  const models: CodexModel[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.slug === 'string' ? item.slug : typeof item.id === 'string' ? item.id : '';
    // Hidden models are internal; the catalog marks the ones meant for people with "list".
    if (!isModelName(id) || (item.visibility !== undefined && item.visibility !== 'list')) continue;
    const levels = Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : [];
    const efforts = levels.map(effortName).filter((value): value is string => value !== undefined);
    const defaultEffort = effortName(item.default_reasoning_level);
    models.push({
      id,
      name: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim().slice(0, 80) : id,
      efforts: efforts.length ? efforts : [...CODEX_EFFORTS],
      ...(defaultEffort ? { defaultEffort } : {}),
    });
  }
  return models;
}

/** Asks the installed Codex CLI for its models; an empty list means the catalog could not be read. */
export async function listCodexModels(configuration: AdapterConfiguration, signal?: AbortSignal): Promise<CodexModel[]> {
  const environment = buildChildEnvironment(process.env, {
    billingMode: configuration.billingMode,
    passthrough: configuration.environmentPassthrough ?? [],
  });
  try {
    const result = await runProcess({
      command: resolveExecutable(configuration.command, { environment }),
      args: ['debug', 'models'],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      environment,
      captureLimit: CATALOG_LIMIT,
      ...(signal ? { signal } : {}),
    });
    return parseCodexCatalog(result.stdout);
  } catch {
    return [];
  }
}
