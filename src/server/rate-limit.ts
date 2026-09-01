import { HttpError } from "./http-error";

interface Counter {
  count: number;
  resetsAt: number;
}

const counters = new Map<string, Counter>();

export function enforceRateLimit(
  key: string,
  options: { limit: number; windowMs: number },
) {
  const now = Date.now();
  const current = counters.get(key);
  if (!current || current.resetsAt <= now) {
    counters.set(key, { count: 1, resetsAt: now + options.windowMs });
    return;
  }
  if (current.count >= options.limit) {
    throw new HttpError(429, "rate_limited", "操作太频繁，请稍后再试。");
  }
  current.count += 1;

  if (counters.size > 5_000) {
    for (const [counterKey, counter] of counters) {
      if (counter.resetsAt <= now) counters.delete(counterKey);
    }
  }
}
