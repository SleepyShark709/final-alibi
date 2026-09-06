import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  constructorOptions: [] as Array<Record<string, unknown>>,
  callConfigs: [] as Array<Record<string, unknown>>,
  structuredCalls: [] as Array<Record<string, unknown>>,
  invocations: [] as unknown[],
  invocationSignals: [] as AbortSignal[],
  waitForAbort: false,
  content: '{"verdict":"ok"}' as unknown,
  additionalKwargs: {} as Record<string, unknown>,
  responseMetadata: {} as Record<string, unknown>,
  usageMetadata: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@langchain/deepseek", () => ({
  ChatDeepSeek: class {
    constructor(options: Record<string, unknown>) {
      harness.constructorOptions.push(options);
    }

    withConfig(config: Record<string, unknown>) {
      harness.callConfigs.push(config);
      return {
        invoke: async (messages: unknown, options: { signal: AbortSignal }) => {
          await captureInvocation(messages, options.signal);
          return {
            id: "mock-response",
            content: harness.content,
            additional_kwargs: harness.additionalKwargs,
            response_metadata: harness.responseMetadata,
            usage_metadata: harness.usageMetadata,
            _getType: () => "ai",
          };
        },
      };
    }

    withStructuredOutput(
      _schema: unknown,
      options: Record<string, unknown>,
    ) {
      harness.structuredCalls.push(options);
      return {
        invoke: async (messages: unknown, options: { signal: AbortSignal }) => {
          await captureInvocation(messages, options.signal);
          const raw = {
            id: "mock-response",
            content: harness.content,
            additional_kwargs: harness.additionalKwargs,
            response_metadata: harness.responseMetadata,
            usage_metadata: harness.usageMetadata,
            _getType: () => "ai",
          };
          return {
            parsed:
              typeof harness.content === "string"
                ? JSON.parse(harness.content)
                : harness.content,
            raw,
          };
        },
      };
    }
  },
}));

import { DeepSeekModelProvider } from "./deepseek-provider";

