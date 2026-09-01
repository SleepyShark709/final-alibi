import { z } from "zod";

import {
  estimateDeepSeekCostMicrosCny,
  pricingWindowAt,
} from "@/ai/deepseek/pricing";
import type {
  ModelMessage,
  ModelTier,
  StructuredModelResult,
} from "@/ai/model-provider";

export const modelCallAuditSchema = z
  .object({
    task: z.string().min(1),
    tier: z.enum(["flash", "pro"]),
    model: z.string(),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostMicrosCny: z.number().int().nonnegative(),
    request: z.record(z.string(), z.unknown()),
    response: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ModelCallAudit = z.infer<typeof modelCallAuditSchema>;

export function createModelCallAudit<T extends Record<string, unknown>>(
  task: string,
  tier: ModelTier,
  messages: ModelMessage[],
  result: StructuredModelResult<T>,
  occurredAt = new Date(),
): ModelCallAudit {
  return {
    task,
    tier,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    outputTokens: result.usage.outputTokens,
    estimatedCostMicrosCny: estimateDeepSeekCostMicrosCny(
      tier,
      result.usage,
      pricingWindowAt(occurredAt),
    ),
    request: { messages },
    response: result.rawResponse,
  };
}
