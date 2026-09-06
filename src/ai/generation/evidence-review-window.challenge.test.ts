import { describe, expect, it } from "vitest";

import { parseCaseArtifact } from "@/domain/case/case-artifact";

import {
  buildEvidenceReviewPlan,
  evidenceReviewHasProtocolViolation,
  extractPublicWindow,
  validateEvidenceReview,
  type EvidenceReviewPlan,
} from "./evidence-review";
import { buildEvidenceReviewMessages } from "./generation-prompts";
import { evidenceReviewSchema, type EvidenceReviewResult } from "./generation-schema";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";

// 原社区案 v5 的公开原文；代码仅验窗口契约，原文能否推出边界另由真实模型校准。
const sources: EvidenceReviewPlan["sources"] = [
  { id: "s6", path: "evidence[6].discovery.dialogueUtterance", evidenceId: "evidence_wang_testimony", text: "我21:50看到陈国栋和周明在活动室争执。" },
  { id: "s15", path: "briefing", text: "2024年11月12日晚，社区活动中心举办夜间值守活动，参与者包括中心管理员、志愿者和附近居民。当晚22时左右，活动结束后众人陆续离开，但管理员在次日清晨发现志愿者周明死在活动室。警方到场时，现场有打斗痕迹，周明头部有钝器伤。初步了解，当晚最后离开的三人分别是管理员陈国栋、志愿者李芳和居民赵强，另有两位证人曾短暂停留。" },
  { id: "s10", path: "evidence[10].description", evidenceId: "evidence_convenience_store", text: "监控显示李芳在22:00-22:15在便利店购物，期间未离开。" },
  { id: "s4", path: "evidence[4].discovery.dialogueUtterance", evidenceId: "evidence_li_testimony", text: "我22点左右在便利店买东西，有监控和小票。" },
];
const windowObligation: EvidenceReviewPlan["obligations"][number] = {
  id: "o0", kind: "public_window", path: "timeline", allowedSourceIds: sources.map((source) => source.id), requiredAspects: ["window"],
};
const exclusion: EvidenceReviewPlan["obligations"][number] = {
  id: "o13", kind: "excludes", path: "evidence[10]", evidenceId: "evidence_convenience_store",
  targetId: "character_li_fang", allowedSourceIds: ["s10", "s4"], requiredAspects: ["identity", "location", "window"],
};
const windowPlan: EvidenceReviewPlan = { obligations: [windowObligation], sources };
const exclusionPlan: EvidenceReviewPlan = { obligations: [exclusion], sources: sources.filter((source) => exclusion.allowedSourceIds.includes(source.id)) };
const combinedPlan: EvidenceReviewPlan = { obligations: [windowObligation, exclusion], sources };
const interval = {
  startAt: "2024-11-12T21:50:00+08:00", endAt: "2024-11-13T12:00:00+08:00",
  startSourceIds: ["s6"], endSourceIds: ["s15"],
};

function windowResult(): EvidenceReviewResult["results"][number] {
  return {
    obligationId: "o0", verdict: "supported", publicWindow: structuredClone(interval),
    citations: [{ sourceId: "s6", aspects: ["window"] }, { sourceId: "s15", aspects: ["window"] }],
    reason: "最后见活到次日清晨发现；发现时刻不精确，使用保守外界。",
  };
}

function falseExclusion(): EvidenceReviewResult["results"][number] {
  return {
    obligationId: "o13", verdict: "supported", citations: [{ sourceId: "s10", aspects: ["identity", "location", "window"] }],
    coverage: {
      startAt: "2024-11-12T22:00:00+08:00", endAt: "2024-11-12T22:15:00+08:00",
      startSourceIds: ["s10"], endSourceIds: ["s10"],
    },
    reason: "22:00-22:15覆盖作者的22:05，因此可以排除。",
  };
}

function rejectsWindow(result: EvidenceReviewResult["results"][number]) {
  const parsed = evidenceReviewSchema.safeParse({ results: [result] });
  return !parsed.success || evidenceReviewHasProtocolViolation(windowPlan, parsed.data) ||
    extractPublicWindow(windowPlan, parsed.data) === null || validateEvidenceReview(windowPlan, parsed.data).length > 0;
}

