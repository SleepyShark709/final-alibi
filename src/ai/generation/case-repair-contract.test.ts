import { describe, expect, it } from "vitest";
import { z } from "zod";

import { applyCaseArtifactRepairPatch, caseArtifactRepairPatchSchema, parseCaseArtifact } from "@/domain/case/case-artifact";
import { solveCaseWithEvidenceIds } from "@/domain/case/case-solver";

import { buildCaseRepairContract } from "./case-repair-contract";
import type { PublicWindowReview } from "./generation-schema";
import { buildCaseDraftMessages, buildCaseRepairMessages, buildEvidenceReviewMessages } from "./generation-prompts";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";
import truncatedRepair from "./testing/fixtures/theatre-truncated-repair.json";

const inn = parseCaseArtifact(innCounterexample);

function methodRepair() {
  const index = inn.evidence.findIndex((item) => item.id === "evidence_zheng_testimony");
  const issues = [{ code: "evidence_narrative_mismatch", path: `evidence[${index}]`, message: "一声砰不能支持完整铜镇纸多次击打手法，需要实际比对。" }];
  return { issues, contract: buildCaseRepairContract(inn, issues) };
}

describe("proof repair response scope", () => {
  it("rejects the actual truncated theatre response's complete prefix that rewrote unchanged metadata and all thirteen clues", () => {
    const artifact = parseCaseArtifact(truncatedRepair.draft);
    const contract = buildCaseRepairContract(artifact, truncatedRepair.issues);
    expect(contract.scope).not.toBeNull();
    expect(() => JSON.parse(truncatedRepair.truncatedResponse)).toThrow();
    const solutionStart = truncatedRepair.truncatedResponse.lastIndexOf(',\n  "solution"');
    expect(solutionStart).toBeGreaterThan(0);
    // 原输出的完整顶层前缀；没有把截断尾部修补成新的模型结果。
    const repeatedPrefix = JSON.parse(`${truncatedRepair.truncatedResponse.slice(0, solutionStart)}\n}`);
    expect(repeatedPrefix.evidence).toHaveLength(13);
    expect(caseArtifactRepairPatchSchema.safeParse(repeatedPrefix).success).toBe(true);
    expect(contract.schema.safeParse(repeatedPrefix).success).toBe(false);
    const schema = z.toJSONSchema(contract.schema);
    expect(schema.properties).not.toHaveProperty("title");
    expect(schema.properties).not.toHaveProperty("briefing");
    expect(schema.properties).not.toHaveProperty("culpritId");
    expect(schema.properties).not.toHaveProperty("victimId");
  });

  it("accepts and applies a changed target's real utterance, prerequisite and support together, preserving other fields", () => {
    const { contract } = methodRepair();
    const patch = contract.schema.parse({ evidence: [{
      id: "evidence_zheng_testimony",
      description: "郑补充了听到声音的准确位置，但没有辨认凶器；相关物件仍需检验。",
      supportsFactIds: [],
      discovery: { dialogueUtterance: "我只听到争吵和一声响，没看到是谁，也不知道用的是什么。", prerequisiteEvidenceIds: ["evidence_body_wound", "evidence_paperweight"] },
    }] });
    const result = applyCaseArtifactRepairPatch(inn, patch);
    expect(result.evidence.find((item) => item.id === "evidence_zheng_testimony")).toMatchObject(patch.evidence![0]!);
    expect(result.characters).toEqual(inn.characters);
    expect(result.title).toBe(inn.title);
    expect(result.evidence.find((item) => item.id === "evidence_kitchen_log")).toEqual(inn.evidence.find((item) => item.id === "evidence_kitchen_log"));
  });

  it("does not let an unrelated existing evidence id escape the target set by supplying a full object", () => {
    const { contract } = methodRepair();
    const unrelated = inn.evidence.find((item) => item.id === "evidence_kitchen_log")!;
    expect(contract.scope!.existingEvidenceIds).not.toContain(unrelated.id);
    expect(contract.schema.safeParse({ evidence: [{ id: unrelated.id, description: "无关重写" }] }).success).toBe(false);
    expect(contract.schema.safeParse({ evidence: [unrelated] }).success).toBe(false);
  });

  it("permits a complete new verification with a real discovery route and necessary fact/solution updates", () => {
    const { contract } = methodRepair();
    const verification = structuredClone(inn.evidence.find((item) => item.id === "evidence_body_wound")!);
    verification.id = "record_weapon_wound_comparison";
    verification.name = "伤口与铜镇纸比对报告";
    verification.description = "检验员比对已取得的伤口记录和铜镇纸，确认至少三处吻合创口由该物反复击打造成。";
    verification.supportsFactIds = [inn.solution.methodFactId];
    verification.discovery.method = "analyze";
    verification.discovery.prerequisiteEvidenceIds = ["evidence_body_wound", "evidence_paperweight"];
    const patch = contract.schema.parse({
      evidence: [verification],
      facts: [{ id: inn.solution.methodFactId, statement: "受害者遭铜镇纸多次钝击致死。" }],
      solution: { requiredEvidenceIds: [...inn.solution.requiredEvidenceIds, verification.id] },
    });
    const result = applyCaseArtifactRepairPatch(inn, patch);
    expect(result.evidence).toContainEqual(verification);
    expect(result.solution.requiredEvidenceIds).toContain(verification.id);
    expect(contract.schema.safeParse({ evidence: [{ id: "evidence_incomplete_new", supportsFactIds: [inn.solution.methodFactId] }] }).success).toBe(false);
  });

  it("allows public time-window evidence without silently rewriting private occurrence time", () => {
    const contract = buildCaseRepairContract(inn, [{ code: "evidence_narrative_mismatch", path: "timeline", message: "玩家尚无公开实施窗口。" }]);
    const patch = contract.schema.parse({
      briefing: "现场已核验22:10最后一次生存通话及22:30发现记录，遭袭发生于这二十分钟内。",
      evidence: [{ id: "evidence_body_wound", description: "法医结合生存通话及发现记录，给出22:10至22:30的遭袭窗口。" }],
    });
    expect(applyCaseArtifactRepairPatch(inn, patch).briefing).toBe(patch.briefing);
    expect(contract.schema.safeParse({ setting: inn.setting }).success).toBe(false);
    expect(contract.schema.safeParse({ timeline: inn.timeline }).success).toBe(false);
    const timestampContract = buildCaseRepairContract(inn, [{ code: "evidence_narrative_mismatch", path: "timeline", message: "setting.occurredAt 与实施事件时间不一致，需要校正记录。" }]);
    expect(timestampContract.schema.safeParse({ setting: inn.setting, timeline: inn.timeline }).success).toBe(true);
  });

  it.each(["公开窗口", "公共窗口"])("recognizes the actual reviewer wording %s for public time repair", (wording) => {
    const index = inn.evidence.findIndex((item) => item.excludesCharacterIds.length > 0);
    const contract = buildCaseRepairContract(inn, [{ code: "evidence_narrative_mismatch", path: `evidence[${index}]`, message: `短时记录不能覆盖${wording}。` }]);
    expect(contract.schema.safeParse({ briefing: inn.briefing }).success).toBe(true);
    expect(contract.schema.safeParse({ setting: inn.setting }).success).toBe(false);
  });

  it("uses structured temporal obligations to admit only the actual public boundary source", () => {
    const index = inn.evidence.findIndex((item) => item.excludesCharacterIds.length > 0);
    const boundary = inn.evidence.find((item) => item.id === "evidence_zheng_testimony")!;
    const context: PublicWindowReview = {
      window: { startAt: "2026-09-01T22:00:00+08:00", endAt: "2026-09-01T22:30:00+08:00", startSourceIds: ["s_boundary"], endSourceIds: ["s_boundary"] },
      sources: [{ id: "s_boundary", path: `evidence[${inn.evidence.indexOf(boundary)}].discovery.dialogueUtterance`, evidenceId: boundary.id, text: boundary.discovery.dialogueUtterance! }],
      temporalEvidenceIds: [inn.evidence[index]!.id],
    };
    const issues = [{ code: "evidence_narrative_mismatch", path: `evidence[${index}]`, message: "这份记录的覆盖不足。" }];
    const contract = buildCaseRepairContract(inn, issues, context);
    expect(contract.scope!.existingEvidenceIds).toContain(boundary.id);
    expect(contract.schema.safeParse({ evidence: [{ id: boundary.id, discovery: { dialogueUtterance: boundary.discovery.dialogueUtterance } }], briefing: inn.briefing }).success).toBe(true);
    expect(contract.schema.safeParse({ evidence: [{ id: "evidence_lin_contract", description: "无关材料不该可改。" }] }).success).toBe(false);
    const payload = JSON.parse(buildCaseRepairMessages({ request: { seed: inn.seed, theme: inn.title, difficulty: "standard" }, draft: inn, issues, repairScope: contract.scope, publicWindowReview: context })[1]!.content);
    expect(payload.repairSnapshot.publicWindowReview).toEqual(context);
    expect(payload.repairSnapshot.structuralLedger.evidence.some((item: { id: string }) => item.id === boundary.id)).toBe(true);
    expect(payload.repairSnapshot.playerFacingText.setting).toEqual({ era: inn.setting.era, place: inn.setting.place });
    expect(payload.repairSnapshot.playerFacingText.characters.every((item: object) => !("privateProfile" in item))).toBe(true);
    expect(payload.repairSnapshot.structuralLedger.setting).toEqual(inn.setting);
    expect(payload.repairSnapshot.structuralLedger.characters.some((item: { privateProfile?: string }) => item.privateProfile)).toBe(true);
  });

  it("allows removal of a false contradiction and its overclaimed fact while keeping future verification possible", () => {
    const index = inn.evidence.findIndex((item) => item.id === "evidence_lin_phone");
    const contract = buildCaseRepairContract(inn, [{ code: "evidence_narrative_mismatch", path: `evidence[${index}]`, message: "定位仅指向手机在附近，不能反驳本人没进入书房。" }]);
    expect(contract.schema.safeParse({ evidence: [{ id: "evidence_lin_phone", supportsFactIds: [], contradictsClaimIds: [] }] }).success).toBe(true);
    expect(contract.scope!.existingEvidenceIds).toContain("evidence_lin_testimony");
  });

  it.each(["invalid_repair_patch", "invalid_lie_strategy", "suspect_count_mismatch"])("keeps the broad structural repair schema for %s", (code) => {
    const contract = buildCaseRepairContract(inn, [{ code, path: "characters", message: "需要结构修复。" }]);
    expect(contract.schema).toBe(caseArtifactRepairPatchSchema);
    expect(contract.scope).toBeNull();
  });

  it("also scopes the validator's non-unique and incomplete required-chain proof issues", () => {
    const contract = buildCaseRepairContract(inn, [
      { code: "non_unique_solution", path: "evidence", message: "remaining candidates need independent exclusions" },
      { code: "insufficient_required_evidence_chain", path: "solution.requiredEvidenceIds", message: "the required chain is incomplete" },
    ]);
    expect(contract.scope).not.toBeNull();
    expect(contract.scope!.existingEvidenceIds).toEqual(expect.arrayContaining(inn.solution.requiredEvidenceIds));
    expect(contract.schema.safeParse({ title: inn.title }).success).toBe(false);
  });

  it("admits an existing exclusion outside the required chain and its fact, person and prerequisite", () => {
    const artifact = structuredClone(inn);
    const verification = artifact.evidence.find((item) => item.id === "evidence_kitchen_log")!;
    artifact.solution.requiredEvidenceIds = artifact.solution.requiredEvidenceIds.filter((id) => id !== verification.id);
    const unrelated = { ...structuredClone(artifact.evidence[0]!), id: "evidence_unrelated_record" };
    artifact.evidence.push(unrelated);
    const before = solveCaseWithEvidenceIds(artifact, artifact.solution.requiredEvidenceIds);
    expect(before.candidateIds).toEqual([artifact.culpritId, "character_suspect_2"]);
    const contract = buildCaseRepairContract(artifact, [{ code: "insufficient_required_evidence_chain", path: "solution.requiredEvidenceIds", message: "the required chain is incomplete" }]);
    expect(contract.scope!.existingEvidenceIds).toEqual(expect.arrayContaining([verification.id, "evidence_wang_testimony"]));
    expect(contract.scope!.existingFactIds).toContain("fact_alibi_wang");
    expect(contract.scope!.characterIds).toContain("character_suspect_2");
    const patch = contract.schema.parse({
      evidence: [{ id: verification.id, description: verification.description }],
      facts: [{ id: "fact_alibi_wang", statement: artifact.facts.find((item) => item.id === "fact_alibi_wang")!.statement }],
      solution: { requiredEvidenceIds: [...artifact.solution.requiredEvidenceIds, verification.id] },
    });
    const result = applyCaseArtifactRepairPatch(artifact, patch);
    expect(solveCaseWithEvidenceIds(result, result.solution.requiredEvidenceIds).status).toBe("unique");
    expect(contract.schema.safeParse({ evidence: [{ id: unrelated.id, description: "无关重写" }] }).success).toBe(false);
    expect(contract.schema.safeParse({ evidence: [unrelated] }).success).toBe(false);
  });

  it("allows a real excluding prerequisite to be named explicitly in the required chain", () => {
    const artifact = structuredClone(inn);
    const prerequisiteId = "evidence_kitchen_log";
    const followup = { ...structuredClone(artifact.evidence[0]!), id: "evidence_kitchen_followup" };
    followup.discovery.prerequisiteEvidenceIds = [prerequisiteId];
    artifact.evidence.push(followup);
    artifact.solution.requiredEvidenceIds = artifact.solution.requiredEvidenceIds.map((id) => id === prerequisiteId ? followup.id : id);
    expect(solveCaseWithEvidenceIds(artifact, artifact.solution.requiredEvidenceIds).status).toBe("ambiguous");
    const contract = buildCaseRepairContract(artifact, [{ code: "insufficient_required_evidence_chain", path: "solution.requiredEvidenceIds", message: "the required chain is incomplete" }]);
    expect(contract.scope!.existingEvidenceIds).toContain(prerequisiteId);
    const result = applyCaseArtifactRepairPatch(artifact, contract.schema.parse({ solution: { requiredEvidenceIds: [...artifact.solution.requiredEvidenceIds, prerequisiteId] } }));
    expect(solveCaseWithEvidenceIds(result, result.solution.requiredEvidenceIds).status).toBe("unique");
  });

  it("includes the actual scope in repair input and applies the same precise-proof rule at all three stages", () => {
    const { contract, issues } = methodRepair();
    const request = { seed: inn.seed, theme: inn.title, difficulty: "standard" as const };
    const repair = buildCaseRepairMessages({ request, draft: inn, issues, repairScope: contract.scope });
    expect(JSON.parse(repair[1]!.content).repairScope).toEqual(contract.scope);
    expect(repair[0]!.content).toContain("已有 evidence/facts 只能修改所列 ID");
    const systems = [buildCaseDraftMessages(request), repair, buildEvidenceReviewMessages(inn)].map((messages) => messages[0]!.content);
    for (const system of systems) {
      expect(system).toMatch(/(?:确切主体、行为和时段|确切主体、行为、时段)/u);
      expect(system).toMatch(/(?:时点|单一时点).{0,10}不证明整段行踪/u);
    }
  });
});
