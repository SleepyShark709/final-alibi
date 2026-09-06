import { describe, expect, it } from "vitest";

import type { StructuredModelProvider } from "@/ai/model-provider";
import { parseCaseArtifact } from "@/domain/case/case-artifact";
import type { CaseValidationIssue } from "@/domain/case/case-validator";

import { createCaseGenerationGraph } from "./case-generation-graph";
import { buildCaseRepairContract } from "./case-repair-contract";
import { buildEvidenceReviewPlan, type EvidenceReviewPlan } from "./evidence-review";
import { buildCaseRepairMessages } from "./generation-prompts";
import type { PublicWindowReview } from "./generation-schema";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";

const artifact = parseCaseArtifact(innCounterexample);
const plan = buildEvidenceReviewPlan(artifact);
const targetId = "evidence_office_cctv";
const boundarySource = plan.sources.find((source) => source.evidenceId === "evidence_wu_testimony")!;
const briefingSource = plan.sources.find((source) => source.path === "briefing")!;
const unrelatedSource = plan.sources.find((source) => source.evidenceId === "evidence_zheng_testimony")!;
// 这里只检验已审核上下文的传递和权限，原文能否推出时间另由真实校准审核。
const windowReview: PublicWindowReview = {
  window: {
    startAt: "2024-11-12T21:50:00+08:00", endAt: "2024-11-13T12:00:00+08:00",
    startSourceIds: [boundarySource.id], endSourceIds: [briefingSource.id],
  },
  sources: [boundarySource, briefingSource],
  temporalEvidenceIds: [targetId],
};

function issueFor(evidenceId: string, message: string, code = "evidence_narrative_mismatch"): CaseValidationIssue {
  return { code, path: `evidence[${artifact.evidence.findIndex((evidence) => evidence.id === evidenceId)}]`, message };
}

