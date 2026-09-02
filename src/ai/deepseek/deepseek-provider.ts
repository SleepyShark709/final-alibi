import {
  AIMessage,
  HumanMessage,
  isAIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatDeepSeek } from "@langchain/deepseek";
import { z } from "zod";

import {
  StructuredOutputValidationError,
  type ModelMessage,
  type ModelTier,
  type ModelUsage,
  type StructuredModelProvider,
  type StructuredModelRequest,
  type StructuredModelResult,
} from "@/ai/model-provider";
import type {
  StructuredOutputValidationIssue,
} from "@/ai/model-provider";

export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  flashModel?: string;
  proModel?: string;
  maxRetries?: number;
  timeoutMs?: number;
  structuredMethod?: "functionCalling" | "jsonMode";
}

type DeepSeekStructuredMethod = NonNullable<
  DeepSeekProviderOptions["structuredMethod"]
>;

function jsonModeInstruction(schema: z.ZodType): string {
  // LangChain 的 jsonMode 只会发送 response_format=json_object，并不会把 Zod
  // schema 自动传给模型。案件首次生成需要的字段很多，若只说“返回 CaseArtifact”，
  // 模型会自造一套字段；因此在 Provider 边界把真实 schema 一并给出。
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  return [
    "请只返回一个符合下列 JSON Schema 的合法 json 对象。",
    "必须提供所有 required 字段，不能添加 schema 之外的字段。",
    "不要返回 Markdown、解释、思考过程或代码块。",
    "JSON Schema（仅用于约束输出，不要在答案中复述）：",
    jsonSchema,
  ].join("\n");
}

export class DeepSeekModelProvider implements StructuredModelProvider {
  private readonly options: Required<
    Omit<DeepSeekProviderOptions, "apiKey">
  > & { apiKey?: string };

  constructor(options: DeepSeekProviderOptions = {}) {
    // Key 在服务实例创建时从服务器环境读取，绝不发送到浏览器；部署时变更环境变量需重启 web 和 worker。
    this.options = {
      apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY,
      baseUrl:
        options.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        "https://api.deepseek.com",
      flashModel:
        options.flashModel ??
        process.env.DEEPSEEK_FLASH_MODEL ??
        "deepseek-v4-flash",
      proModel:
        options.proModel ?? process.env.DEEPSEEK_PRO_MODEL ?? "deepseek-v4-pro",
      maxRetries: options.maxRetries ?? 2,
      // 完整案件通常会输出数千 token；90 秒会在网络抖动时误杀健康请求。
      timeoutMs: options.timeoutMs ?? envPositiveInteger("DEEPSEEK_TIMEOUT_MS", 180_000),
      structuredMethod:
        options.structuredMethod ??
        (process.env.DEEPSEEK_STRUCTURED_METHOD === "functionCalling"
          ? "functionCalling"
          : "jsonMode"),
    };
  }

  async invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    if (!this.options.apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required for live model calls");
    }

    const modelName = this.modelName(request.tier);
    const model = new ChatDeepSeek({
      apiKey: this.options.apiKey,
      model: modelName,
      temperature: request.temperature ?? 0.2,
      maxTokens: request.maxTokens,
      maxRetries: this.options.maxRetries,
      timeout: this.options.timeoutMs,
      configuration: { baseURL: this.options.baseUrl },
      // DeepSeek V4 默认启用 Thinking；LangChain 的 functionCalling structured output 会发送
      // tool_choice，而该组合会被 DeepSeek 拒绝。所有本项目模型调用都是结构化调用，
      // 因此在请求层显式关闭 Thinking，换取稳定、可校验的 JSON/tool 输出。
      modelKwargs: { thinking: { type: "disabled" } },
    });
    const structuredMethod = resolveDeepSeekStructuredMethod(
      modelName,
      this.options.structuredMethod,
    );
    const messages = toStructuredMessages(
      request.messages,
      structuredMethod,
      request.schema,
    );

    if (structuredMethod === "jsonMode") {
      // 不经 withStructuredOutput 的 Content Parser：它会把原始响应折叠为
      // parsed=null，导致 Worker 既不能给出原因，也无法兼容偶发的代码围栏。
      const raw = await model
        .withConfig({
          outputVersion: "v0",
          response_format: { type: "json_object" },
        })
        .invoke(messages, { signal: request.signal });
      const parsed = parseJsonMessage(raw);
      if (parsed === null) {
        throw noParseableJsonError(request.schemaName, raw);
      }
      const usage = extractUsage(raw);
      const rawResponse = serializeMessage(raw);
      const value = parseSchemaOrThrow(request.schema, parsed, request.schemaName, {
        model: modelName,
        usage,
        rawResponse,
      });

      return {
        value,
        model: modelName,
        usage,
        rawResponse,
      };
    }

    const runnable = model.withStructuredOutput(request.schema, {
      name: request.schemaName,
      method: structuredMethod,
      includeRaw: true,
    });
    const result = await runnable.invoke(
      messages,
      { signal: request.signal },
    );
    // function-calling 响应若缺少 tool call，LangChain 会返回 parsed=null；把这类
    // Provider 边界错误与 schema 字段错误区分开，避免 Worker 只留下模糊的 Zod 报错。
    if (result.parsed === null || result.parsed === undefined) {
      throw new Error(
        `DeepSeek returned no parseable JSON for structured output "${request.schemaName}"`,
      );
    }
    const usage = extractUsage(result.raw);
    const rawResponse = serializeMessage(result.raw);
    const value = parseSchemaOrThrow(request.schema, result.parsed, request.schemaName, {
      model: modelName,
      usage,
      rawResponse,
    });

