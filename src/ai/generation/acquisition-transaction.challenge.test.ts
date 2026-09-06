import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import type { StructuredModelProvider } from "@/ai/model-provider";
import { parseCaseArtifact } from "@/domain/case/case-artifact";

import { createCaseGenerationGraph } from "./case-generation-graph";
import { findAcquisitionRepairRegressions } from "./case-repair-contract";
import { buildEvidenceReviewPlan, type EvidenceReviewPlan } from "./evidence-review";
import islandCounterexample from "./testing/fixtures/island-acquisition-route-counterexample.json";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";

function protectedDraft() {
  const draft = structuredClone(parseCaseArtifact(islandCounterexample));
  for (const [id, characterId] of [
    ["evidence_phone_lock", "character_suspect_1"], ["evidence_work_log", "character_suspect_1"],
    ["evidence_observation_log", "character_suspect_2"], ["evidence_corridor_camera", "character_suspect_1"], ["evidence_dock_camera", "character_suspect_3"],
  ]) {
    const item = draft.evidence.find((evidence) => evidence.id === id)!;
    item.discovery = { ...item.discovery, method: "interview", characterId,
      dialogueAliases: ["可以查看原材料吗", "请提供你提到的记录", "能调出原始材料吗"], dialogueUtterance: "原始材料可以提供。",
    };
  }
  draft.evidence.find((item) => item.id === "evidence_sighting_testimony")!.critical = true;
  return draft;
}

