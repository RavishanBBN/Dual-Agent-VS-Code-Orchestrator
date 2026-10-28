import type { AgentId, AgentOptions } from './types.js';

/** Model names are passed as arguments, so anything that could read as a flag or carry quoting is refused. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

/** Effort levels Claude Code's `--effort` accepts. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Model aliases Claude Code resolves to the latest model of each family. */
export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/**
 * Reasoning efforts Codex models have offered. The model catalog narrows this per model; the list is the
 * fallback when the catalog cannot be read.
 */
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export function isModelName(value: string): boolean {
  return MODEL_PATTERN.test(value);
}

export function isEffort(agent: AgentId, value: string): boolean {
  const allowed: readonly string[] = agent === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS;
  return allowed.includes(value);
}

/** Keeps only a valid model name and effort; anything else falls back to the CLI default. */
export function sanitizeAgentOptions(agent: AgentId, value: unknown): AgentOptions {
  if (typeof value !== 'object' || value === null) return {};
  const { model, effort } = value as Record<string, unknown>;
  const options: AgentOptions = {};
  if (typeof model === 'string' && isModelName(model.trim())) options.model = model.trim();
  if (typeof effort === 'string' && isEffort(agent, effort)) options.effort = effort;
  return options;
}
