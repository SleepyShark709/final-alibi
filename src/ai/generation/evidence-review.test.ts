import { describe, expect, it } from "vitest";

import { parseCaseArtifact } from "@/domain/case/case-artifact";

import { buildEvidenceReviewPlan, validateEvidenceReview, type EvidenceReviewPlan } from "./evidence-review";
import { buildBlindSolveInput, buildEvidenceReviewMessages, buildOpeningReviewMessages } from "./generation-prompts";
import { evidenceReviewSchema } from "./generation-schema";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";

// 真实五人验收中曾被旧 issues:[] 协议放行的原稿；保留原始文本和取得链。
const inn = parseCaseArtifact(innCounterexample);

function source(plan: EvidenceReviewPlan, evidenceId: string, field = "description") {
  return plan.sources.find((item) => item.evidenceId === evidenceId && item.path.endsWith(field))!;
}

describe("explicit evidence review obligations", () => {
  it("enumerates every original inn relation, required interview and the public crime window", () => {
    const plan = buildEvidenceReviewPlan(inn);
    expect(plan.obligations).toHaveLength(27);
    expect(plan.obligations.filter((item) => item.kind === "public_window")).toHaveLength(1);
    expect(plan.obligations.filter((item) => item.kind === "interview_lead")).toHaveLength(7);
    for (const evidence of inn.evidence) {
      for (const [kind, targets] of [
        ["supports", evidence.supportsFactIds], ["implicates", evidence.implicatesCharacterIds],
        ["excludes", evidence.excludesCharacterIds], ["contradicts", evidence.contradictsClaimIds],
      ] as const) {
        for (const targetId of targets) expect(plan.obligations).toContainEqual(expect.objectContaining({ kind, evidenceId: evidence.id, targetId }));
      }
    }
  });

  it("also audits necessary prerequisite interviews even when they are not critical or directly required", () => {
    const plan = buildEvidenceReviewPlan(inn);
    expect(inn.solution.requiredEvidenceIds).not.toContain("evidence_lin_testimony");
    expect(plan.obligations).toContainEqual(expect.objectContaining({ kind: "interview_lead", evidenceId: "evidence_lin_testimony" }));
  });

  it("accepts the public briefing as a possible source of a bounded crime window", () => {
    const artifact = structuredClone(inn);
    artifact.briefing = "巡警确认死者22:10仍活着，22:30首次发现死亡，现场记录将遭袭窗口限定在这二十分钟。";
    const plan = buildEvidenceReviewPlan(artifact);
    const briefing = plan.sources.find((item) => item.path === "briefing")!;
    expect(plan.obligations[0]!.allowedSourceIds).toContain(briefing.id);
    const review = makeSupportedEvidenceReview(plan);
    review.results[0]!.citations = [{ sourceId: briefing.id, aspects: ["window"] }];
    review.results[0]!.publicWindow!.startSourceIds = [briefing.id];
    review.results[0]!.publicWindow!.endSourceIds = [briefing.id];
    expect(validateEvidenceReview(plan, review)).toEqual([]);
  });

  it("keeps private occurrence and truth times out of blind and opening review inputs", () => {
    const changed = structuredClone(inn);
    changed.setting.occurredAt = "2099-01-01T03:17:00+08:00";
    changed.timeline = changed.timeline.map((event) => ({ ...event, timestamp: changed.setting.occurredAt, description: "不可公开的内幕时间。" }));
    expect(buildBlindSolveInput(changed).messages).toEqual(buildBlindSolveInput(inn).messages);
    expect(buildOpeningReviewMessages(changed)).toEqual(buildOpeningReviewMessages(inn));
    for (const messages of [buildBlindSolveInput(inn).messages, buildOpeningReviewMessages(inn)]) {
      expect(JSON.parse(messages[1]!.content).setting).toEqual({ era: inn.setting.era, place: inn.setting.place });
    }
  });

  it("rejects the old empty-issues green light at the schema boundary", () => {
    expect(evidenceReviewSchema.safeParse({ issues: [] }).success).toBe(false);
  });

  it.each(["empty", "missing", "duplicate", "unknown"])("rejects %s coverage instead of filtering it to a green light", (mode) => {
    const plan = buildEvidenceReviewPlan(inn);
    const review = makeSupportedEvidenceReview(plan);
    if (mode === "empty") review.results = [];
    if (mode === "missing") review.results.pop();
    if (mode === "duplicate") review.results[1] = review.results[0]!;
    if (mode === "unknown") review.results[0]!.obligationId = "not_requested";
    expect(validateEvidenceReview(plan, review)).toContainEqual(expect.objectContaining({ code: "evidence_review_incomplete" }));
  });

  it("forbids Lin's later phone location and the interview narrator as proof of his earlier testimony", () => {
    const plan = buildEvidenceReviewPlan(inn);
    const obligation = plan.obligations.find((item) => item.evidenceId === "evidence_lin_testimony" && item.kind === "contradicts")!;
    const phone = source(plan, "evidence_lin_phone");
    expect(obligation.allowedSourceIds).toContain(source(plan, "evidence_locked_phone").id);
    expect(obligation.allowedSourceIds).toContain(source(plan, "evidence_lin_testimony", "dialogueUtterance").id);
    expect(obligation.allowedSourceIds).not.toContain(phone.id);
    expect(source(plan, "evidence_lin_testimony")).toBeUndefined();
    const review = makeSupportedEvidenceReview(plan);
    review.results.find((item) => item.obligationId === obligation.id)!.citations = [{ sourceId: phone.id, aspects: ["basis"] }];
    expect(validateEvidenceReview(plan, review)).toContainEqual(expect.objectContaining({
      code: "evidence_narrative_mismatch", message: expect.stringContaining("不能使用的来源"),
    }));
  });

  it("retains transitive mandatory prerequisites without admitting the target's successors", () => {
    const artifact = structuredClone(inn);
    artifact.evidence.find((item) => item.id === "evidence_locked_phone")!.discovery.prerequisiteEvidenceIds = ["evidence_body_wound"];
    const plan = buildEvidenceReviewPlan(artifact);
    const obligation = plan.obligations.find((item) => item.evidenceId === "evidence_lin_testimony" && item.kind === "contradicts")!;
    expect(obligation.allowedSourceIds).toContain(source(plan, "evidence_body_wound").id);
    expect(obligation.allowedSourceIds).not.toContain(source(plan, "evidence_lin_phone").id);
  });

  it("does not give Zheng's sound testimony a weapon comparison it has not obtained", () => {
    const plan = buildEvidenceReviewPlan(inn);
    const obligation = plan.obligations.find((item) => item.evidenceId === "evidence_zheng_testimony" && item.kind === "supports")!;
    expect(obligation.targetId).toBe("fact_method_blunt");
    expect(obligation.allowedSourceIds).toContain(source(plan, "evidence_body_wound").id);
    expect(obligation.allowedSourceIds).not.toContain(source(plan, "evidence_paperweight").id);
    const review = makeSupportedEvidenceReview(plan);
    Object.assign(review.results.find((item) => item.obligationId === obligation.id)!, {
      verdict: "unsupported", citations: [], reason: "争吵和一声砰没有证明铜镇纸多次击打；前置也没有凶器比对。",
    });
    expect(validateEvidenceReview(plan, review)).toContainEqual(expect.objectContaining({ message: expect.stringContaining("fact_method_blunt") }));
    expect(buildEvidenceReviewMessages(inn)[0]!.content).toContain("合证必须支持完整命题");
  });

  it.each(["unsupported", "uncertain"] as const)("does not discard an explicit %s verdict with no positive citations", (verdict) => {
    const plan = buildEvidenceReviewPlan(inn);
    const review = makeSupportedEvidenceReview(plan);
    Object.assign(review.results[0]!, { verdict, citations: [], reason: "原文没有公开实施窗口的依据。" });
    expect(validateEvidenceReview(plan, review)).toContainEqual(expect.objectContaining({ path: "timeline", message: expect.stringContaining("实施窗口") }));
  });

  it("requires identity, location and time coverage for an exclusion, not just a generic log", () => {
    const plan = buildEvidenceReviewPlan(inn);
    const obligation = plan.obligations.find((item) => item.evidenceId === "evidence_boiler_log" && item.kind === "excludes")!;
    const review = makeSupportedEvidenceReview(plan);
    review.results.find((item) => item.obligationId === obligation.id)!.citations[0]!.aspects = ["window"];
    expect(validateEvidenceReview(plan, review)).toContainEqual(expect.objectContaining({ message: expect.stringContaining("identity, location") }));
  });

  it("cannot cite private truth as the player's time-window evidence", () => {
    const plan = buildEvidenceReviewPlan(inn);
    const review = makeSupportedEvidenceReview(plan);
    review.results[0]!.citations = [{ sourceId: "truthTimeline", aspects: ["window"] }];
    expect(validateEvidenceReview(plan, review)).toContainEqual(expect.objectContaining({ path: "timeline", message: expect.stringContaining("不能使用的来源") }));
    expect(plan.sources.some((item) => item.path.startsWith("timeline"))).toBe(false);
  });

  it("keeps the complete source including negation, while distinguishing suspicion from a contradiction", () => {
    const artifact = structuredClone(inn);
    const testimony = artifact.evidence.find((item) => item.id === "evidence_wu_testimony")!;
    testimony.discovery.dialogueUtterance = "我没看到林进入书房，只看到他从书房方向走来。";
    const plan = buildEvidenceReviewPlan(artifact);
    expect(source(plan, testimony.id, "dialogueUtterance").text).toBe(testimony.discovery.dialogueUtterance);
    const prompt = buildEvidenceReviewMessages(artifact)[0]!.content;
    expect(prompt).toContain("手机在书房附近不等于本人进入书房");
    expect(prompt).toContain("不等于看到本人从书房门出来");
  });

  it("allows a later verification to establish the complete method from mandatory wound and weapon sources", () => {
    const artifact = structuredClone(inn);
    const verification = structuredClone(artifact.evidence.find((item) => item.id === "evidence_body_wound")!);
    verification.id = "evidence_complete_method_verification";
    verification.description = "法医逐一对照头部伤口与已取得的铜镇纸：至少三处创口的边缘、间距均吻合；确认该铜镇纸多次击打导致死亡。";
    verification.discovery.prerequisiteEvidenceIds = ["evidence_body_wound", "evidence_paperweight"];
    verification.supportsFactIds = ["fact_method_blunt"];
    artifact.evidence.push(verification);
    const plan = buildEvidenceReviewPlan(artifact);
    const obligation = plan.obligations.find((item) => item.evidenceId === verification.id && item.kind === "supports")!;
    expect(obligation.allowedSourceIds).toEqual(expect.arrayContaining([source(plan, "evidence_body_wound").id, source(plan, "evidence_paperweight").id, source(plan, verification.id).id]));
    expect(validateEvidenceReview(plan, makeSupportedEvidenceReview(plan))).toEqual([]);
  });

  it("permits a later witness confirmation to cite an already acquired independently identified full-window log", () => {
    const artifact = structuredClone(inn);
    const log = artifact.evidence.find((item) => item.id === "evidence_boiler_log")!;
    log.description = "已调取锅炉房连续录像：21:00至23:00清楚拍到孙在远端锅炉间检修；同事当场核对本人面容，期间没有离开，往返书房至少需十分钟。";
    const testimony = structuredClone(artifact.evidence.find((item) => item.id === "evidence_lin_testimony")!);
    testimony.id = "evidence_confirmed_maintenance_testimony";
    testimony.supportsFactIds = ["fact_alibi_sun"];
    testimony.contradictsClaimIds = [];
    testimony.implicatesCharacterIds = [];
    testimony.discovery.characterId = log.excludesCharacterIds[0];
    testimony.discovery.prerequisiteEvidenceIds = [log.id];
    testimony.discovery.dialogueUtterance = "你们取得并核验的那段锅炉房录像里是我，那段时间我一直在做检修。";
    artifact.evidence.push(testimony);
    const plan = buildEvidenceReviewPlan(artifact);
    const obligation = plan.obligations.find((item) => item.evidenceId === testimony.id && item.kind === "supports")!;
    expect(obligation.allowedSourceIds).toContain(source(plan, log.id).id);
    expect(validateEvidenceReview(plan, makeSupportedEvidenceReview(plan))).toEqual([]);
  });

  it("requires an actual handover before an interview-delivered record can act as proof", () => {
    const artifact = structuredClone(inn);
    const testimony = artifact.evidence.find((item) => item.id === "evidence_lin_testimony")!;
    testimony.kind = "digital";
    testimony.discovery.dialogueUtterance = "我可以提供手机记录，之后你们可以去查。";
    const plan = buildEvidenceReviewPlan(artifact);
    const delivery = plan.obligations.find((item) => item.evidenceId === testimony.id && item.kind === "record_delivery")!;
    expect(delivery.allowedSourceIds).not.toContain(source(plan, testimony.id).id);
    const review = makeSupportedEvidenceReview(plan);
    Object.assign(review.results.find((item) => item.obligationId === delivery.id)!, {
      verdict: "unsupported", citations: [], reason: "实际台词只是未来提供的承诺，没有交付记录。",
    });
    expect(validateEvidenceReview(plan, review)).toContainEqual(expect.objectContaining({ message: expect.stringContaining("record_delivery") }));
  });
});