describe("independent repair public-window challenge", () => {
  it("uses typed temporal context even when a model reason omits every window keyword", () => {
    const context = { ...windowReview, sources: [...windowReview.sources, unrelatedSource] };
    const contract = buildCaseRepairContract(artifact, [issueFor(targetId, "核验仍不充分。")], context);
    expect(contract.scope!.writableFields).toContain("briefing");
    expect(contract.scope!.existingEvidenceIds).toContain(targetId);
    expect(contract.scope!.existingEvidenceIds).toContain(boundarySource.evidenceId);
    expect(contract.scope!.existingEvidenceIds).not.toContain(unrelatedSource.evidenceId);
    expect(contract.schema.safeParse({ briefing: "补充玩家实际知道的时间边界。" }).success).toBe(true);
    expect(contract.schema.safeParse({ setting: artifact.setting }).success).toBe(false);
    expect(contract.schema.safeParse({ timeline: artifact.timeline }).success).toBe(false);
  });

  it.each(["公开窗口", "公共窗口"])("recognizes the actual %s failure wording without granting private-time edits", (wording) => {
    const contract = buildCaseRepairContract(artifact, [issueFor(targetId, `该证据未完整覆盖${wording}。`)]);
    expect(contract.scope!.writableFields).toContain("briefing");
    expect(contract.scope!.writableFields).not.toContain("setting");
    expect(contract.scope!.writableFields).not.toContain("timeline");
  });

  it("does not turn an unrelated interview-entry problem into permission to rewrite the time window", () => {
    const contract = buildCaseRepairContract(artifact, [issueFor("evidence_zhao_testimony", "公开身份仍不能引出这条访谈。", "missing_interview_lead")], windowReview);
    expect(contract.scope!.writableFields).not.toContain("briefing");
    expect(contract.scope!.writableFields).not.toContain("setting");
    expect(contract.scope!.writableFields).not.toContain("timeline");
    expect(contract.scope!.existingEvidenceIds).not.toContain(boundarySource.evidenceId);
    expect(contract.schema.safeParse({ evidence: [{
      id: boundarySource.evidenceId,
      discovery: { dialogueUtterance: "把无关证人的时间改成另一个窗口。" },
    }] }).success).toBe(false);
  });

  it("treats a missing public-window source at the timeline path differently from an actual internal timestamp inconsistency", () => {
    const missing = buildCaseRepairContract(artifact, [{ code: "evidence_narrative_mismatch", path: "timeline", message: "public_window：公开窗口缺少上下界来源。" }], windowReview);
    expect(missing.scope!.writableFields).toContain("briefing");
    expect(missing.scope!.writableFields).not.toContain("setting");
    expect(missing.scope!.writableFields).not.toContain("timeline");
    const inconsistent = buildCaseRepairContract(artifact, [{ code: "evidence_narrative_mismatch", path: "timeline", message: "setting.occurredAt 与实际实施事件时间不一致。" }]);
    expect(inconsistent.scope!.writableFields).toContain("setting");
    expect(inconsistent.scope!.writableFields).toContain("timeline");
  });

  it.each(["不能使用 setting.occurredAt 当公开证据。", "timestamp 不属于玩家已知材料。"])("does not authorize private-time edits for a warning that %s", (warning) => {
    const contract = buildCaseRepairContract(artifact, [issueFor(targetId, `公开窗口缺少来源；${warning}`)], windowReview);
    expect(contract.scope!.writableFields).toContain("briefing");
    expect(contract.scope!.writableFields).not.toContain("setting");
    expect(contract.scope!.writableFields).not.toContain("timeline");
  });

  it("preserves the audited interval and original sources while separating player text from author-only facts", () => {
    const draft = structuredClone(artifact);
    draft.setting.occurredAt = "2099-01-01T03:17:00+08:00";
    const person = draft.characters.find((character) => character.id === "character_suspect_3")!;
    person.privateProfile = "作者私密哨兵：绝不能误称玩家已知。";
    const issues = [issueFor(targetId, "核验未覆盖公共窗口。")];
    const contract = buildCaseRepairContract(draft, issues, windowReview);
    const messages = buildCaseRepairMessages({
      request: { seed: draft.seed, theme: "当代封闭案件", difficulty: "standard" },
      draft, issues, repairScope: contract.scope, publicWindowReview: windowReview,
    });
    const snapshot = JSON.parse(messages[1]!.content).repairSnapshot;
    expect(snapshot.publicWindowReview).toEqual(windowReview);
    expect(snapshot.playerFacingText.setting).toEqual({ era: draft.setting.era, place: draft.setting.place });
    expect(JSON.stringify(snapshot.playerFacingText)).not.toContain("2099-01-01T03:17");
    expect(JSON.stringify(snapshot.playerFacingText)).not.toContain("作者私密哨兵");
    expect(snapshot.playerFacingText.characters.every((character: Record<string, unknown>) => !("privateProfile" in character))).toBe(true);
    expect(snapshot.structuralLedger.setting).toEqual(draft.setting);
    expect(snapshot.structuralLedger.characters.find((character: { id: string }) => character.id === person.id).privateProfile).toBe(person.privateProfile);
  });

  it("passes an audited window into a real graph repair and clears it after the patch is applied", async () => {
    const draft = makeGeneratedCaseArtifact("case_window_repair_challenge", "seed-one");
    const fullPlan = buildEvidenceReviewPlan(draft);
    const target = fullPlan.obligations.find((obligation) => obligation.kind === "excludes")!;
    const originalEvidence = draft.evidence.find((evidence) => evidence.id === target.evidenceId)!;
    let repairContext: PublicWindowReview | undefined;
    const provider: StructuredModelProvider = {
      async invokeStructured(request) {
        let value: unknown;
        if (request.schemaName === "case_artifact") value = draft;
        else if (request.schemaName === "case_opening_review") value = { issues: [] };
        else if (request.schemaName === "case_evidence_review") {
          const batch = JSON.parse(request.messages[1]!.content).reviewPlan as EvidenceReviewPlan;
          const review = makeSupportedEvidenceReview(batch);
          const rejection = review.results.find((result) => result.obligationId === target.id);
          if (rejection) Object.assign(rejection, { verdict: "unsupported", citations: [], reason: "原记录未覆盖公共窗口。" });
          value = review;
        } else if (request.schemaName === "case_artifact_repair_patch") {
          repairContext = JSON.parse(request.messages[1]!.content).repairSnapshot.publicWindowReview;
          value = { evidence: [{ id: originalEvidence.id, description: `${originalEvidence.description} 已复核原始记录。` }] };
        } else throw new Error(`Unexpected model stage: ${request.schemaName}`);
        return { value: request.schema.parse(value), model: "independent-script", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, rawResponse: {} };
      },
    };
    const graph = createCaseGenerationGraph(provider, { maxArtifactAttempts: 2 });
    const updates: Array<Record<string, unknown>> = [];
    const stream = await graph.stream({ request: { seed: draft.seed, theme: "当代封闭案件", difficulty: "standard" } }, { streamMode: "updates" });
    for await (const update of stream) updates.push(update as Record<string, unknown>);
    expect(repairContext?.window).not.toBeNull();
    expect(repairContext?.temporalEvidenceIds).toContain(target.evidenceId);
    expect(repairContext?.sources.length).toBeGreaterThan(0);
    const repairUpdate = updates.find((update) => "repair_case" in update)?.repair_case as Record<string, unknown> | undefined;
    expect(repairUpdate).toBeDefined();
    expect(repairUpdate).toHaveProperty("publicWindowReview", null);
  });
});
