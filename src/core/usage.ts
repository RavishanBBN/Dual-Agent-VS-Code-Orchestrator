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