describe("independent public window contract challenge", () => {
  it("retains both separately cited bounds of a supported public interval", () => {
    const review = evidenceReviewSchema.parse({ results: [windowResult()] });
    expect(evidenceReviewHasProtocolViolation(windowPlan, review)).toBe(false);
    expect(extractPublicWindow(windowPlan, review)).toEqual(interval);
    expect(validateEvidenceReview(windowPlan, review)).toEqual([]);
  });

  it.each(["point", "reversed"])("rejects a %s window even when both citations are allowed", (kind) => {
    const result = windowResult();
    result.publicWindow!.endAt = kind === "point" ? interval.startAt : "2024-11-12T21:49:00+08:00";
    expect(rejectsWindow(result)).toBe(true);
  });

  it.each(["foreign_start", "foreign_end", "uncited_bound", "basis_only"])("rejects a window with %s provenance", (kind) => {
    const result = windowResult();
    if (kind === "foreign_start") result.publicWindow!.startSourceIds = ["private_truth_timeline"];
    if (kind === "foreign_end") result.publicWindow!.endSourceIds = ["another_batch_source"];
    if (kind === "uncited_bound") result.citations = result.citations.filter((citation) => citation.sourceId !== "s15");
    if (kind === "basis_only") result.citations.find((citation) => citation.sourceId === "s15")!.aspects = ["basis"];
    expect(rejectsWindow(result)).toBe(true);
  });

  it("does not accept a supported window with no explicit bounds", () => {
    const result = windowResult();
    delete result.publicWindow;
    expect(rejectsWindow(result)).toBe(true);
  });

  it.each(["unsupported", "uncertain"] as const)("cannot use a %s window to admit an exclusion", (verdict) => {
    const rejectedWindow = { obligationId: "o0", verdict, citations: [], reason: "公开窗口尚未证实。" };
    const review: EvidenceReviewResult = { results: [rejectedWindow, falseExclusion()] };
    expect(extractPublicWindow(combinedPlan, review)).toBeNull();
    expect(validateEvidenceReview(combinedPlan, review).some((issue) => issue.path === exclusion.path && issue.message.includes("exclusions"))).toBe(true);
  });

  it("requires a certified upstream window for a standalone exclusion batch", () => {
    const review = { results: [falseExclusion()] };
    expect(validateEvidenceReview(exclusionPlan, review).some((issue) => issue.path === exclusion.path)).toBe(true);
  });

  it("cannot smuggle a replacement window on an exclusion result", () => {
    const review: EvidenceReviewResult = { results: [{ ...falseExclusion(), publicWindow: structuredClone(interval) }] };
    expect(extractPublicWindow(exclusionPlan, review)).toBeNull();
    expect(evidenceReviewHasProtocolViolation(exclusionPlan, review)).toBe(true);
    expect(validateEvidenceReview(exclusionPlan, review).some((issue) => issue.path === exclusion.path)).toBe(true);
  });

  it("keeps downstream inputs unchanged when only internal occurrence and truth timeline change", () => {
    const artifact = parseCaseArtifact(innCounterexample);
    const batch = { index: 1, count: 2, publicWindowContext: sources.slice(0, 2), publicWindow: structuredClone(interval) };
    const original = buildEvidenceReviewMessages(artifact, exclusionPlan, batch);
    const changed = structuredClone(artifact);
    changed.setting.occurredAt = "2099-01-01T03:17:00+08:00";
    changed.timeline = changed.timeline.map((event) => ({ ...event, timestamp: "2099-01-01T03:17:00+08:00", description: "仅作者可见的真相时间线哨兵。" }));
    expect(buildEvidenceReviewMessages(changed, exclusionPlan, batch)).toEqual(original);
    const payload = JSON.parse(original[1]!.content);
    expect(payload.setting).toEqual({ era: artifact.setting.era, place: artifact.setting.place });
    expect(payload).not.toHaveProperty("truthTimeline");
    expect(payload.publicWindow).toEqual(interval);
    expect(payload.publicWindowContext).toEqual(sources.slice(0, 2));
  });

  it("rejects the actual model claim that 22:00-22:15 covers 21:50 through the following noon", () => {
    const review = { results: [falseExclusion()] };
    expect(evidenceReviewHasProtocolViolation(exclusionPlan, review)).toBe(false);
    expect(validateEvidenceReview(exclusionPlan, review, interval).some((issue) => issue.path === exclusion.path)).toBe(true);
    expect(review.results[0]!.verdict).toBe("supported");
  });

  it.each(["missing", "point", "reversed", "foreign_bound", "uncited_bound"])("rejects %s evidence coverage despite an accepted upstream window", (kind) => {
    const result = falseExclusion();
    if (kind === "missing") delete result.coverage;
    if (kind === "point") result.coverage!.endAt = result.coverage!.startAt;
    if (kind === "reversed") result.coverage!.endAt = "2024-11-12T21:59:00+08:00";
    if (kind === "foreign_bound") result.coverage!.startSourceIds = ["s15"];
    if (kind === "uncited_bound") result.coverage!.endSourceIds = ["s4"];
    const review = { results: [result] };
    expect(evidenceReviewHasProtocolViolation(exclusionPlan, review)).toBe(true);
    expect(validateEvidenceReview(exclusionPlan, review, interval).some((issue) => issue.path === exclusion.path)).toBe(true);
  });

  it("accepts complete coverage and compares absolute instants across different UTC offsets", () => {
    const result = falseExclusion();
    result.coverage!.startAt = "2024-11-12T14:00:00Z";
    result.coverage!.endAt = "2024-11-12T15:15:00+01:00";
    result.reason = "此连续在场区间包含本测试给定的上游完整公开窗口。";
    const acceptedNarrowWindow = { ...interval, startAt: "2024-11-12T22:02:00+08:00", endAt: "2024-11-12T22:12:00+08:00" };
    const review = { results: [result] };
    expect(evidenceReviewHasProtocolViolation(exclusionPlan, review)).toBe(false);
    expect(validateEvidenceReview(exclusionPlan, review, acceptedNarrowWindow)).toEqual([]);
  });

  it("does not permit a non-temporal fact to introduce its own coverage interval", () => {
    const obligation: EvidenceReviewPlan["obligations"][number] = {
      ...exclusion, kind: "supports", targetId: "fact_method", requiredAspects: ["basis"],
    };
    const plan = { ...exclusionPlan, obligations: [obligation] };
    const result = falseExclusion();
    result.citations[0]!.aspects = ["basis"];
    expect(evidenceReviewHasProtocolViolation(plan, { results: [result] })).toBe(true);
  });

  it("assigns identity, location and full window requirements to alibi supports", () => {
    const artifact = parseCaseArtifact(innCounterexample);
    const alibiFactIds = new Set(artifact.facts.filter((fact) => fact.type === "alibi").map((fact) => fact.id));
    const obligations = buildEvidenceReviewPlan(artifact).obligations.filter((obligation) => obligation.kind === "supports" && alibiFactIds.has(obligation.targetId!));
    expect(obligations.length).toBeGreaterThan(0);
    expect(obligations.every((obligation) => ["basis", "identity", "location", "window"].every((aspect) => obligation.requiredAspects.includes(aspect as typeof obligation.requiredAspects[number])))).toBe(true);
  });

  it("applies the same missing-window and interval-containment gate to alibi supports", () => {
    const obligation: EvidenceReviewPlan["obligations"][number] = {
      ...exclusion, kind: "supports", targetId: "fact_alibi_li", requiredAspects: ["basis", "identity", "location", "window"],
    };
    const plan = { ...exclusionPlan, obligations: [obligation] };
    const result = falseExclusion();
    result.citations[0]!.aspects = ["basis", "identity", "location", "window"];
    const review = { results: [result] };
    expect(evidenceReviewHasProtocolViolation(plan, review)).toBe(false);
    expect(validateEvidenceReview(plan, review).some((issue) => issue.path === obligation.path)).toBe(true);
    expect(validateEvidenceReview(plan, review, interval).some((issue) => issue.path === obligation.path)).toBe(true);
    const acceptedNarrowWindow = { ...interval, startAt: "2024-11-12T22:02:00+08:00", endAt: "2024-11-12T22:12:00+08:00" };
    expect(validateEvidenceReview(plan, review, acceptedNarrowWindow)).toEqual([]);
  });
});
