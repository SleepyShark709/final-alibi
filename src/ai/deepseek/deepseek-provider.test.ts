import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  callConfigs: [] as Array<Record<string, unknown>>,
  invocations: [] as unknown[],
  content: '{"verdict":"ok"}' as unknown,
}));

vi.mock("@langchain/deepseek", () => ({
  ChatDeepSeek: class {
    withConfig(config: Record<string, unknown>) {
      harness.callConfigs.push(config);
      return {
        invoke: async (messages: unknown) => {
          harness.invocations.push(messages);
          return {
            id: "mock-response",
            content: harness.content,
            additional_kwargs: {},
            response_metadata: {},
            _getType: () => "ai",
          };
        },
      };
    }
  },
}));

import { DeepSeekModelProvider } from "./deepseek-provider";

const resultSchema = z.object({ verdict: z.string() }).strict();

describe("DeepSeekModelProvider structured output", () => {
  it("uses the raw JSON API for DeepSeek V4 and supplies the actual schema to the model", async () => {
    harness.callConfigs.length = 0;
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

    await expect(
      provider.invokeStructured({
        tier: "pro",
        schema: resultSchema,
        schemaName: "test_result",
        messages: [{ role: "user", content: "Return the test result." }],
      }),
    ).rejects.toThrow(
      'DeepSeek returned no parseable JSON for structured output "test_result" (empty content, finish_reason=unknown)',
    );
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
});
