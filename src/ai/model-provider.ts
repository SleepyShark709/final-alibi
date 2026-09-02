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

/**
 * 模型已返回 JSON，但该 JSON 未通过调用方指定的结构化 schema。
 * 保留字段路径和原始值，调用方可以区分“应重试/局部修复”的格式问题与网络错误。
 */
export interface StructuredOutputValidationIssue {
  path: Array<string | number>;
  message: string;
  received: string;
}

export class StructuredOutputValidationError extends Error {
  constructor(
    readonly schemaName: string,
    readonly input: unknown,
    readonly issues: StructuredOutputValidationIssue[],
    readonly model: string,
    readonly usage: ModelUsage,
    readonly rawResponse: Record<string, unknown>,
  ) {
    super(
      `DeepSeek JSON for structured output "${schemaName}" failed schema validation: ${issues
        .slice(0, 3)
        .map((issue) => {
          const received = issue.message.includes("received ")
            ? ""
            : `; received ${issue.received}`;
          return `${issue.path.join(".") || "root"}: ${issue.message}${received}`;
        })
        .join("; ")}`,
    );
    this.name = "StructuredOutputValidationError";
  }
}

export function isStructuredOutputValidationError(
  error: unknown,
): error is StructuredOutputValidationError {
  if (error instanceof StructuredOutputValidationError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Partial<StructuredOutputValidationError>;
  return (
    candidate.name === "StructuredOutputValidationError" &&
    typeof candidate.schemaName === "string" &&
    Array.isArray(candidate.issues) &&
    typeof candidate.model === "string" &&
    isModelUsage(candidate.usage) &&
    isRecord(candidate.rawResponse)
  );
}

function isModelUsage(value: unknown): value is ModelUsage {
  if (!isRecord(value)) return false;
  return (
    typeof value.inputTokens === "number" &&
    typeof value.cachedInputTokens === "number" &&
    typeof value.outputTokens === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
