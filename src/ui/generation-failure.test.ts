import { describe, expect, it } from "vitest";

import { generationFailureMessage } from "./generation-failure";

describe("generationFailureMessage", () => {
  it("keeps the job identifier, attempt count, and worker error visible", () => {
    expect(
      generationFailureMessage({
        id: "job_abc123",
        attempts: 1,
        maxAttempts: 3,
        error: "CaseGenerationRejectedError: evidence chain is incomplete",
      }),
    ).toBe(
      "这起案件暂时未能完成生成。任务 ID：job_abc123；尝试：1/3。原始错误：CaseGenerationRejectedError: evidence chain is incomplete",
    );
  });

  it("asks the operator to inspect worker logs when no error was persisted", () => {
    expect(
      generationFailureMessage({
        id: "job_missing_error",
        attempts: 3,
        maxAttempts: 3,
        error: null,
      }),
    ).toBe(
      "这起案件暂时未能完成生成。任务 ID：job_missing_error；尝试：3/3。Worker 未记录原始错误，请查看 worker 终端日志。",
    );
  });
});
