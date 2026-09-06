import { createServer } from "node:http";
import { once } from "node:events";

import { expect, it } from "vitest";
import { z } from "zod";

import { DeepSeekModelProvider } from "./deepseek-provider";

it("a request retry budget of zero makes exactly one actual HTTP attempt despite the provider default", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "local retry test failure", type: "server_error" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local server address");
    const provider = new DeepSeekModelProvider({
      apiKey: "local-test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      proModel: "deepseek-v4-pro", maxRetries: 3, timeoutMs: 2_000,
    });
    await expect(provider.invokeStructured({
      tier: "pro", schema: z.object({ ok: z.boolean() }), schemaName: "retry_budget",
      messages: [{ role: "user", content: "Return JSON." }],
      reasoning: true, reasoningEffort: "low", maxTokens: 3_200, maxRetries: 0,
    })).rejects.toMatchObject({ status: 500 });
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