async function captureInvocation(messages: unknown, signal: AbortSignal) {
  harness.invocations.push(messages);
  harness.invocationSignals.push(signal);
  if (harness.waitForAbort) {
    await new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

const resultSchema = z.object({ verdict: z.string() }).strict();
const lieStrategySchema = z
  .object({
    strategy: z.enum(["deny", "deflect", "minimize", "fabricate_cover"]),
  })
  .strict();

describe("DeepSeekModelProvider structured output", () => {
  beforeEach(() => {
    harness.additionalKwargs = {};
    harness.responseMetadata = {};
    harness.usageMetadata = undefined;
    harness.invocationSignals.length = 0;
    harness.waitForAbort = false;
  });

  it.each(["jsonMode", "functionCalling"] as const)(
    "bounds the whole %s invocation even when SDK retries are enabled",
    async (structuredMethod) => {
      harness.waitForAbort = true;
      const provider = new DeepSeekModelProvider({
        apiKey: "test-key",
        proModel: "deepseek-chat",
        structuredMethod,
        timeoutMs: 20,
        maxRetries: 3,
      });

      await expect(provider.invokeStructured({
        tier: "pro",
        schema: resultSchema,
        schemaName: "test_result",
        messages: [{ role: "user", content: "Return the test result." }],
      })).rejects.toMatchObject({ name: "TimeoutError" });
      expect(harness.invocationSignals[0]?.aborted).toBe(true);
    },
  );

  it.each(["jsonMode", "functionCalling"] as const)(
    "preserves caller cancellation alongside the %s deadline",
    async (structuredMethod) => {
      harness.waitForAbort = true;
      const controller = new AbortController();
      const reason = new Error("request cancelled by caller");
      const provider = new DeepSeekModelProvider({
        apiKey: "test-key",
        proModel: "deepseek-chat",
        structuredMethod,
        timeoutMs: 1_000,
      });
      const result = provider.invokeStructured({
        tier: "pro",
        schema: resultSchema,
        schemaName: "test_result",
        messages: [{ role: "user", content: "Return the test result." }],
        signal: controller.signal,
      });
      controller.abort(reason);

      await expect(result).rejects.toBe(reason);
      expect(harness.invocationSignals[0]?.aborted).toBe(true);
    },
  );

  it("keeps thinking disabled and preserves function calling by default", async () => {
    harness.constructorOptions.length = 0;
    harness.callConfigs.length = 0;
    harness.structuredCalls.length = 0;
    harness.invocations.length = 0;
    harness.content = '{"verdict":"ok"}';
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      proModel: "deepseek-chat",
      structuredMethod: "functionCalling",
    });

    const result = await provider.invokeStructured({
      tier: "pro",
      schema: resultSchema,
      schemaName: "test_result",
      messages: [{ role: "user", content: "Return the test result." }],
      temperature: 0.45,
      maxTokens: 640,
    });

    expect(harness.constructorOptions).toHaveLength(1);
    expect(harness.constructorOptions[0]).toMatchObject({
      model: "deepseek-chat",
      temperature: 0.45,
      maxTokens: 640,
      modelKwargs: { thinking: { type: "disabled" } },
    });
    expect(harness.constructorOptions[0]).not.toHaveProperty(
      "modelKwargs.reasoning_effort",
    );
    expect(harness.structuredCalls).toEqual([
      expect.objectContaining({
        name: "test_result",
        method: "functionCalling",
      }),
    ]);
    expect(harness.callConfigs).toEqual([]);
    expect(result.rawResponse).toMatchObject({ additionalKwargs: {} });
    expect(result.rawResponse).not.toHaveProperty("reasoningContentChars");
  });

  it.each([undefined, "low"] as const)("sets the requested thinking effort (%s) with JSON mode and no sampling options", async (reasoningEffort) => {
    harness.constructorOptions.length = 0;
    harness.callConfigs.length = 0;
    harness.structuredCalls.length = 0;
    harness.invocations.length = 0;
    harness.content = '{"verdict":"ok"}';
    const reasoningContent = "推理过程".repeat(5_000);
    const originalAdditionalKwargs = {
      reasoning_content: reasoningContent,
      request_id: "request-safe-to-audit",
      providerFlag: { cached: true },
    };
    harness.additionalKwargs = originalAdditionalKwargs;
    harness.responseMetadata = { finish_reason: "stop", model_revision: "v4" };
    harness.usageMetadata = {
      input_tokens: 21,
      output_tokens: 34,
      total_tokens: 55,
    };
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      proModel: "deepseek-chat",
      structuredMethod: "functionCalling",
    });

    const result = await provider.invokeStructured({
      tier: "pro",
      schema: resultSchema,
      schemaName: "test_result",
      messages: [{ role: "user", content: "Reason, then return JSON." }],
      reasoning: true,
      reasoningEffort,
      temperature: 0.9,
      maxTokens: 1_234,
    });

    expect(harness.constructorOptions).toHaveLength(1);
    expect(harness.constructorOptions[0]).toMatchObject({
      model: "deepseek-chat",
      maxTokens: 1_234,
      modelKwargs: {
        thinking: { type: "enabled" },
        reasoning_effort: reasoningEffort ?? "high",
      },
    });
    expect(harness.constructorOptions[0]).not.toHaveProperty("temperature");
    expect(harness.structuredCalls).toEqual([]);
    expect(harness.callConfigs).toContainEqual(
      expect.objectContaining({
        response_format: { type: "json_object" },
      }),
    );
    expect(
      JSON.stringify({
        constructor: harness.constructorOptions,
        callConfigs: harness.callConfigs,
      }),
    ).not.toContain("tool_choice");
    const messages = harness.invocations[0] as Array<{ content: unknown }>;
    expect(messages[0]?.content).toContain("JSON Schema");
    expect(messages[0]?.content).toContain("\"verdict\"");
    expect(result.rawResponse).toMatchObject({
      additionalKwargs: {
        request_id: "request-safe-to-audit",
        providerFlag: { cached: true },
      },
      reasoningContentChars: reasoningContent.length,
      responseMetadata: harness.responseMetadata,
      usageMetadata: harness.usageMetadata,
    });
    expect(JSON.stringify(result.rawResponse)).not.toContain(reasoningContent);
    expect(harness.additionalKwargs).toBe(originalAdditionalKwargs);
    expect(harness.additionalKwargs).toEqual({
      reasoning_content: reasoningContent,
      request_id: "request-safe-to-audit",
      providerFlag: { cached: true },
    });
  });

  it("uses the raw JSON API for DeepSeek V4 and supplies the actual schema to the model", async () => {
    harness.constructorOptions.length = 0;
    harness.callConfigs.length = 0;
    harness.structuredCalls.length = 0;
    harness.invocations.length = 0;
    harness.content = '{"verdict":"ok"}';
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      proModel: "deepseek-v4-pro",
      structuredMethod: "functionCalling",
    });

    await expect(
      provider.invokeStructured({
        tier: "pro",
        schema: resultSchema,
        schemaName: "test_result",
        messages: [{ role: "user", content: "Return the test result." }],
      }),
    ).resolves.toMatchObject({ value: { verdict: "ok" } });

    expect(harness.callConfigs).toContainEqual(
      expect.objectContaining({
        response_format: { type: "json_object" },
      }),
    );
    const messages = harness.invocations[0] as Array<{ content: unknown }>;
    expect(messages[0]?.content).toContain("JSON Schema");
    expect(messages[0]?.content).toContain("\"verdict\"");
  });

  it("reports an actionable failure when DeepSeek returns no JSON content", async () => {
    harness.callConfigs.length = 0;
    harness.invocations.length = 0;
    harness.content = "";
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      proModel: "deepseek-v4-pro",
    });

    const error = await provider
      .invokeStructured({
        tier: "pro",
        schema: resultSchema,
        schemaName: "test_result",
        messages: [{ role: "user", content: "Return the test result." }],
      })
      .then(
        () => new Error("Expected JSON parsing to fail"),
        (reason) => reason,
      );

    expect(error).toMatchObject({
      name: "StructuredOutputParseError",
      schemaName: "test_result",
      model: "deepseek-v4-pro",
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      rawResponse: expect.objectContaining({ content: "" }),
      diagnostic: "empty content, finish_reason=unknown",
    });
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe(
        'DeepSeek returned no parseable JSON for structured output "test_result" (empty content, finish_reason=unknown)',
      );
    }
  });

  it("identifies a model JSON object that does not satisfy the requested schema", async () => {
    harness.callConfigs.length = 0;
    harness.invocations.length = 0;
    harness.content = '{"unexpected":true}';
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      proModel: "deepseek-v4-pro",
    });

    await expect(
      provider.invokeStructured({
        tier: "pro",
        schema: resultSchema,
        schemaName: "test_result",
        messages: [{ role: "user", content: "Return the test result." }],
      }),
    ).rejects.toThrow(
      'DeepSeek JSON for structured output "test_result" failed schema validation: verdict: Invalid input: expected string, received undefined',
    );
  });

  it("keeps the invalid enum value available for recovery and diagnosis", async () => {
    harness.callConfigs.length = 0;
    harness.invocations.length = 0;
    harness.content = '{"strategy":"fabricate_alibi"}';
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      proModel: "deepseek-v4-pro",
    });

    const error = await provider
      .invokeStructured({
        tier: "pro",
        schema: lieStrategySchema,
        schemaName: "lie_rule",
        messages: [{ role: "user", content: "Return a lie rule." }],
      })
      .then(
        () => new Error("Expected schema validation to fail"),
        (reason) => reason,
      );

    expect(error).toMatchObject({
      name: "StructuredOutputValidationError",
      schemaName: "lie_rule",
      input: { strategy: "fabricate_alibi" },
      issues: [
        expect.objectContaining({
          path: ["strategy"],
          received: '"fabricate_alibi"',
        }),
      ],
      rawResponse: expect.objectContaining({
        content: '{"strategy":"fabricate_alibi"}',
      }),
    });
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain('received "fabricate_alibi"');
    }
  });
});
