import type { z } from "zod";

export type ModelTier = "flash" | "pro";
export type ModelMessageRole = "system" | "user" | "assistant";

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
}

export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface StructuredModelRequest<T extends Record<string, unknown>> {
  tier: ModelTier;
  schema: z.ZodType<T>;
  schemaName: string;
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StructuredModelResult<T extends Record<string, unknown>> {
  value: T;
  model: string;
  usage: ModelUsage;
  rawResponse: Record<string, unknown>;
}

export interface StructuredModelProvider {
  invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>>;
}
