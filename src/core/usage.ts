import type { AgentId, TokenUsage } from './types.js';
import { emptyUsage } from './types.js';

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const estimatedCostUsd = (left.estimatedCostUsd ?? 0) + (right.estimatedCostUsd ?? 0);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
  };
}

export function totalUsageByAgent(): Record<AgentId, TokenUsage> {
  return { claude: emptyUsage(), codex: emptyUsage() };
}

/** Input plus output; cached input and reasoning are already parts of those. */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/** Adds up usage per agent, such as every run of a conversation or of a day. */
export function sumByAgent(items: Iterable<Record<AgentId, TokenUsage>>): Record<AgentId, TokenUsage> {
  let total = totalUsageByAgent();
  for (const item of items) total = { claude: addUsage(total.claude, item.claude), codex: addUsage(total.codex, item.codex) };
  return total;
}
