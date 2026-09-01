import { describe, expect, it } from "vitest";

import type { CaseReportResult } from "@/domain/game/game-runtime";

import { deterministicFeedback } from "./report-feedback-service";

describe("deterministic report feedback", () => {
  it("explains an early solved report without treating it as a complete dossier", () => {
    const report: CaseReportResult = {
      verdict: "solved",
      score: 55,
      breakdown: {
        culprit: 40,
        motive: 15,
        method: 0,
        evidence: 0,
        timeline: 0,
        hintPenalty: 0,
      },
      submitted: {
        culpritId: "suspect_a",
        motiveFactId: "motive_a",
        methodFactId: "method_wrong",
        evidenceIds: [],
        timelineEventIds: [],
        reasoning: "证据不足。",
      },
      correct: {
        culprit: true,
        motive: true,
        method: false,
        evidence: false,
        timeline: false,
      },
      missedEvidenceIds: ["evidence_a"],
      missedTimelineEventIds: ["event_a"],
    };

    const feedback = deterministicFeedback(report);

    expect(feedback.summary).toContain("提前结案");
    expect(feedback.strengths).toEqual([
      "正确锁定了真凶。",
      "动机判断与案件事实吻合。",
    ]);
    expect(feedback.gaps).toContain("作案手法的还原存在偏差。");
    expect(report.score).toBe(55);
  });
});