describe("independent transactional acquisition repair challenge", () => {
  it("rejects new opening disclosures and lost suspect contribution even when the old witness problem is resolved", () => {
    const before = protectedDraft();
    const after = structuredClone(before);
    for (const item of after.evidence) {
      if (item.discovery.method === "interview" && after.characters.find((character) => character.id === item.discovery.characterId)?.roleTier === "suspect") item.discovery.method = "search";
    }
    const corridor = after.evidence.find((item) => item.id === "evidence_corridor_camera")!;
    corridor.discovery.method = "interview";
    corridor.discovery.characterId = "character_witness_2";
    const regressions = findAcquisitionRepairRegressions(before, after);
    expect(regressions.some((issue) => issue.code === "insufficient_suspect_interview_characters")).toBe(true);
    expect(regressions.some((issue) => issue.code === "initial_scene_suspect_name_leak")).toBe(true);
    expect(regressions.some((issue) => issue.code === "insufficient_supporting_interview_characters")).toBe(false);
  });

  it("allows partial progress on pre-existing blockers without demanding that one patch solve everything", () => {
    const before = protectedDraft();
    before.evidence.find((item) => item.id === "evidence_phone_lock")!.discovery.method = "search";
    const after = structuredClone(before);
    after.evidence.find((item) => item.id === "evidence_phone_lock")!.discovery.method = "interview";
    expect(findAcquisitionRepairRegressions(before, after)).toEqual([]);
  });

  it("matches old evidence blockers by entity id after array reordering", () => {
    const before = protectedDraft();
    before.evidence.find((item) => item.id === "evidence_phone_lock")!.discovery.method = "search";
    const after = structuredClone(before);
    after.evidence.reverse();
    expect(findAcquisitionRepairRegressions(before, after)).toEqual([]);
  });

  it("does not hide a new blocker on a different entity behind an equal issue count", () => {
    const before = protectedDraft();
    before.evidence.find((item) => item.id === "evidence_phone_lock")!.discovery.method = "search";
    const after = structuredClone(before);
    after.evidence.find((item) => item.id === "evidence_phone_lock")!.discovery.method = "interview";
    after.evidence.find((item) => item.id === "evidence_work_log")!.discovery.method = "search";
    const regressions = findAcquisitionRepairRegressions(before, after);
    expect(regressions).not.toEqual([]);
    expect(regressions.some((issue) => issue.message.includes("evidence_work_log"))).toBe(true);
  });

  it("rolls back a real graph candidate without replacing the current issues, bounds or scope, while consuming the attempt", async () => {
    const draft = makeGeneratedCaseArtifact("case_transactional_acquisition_challenge", "seed-one");
    const plan = buildEvidenceReviewPlan(draft);
    const target = plan.obligations.find((item) => item.kind === "record_delivery")!;
    expect(target).toBeDefined();
    const originalDelivery = draft.evidence.find((item) => item.id === target.evidenceId)!;
    const snapshots: Array<{
      repairSnapshot: { publicWindowReview: { window: unknown } };
      repairScope: unknown;
      validationIssues: Array<{ code: string; message: string }>;
    }> = [];
    let openings = 0;
    const provider: StructuredModelProvider = {
      async invokeStructured(request) {
        let value: unknown;
        if (request.schemaName === "case_artifact") value = draft;
        else if (request.schemaName === "case_opening_review") {
          if (++openings === 2) throw new Error("independent pause after committed acquisition patch");
          value = { issues: [] };
        } else if (request.schemaName === "case_evidence_review") {
          const batch = JSON.parse(request.messages[1]!.content).reviewPlan as EvidenceReviewPlan;
          const review = makeSupportedEvidenceReview(batch);
          const failed = review.results.find((item) => item.obligationId === target.id);
          if (failed) Object.assign(failed, { verdict: "unsupported", citations: [], reason: "仍需明确实际交付的原始材料。" });
          value = review;
        } else if (request.schemaName === "case_artifact_repair_patch") {
          snapshots.push(JSON.parse(request.messages[1]!.content));
          expect(request.reasoning).toBe(true);
          if (snapshots.length === 1) value = { evidence: [{ id: "evidence_transfer_ledger", discovery: { prerequisiteEvidenceIds: [] } }] };
          else {
            expect(snapshots).toHaveLength(2);
            value = { evidence: [{ id: originalDelivery.id, discovery: { dialogueUtterance: `${originalDelivery.discovery.dialogueUtterance} 原始材料已经交付。` } }] };
          }
        } else throw new Error(`Unexpected model stage ${request.schemaName}`);
        return { value: request.schema.parse(value), model: "independent-script", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, rawResponse: {} };
      },
    };
    const graph = createCaseGenerationGraph(provider, { checkpointer: new MemorySaver(), maxArtifactAttempts: 3 });
    const config = { configurable: { thread_id: "independent-transactional-acquisition" } };
    await expect(graph.invoke({ request: { seed: draft.seed, theme: "防止取得路线修复回退", difficulty: "standard" } }, config))
      .rejects.toThrow("independent pause after committed acquisition patch");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]!.repairSnapshot).toEqual(snapshots[0]!.repairSnapshot);
    expect(snapshots[1]!.repairScope).toEqual(snapshots[0]!.repairScope);
    expect(snapshots[0]!.repairSnapshot.publicWindowReview.window).not.toBeNull();
    expect(snapshots[1]!.validationIssues.filter((issue) => issue.code !== "invalid_repair_patch")).toEqual(snapshots[0]!.validationIssues);
    expect(snapshots[1]!.validationIssues.find((issue) => issue.code === "invalid_repair_patch")!.message).toMatch(/候选补丁新增.*未提交/u);
    const state = (await graph.getState(config)).values;
    expect(state.attempt).toBe(3);
    expect(state.publicWindowReview).toBeNull();
    expect(state.repairFormatIssues).toEqual([]);
    const failedAudits = state.modelCalls.filter((call: { task: string }) => call.task === "case_repair_apply_recovery");
    expect(failedAudits).toHaveLength(1);
    expect(failedAudits[0]).toMatchObject({ inputTokens: 1, outputTokens: 1 });
    expect(state.draft.evidence.find((item: { id: string }) => item.id === "evidence_transfer_ledger").discovery.prerequisiteEvidenceIds)
      .toEqual(draft.evidence.find((item) => item.id === "evidence_transfer_ledger")!.discovery.prerequisiteEvidenceIds);
  });
});
