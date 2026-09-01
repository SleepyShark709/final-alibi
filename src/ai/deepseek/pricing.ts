import type { ModelTier, ModelUsage } from "@/ai/model-provider";

export type PricingWindow = "off_peak" | "peak";

interface MillionTokenRatesCny {
  cacheHitInput: number;
  cacheMissInput: number;
  output: number;
}

const rates: Record<ModelTier, Record<PricingWindow, MillionTokenRatesCny>> = {
  flash: {
    off_peak: { cacheHitInput: 0.05, cacheMissInput: 1.5, output: 4.5 },
    peak: { cacheHitInput: 0.1, cacheMissInput: 3, output: 9 },
  },
  pro: {
    off_peak: { cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 },
    peak: { cacheHitInput: 0.3, cacheMissInput: 9, output: 27 },
  },
};

export function estimateDeepSeekCostMicrosCny(
  tier: ModelTier,
  usage: ModelUsage,
  window: PricingWindow,
): number {
  const selected = rates[tier][window];
  const cachedInputTokens = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);

  return Math.round(
    cachedInputTokens * selected.cacheHitInput +
      uncachedInputTokens * selected.cacheMissInput +
      usage.outputTokens * selected.output,
  );
}

export function microsCnyToCny(micros: number): number {
  return micros / 1_000_000;
}

export function pricingWindowAt(date: Date): PricingWindow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  const isPeakHour = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  return isWeekday && isPeakHour ? "peak" : "off_peak";
}
