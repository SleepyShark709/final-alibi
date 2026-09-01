import { describe, expect, it } from "vitest";

import {
  estimateDeepSeekCostMicrosCny,
  microsCnyToCny,
  pricingWindowAt,
} from "./pricing";

describe("DeepSeek pricing", () => {
  it("separates cache hits from cache misses", () => {
    const micros = estimateDeepSeekCostMicrosCny(
      "flash",
      { inputTokens: 100_000, cachedInputTokens: 80_000, outputTokens: 10_000 },
      "off_peak",
    );

    expect(microsCnyToCny(micros)).toBe(0.079);
  });

  it("matches the conservative typical per-game estimate", () => {
    const generation = estimateDeepSeekCostMicrosCny(
      "pro",
      { inputTokens: 85_000, cachedInputTokens: 0, outputTokens: 25_000 },
      "off_peak",
    );
    const play = estimateDeepSeekCostMicrosCny(
      "flash",
      { inputTokens: 175_000, cachedInputTokens: 0, outputTokens: 46_000 },
      "off_peak",
    );

    expect(microsCnyToCny(generation + play)).toBe(1.1895);
  });

  it("uses Beijing weekday peak windows", () => {
    expect(pricingWindowAt(new Date("2026-08-31T02:00:00Z"))).toBe("peak");
    expect(pricingWindowAt(new Date("2026-08-31T05:00:00Z"))).toBe("off_peak");
    expect(pricingWindowAt(new Date("2026-08-30T02:00:00Z"))).toBe("off_peak");
  });
});
