import { z } from "zod";

import {
  estimateDeepSeekCostMicrosCny,
  pricingWindowAt,
} from "@/ai/deepseek/pricing";
import type {
  ModelMessage,
  ModelTier,
  StructuredOutputParseError,
  StructuredOutputValidationError,
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
  return createModelCallAuditFromResponse(
    task,
    tier,
    messages,
    result.model,
    result.usage,
    result.rawResponse,
    occurredAt,
  );
}

/** 账单与原始响应均已产生时，即使 schema 不合规也要留下可关联的审计记录。 */
export function createModelCallAuditFromStructuredOutputValidationError(
  task: string,
  tier: ModelTier,
  messages: ModelMessage[],
  error: StructuredOutputValidationError,
  occurredAt = new Date(),
): ModelCallAudit {
  return createModelCallAuditFromResponse(
    task,
    tier,
    messages,
    error.model,
    error.usage,
    {
      ...error.rawResponse,
      structuredOutputValidation: {
        schemaName: error.schemaName,
        issues: error.issues,
      },
    },
    occurredAt,
  );
}

/** 无法解析 JSON 时也保留已产生的账单、原始响应与可检索诊断。 */
export function createModelCallAuditFromStructuredOutputParseError(
  task: string,
  tier: ModelTier,
  messages: ModelMessage[],
  error: StructuredOutputParseError,
  occurredAt = new Date(),
): ModelCallAudit {
  return createModelCallAuditFromResponse(
    task,
    tier,
    messages,
    error.model,
    error.usage,
    {
      ...error.rawResponse,
      structuredOutputParse: {
        schemaName: error.schemaName,
        diagnostic: error.diagnostic,
      },
    },
    occurredAt,
  );
}

function createModelCallAuditFromResponse(
  task: string,
  tier: ModelTier,
  messages: ModelMessage[],
  model: string,
  usage: StructuredModelResult<Record<string, unknown>>["usage"],
  response: Record<string, unknown>,
  occurredAt: Date,
): ModelCallAudit {
  return {
    task,
    tier,
    model,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostMicrosCny: estimateDeepSeekCostMicrosCny(
      tier,
      usage,
      pricingWindowAt(occurredAt),
    ),
    request: { messages },
    response,
  };
}