    return {
      value,
      model: modelName,
      usage,
      rawResponse,
    };
  }

  modelName(tier: ModelTier): string {
    return tier === "pro" ? this.options.proModel : this.options.flashModel;
  }
}

export function resolveDeepSeekStructuredMethod(
  modelName: string,
  configuredMethod: DeepSeekStructuredMethod,
): DeepSeekStructuredMethod {
  // V4 的 tool-call 响应目前会以 legacy raw tool_calls 形式到达当前适配器：
  // 强制 functionCalling 既可能得到 parsed=null，也会触发 LangChain 的升级警告。
  // JSON Mode 不发送 tool_choice，且 Content Parser 直接解析 message content。
  return modelName.startsWith("deepseek-v4-") ? "jsonMode" : configuredMethod;
}

function toLangChainMessage(message: ModelMessage) {
  if (message.role === "system") return new SystemMessage(message.content);
  if (message.role === "assistant") return new AIMessage(message.content);
  return new HumanMessage(message.content);
}

function toStructuredMessages(
  messages: ModelMessage[],
  structuredMethod: DeepSeekStructuredMethod,
  schema: z.ZodType,
) {
  if (structuredMethod !== "jsonMode") return messages.map(toLangChainMessage);

  const instruction = jsonModeInstruction(schema);
  const [first, ...rest] = messages;
  if (first?.role === "system") {
    return [
      new SystemMessage([first.content, instruction].join("\n")),
      ...rest.map(toLangChainMessage),
    ];
  }
  return [
    new SystemMessage(instruction),
    ...messages.map(toLangChainMessage),
  ];
}

function parseJsonMessage(message: BaseMessage): unknown | null {
  const text = messageText(message.content).trim();
  if (!text) return null;

  const fenced = text.match(/^\u0060\u0060\u0060(?:json)?\s*([\s\S]*?)\s*\u0060\u0060\u0060$/i)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    // JSON mode 偶发会在对象前后带一句文字；仅在仍能取得完整对象时宽容恢复。
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

function messageText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }
      return [];
    })
    .join("");
}

function parseSchemaOrThrow<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  input: unknown,
  schemaName: string,
  diagnostics: {
    model: string;
    usage: ModelUsage;
    rawResponse: Record<string, unknown>;
  },
): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const issues: StructuredOutputValidationIssue[] = parsed.error.issues.map(
    (issue) => ({
      path: issue.path.map((segment) =>
        typeof segment === "number" ? segment : String(segment),
      ),
      message: issue.message,
      received: formatDiagnosticValue(readPath(input, issue.path)),
    }),
  );
  throw new StructuredOutputValidationError(
    schemaName,
    input,
    issues,
    diagnostics.model,
    diagnostics.usage,
    diagnostics.rawResponse,
  );
}

function readPath(input: unknown, path: ReadonlyArray<PropertyKey>) {
  let current = input;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
      continue;
    }
    if (
      current &&
      typeof current === "object" &&
      typeof segment === "string"
    ) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function formatDiagnosticValue(value: unknown) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  if (serialized === undefined) return "undefined";
  return serialized.length <= 240
    ? serialized
    : `${serialized.slice(0, 237)}...`;
}

function noParseableJsonError(schemaName: string, message: BaseMessage): Error {
  return new Error(
    "DeepSeek returned no parseable JSON for structured output \"" +
      schemaName +
      "\" (" +
      jsonResponseSummary(message) +
      ")",
  );
}

function jsonResponseSummary(message: BaseMessage): string {
  const text = messageText(message.content).trim();
  const finishReason = isAIMessage(message)
    ? String(message.response_metadata.finish_reason ?? "unknown")
    : "unknown";
  return text
    ? "content " + text.length + " chars, finish_reason=" + finishReason
    : "empty content, finish_reason=" + finishReason;
}

function envPositiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function extractUsage(message: BaseMessage): ModelUsage {
  if (!isAIMessage(message)) {
    return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  }
  const usage = message.usage_metadata;
  const cacheRead = usage?.input_token_details?.cache_read;
  const tokenUsage = message.response_metadata.tokenUsage as
    | {
        promptTokens?: number;
        completionTokens?: number;
        promptCacheHitTokens?: number;
      }
    | undefined;

  return {
    inputTokens: usage?.input_tokens ?? tokenUsage?.promptTokens ?? 0,
    cachedInputTokens:
      typeof cacheRead === "number"
        ? cacheRead
        : tokenUsage?.promptCacheHitTokens ?? 0,
    outputTokens: usage?.output_tokens ?? tokenUsage?.completionTokens ?? 0,
  };
}

function serializeMessage(message: BaseMessage): Record<string, unknown> {
  return {
    id: message.id,
    content: message.content,
    additionalKwargs: message.additional_kwargs,
    responseMetadata: message.response_metadata,
    ...(isAIMessage(message)
      ? {
          usageMetadata: message.usage_metadata,
          toolCalls: message.tool_calls,
          invalidToolCalls: message.invalid_tool_calls,
        }
      : {}),
  };
}
