import { describe, expect, it } from "vitest";

import type { StructuredModelProvider } from "@/ai/model-provider";
import { parseCaseArtifact } from "@/domain/case/case-artifact";
import type { CaseValidationIssue } from "@/domain/case/case-validator";

import { createCaseGenerationGraph } from "./case-generation-graph";
import { buildCaseRepairContract } from "./case-repair-contract";
import { buildEvidenceReviewPlan, validateEvidenceReview } from "./evidence-review";
import { deriveGenerationPlan, findInterviewContributionGaps, validateGeneratedCharacterPlan } from "./generation-plan";
import islandCounterexample from "./testing/fixtures/island-acquisition-route-counterexample.json";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";

const recordId = "evidence_observation_log";

function pendingDeliveryCase() {
  const artifact = structuredClone(parseCaseArtifact(islandCounterexample));
  for (const [id, characterId] of [
    ["evidence_phone_lock", "character_suspect_1"], ["evidence_work_log", "character_suspect_1"],
    [recordId, "character_suspect_2"], ["evidence_corridor_camera", "character_suspect_1"], ["evidence_dock_camera", "character_suspect_3"],
  ]) {
    const evidence = artifact.evidence.find((item) => item.id === id)!;
    evidence.discovery = { ...evidence.discovery, method: "interview", characterId,
      dialogueAliases: ["能提供你提到的原记录吗", "原始材料能查看吗", "我想核对当时的记录"], dialogueUtterance: "这份记录可以提供。",
    };
  }
  return artifact;
}

function actualDeliveryIssue(artifact = pendingDeliveryCase()) {
  const plan = buildEvidenceReviewPlan(artifact);
  const obligation = plan.obligations.find((item) => item.evidenceId === recordId && item.kind === "record_delivery")!;
  const review = makeSupportedEvidenceReview(plan);
  Object.assign(review.results.find((item) => item.obligationId === obligation.id)!, {
    verdict: "unsupported", citations: [], reason: "台词只说可以提供，没有实际交付原始记录。",
  });
  return validateEvidenceReview(plan, review).find((issue) => issue.message.startsWith(`${recordId}: record_delivery;`))!;
}

describe("independent acquisition diagnosis and continuation challenge", () => {
  it("can repair actual record delivery locally without unlocking proof relations or requiring a fake new route", () => {
    const artifact = pendingDeliveryCase();
    const issue = actualDeliveryIssue(artifact);
    expect(issue).toBeDefined();
    const contract = buildCaseRepairContract(artifact, [issue]);
    expect(contract.scope?.mode).toBe("acquisition");
    expect(contract.schema.safeParse({ evidence: [{ id: recordId, discovery: {
      dialogueUtterance: "这是我刚交给你的原始观测记录，核对时请保留原文关于签名时点的限制。",
    } }] }).success).toBe(true);
    expect(contract.schema.safeParse({ evidence: [{ id: recordId, excludesCharacterIds: [] }] }).success).toBe(false);
    expect(contract.schema.safeParse({ setting: artifact.setting }).success).toBe(false);
  });

  it.each(["wrong-id", "ordinary-supports", "not-interview", "testimony"])("does not launder a different semantic problem into acquisition permissions: %s", (variant) => {
    const artifact = pendingDeliveryCase();
    const issue = actualDeliveryIssue(artifact);
    if (variant === "wrong-id") issue.message = issue.message.replace(recordId, "evidence_dock_camera");
    if (variant === "ordinary-supports") issue.message = `${recordId}: unsupported facts fact_alibi_2; record_delivery is also disputed, but full-period identity is not proved.`;
    if (variant === "not-interview") artifact.evidence.find((item) => item.id === recordId)!.discovery.method = "inspect";
    if (variant === "testimony") artifact.evidence.find((item) => item.id === recordId)!.kind = "testimony";
    expect(buildCaseRepairContract(artifact, [issue]).scope?.mode).not.toBe("acquisition");
  });

  it("co-repairs the same delivery entry but does not let a format warning widen the snapshot scope", () => {
    const artifact = pendingDeliveryCase();
    const delivery = actualDeliveryIssue(artifact);
    const entryIssue: CaseValidationIssue = { code: "missing_interview_lead", path: delivery.path, message: "实际交付的询问入口仍需可知。" };
    const first = buildCaseRepairContract(artifact, [delivery, entryIssue]);
    const second = buildCaseRepairContract(artifact, [delivery, entryIssue, { code: "invalid_repair_patch", path: "repairPatch", message: "上次补丁含禁止的关系字段。" }]);
    expect(first.scope?.mode).toBe("acquisition");
    expect(second.scope).toEqual(first.scope);
    expect(buildCaseRepairContract(artifact, [entryIssue]).scope?.mode).not.toBe("acquisition");
  });

  it("shows the actual bypass proof and existing interviews for the tier that remains optional", () => {
    const artifact = pendingDeliveryCase();
    const plan = deriveGenerationPlan(artifact.seed);
    const issues = validateGeneratedCharacterPlan(artifact, plan);
    const { scope } = buildCaseRepairContract(artifact, issues);
    expect(scope?.mode).toBe("acquisition");
    expect(scope!.interviewContributionGaps).toEqual(findInterviewContributionGaps(artifact, plan));
    const gap = scope!.interviewContributionGaps!.find((item) => item.roleTier === "witness")!;
    expect(gap.existingInterviewEvidenceIds).toContain("evidence_sighting_testimony");
    expect(gap.bypasses[0]!.proofEvidenceIds).toContain("evidence_corridor_camera");
    expect(gap.bypasses[0]!.proofEvidenceIds).not.toContain("evidence_sighting_testimony");
    expect(scope!.requiredInterviewPrefix ?? []).toEqual([]);
  });

  it("uses the bounded low-reasoning allowance only for acquisition repair", async () => {
    const artifact = parseCaseArtifact(islandCounterexample);
    let repairs = 0;
    const provider: StructuredModelProvider = {
      async invokeStructured(request) {
        if (request.schemaName === "case_artifact_repair_patch") {
          repairs++;
          expect(JSON.parse(request.messages[1]!.content).repairScope.mode).toBe("acquisition");
          expect(request).toMatchObject({ reasoning: true, reasoningEffort: "low", maxTokens: 9_200 });
          throw new Error("independent pause before model call");
        }
        expect(request.schemaName).toBe("case_artifact");
        expect(request.reasoning).toBe(false);
        return { value: request.schema.parse(artifact), model: "independent-script", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, rawResponse: {} };
      },
    };
    await expect(createCaseGenerationGraph(provider, { maxArtifactAttempts: 2 }).invoke({
      request: { seed: artifact.seed, theme: "固定预算内取得路线修复", difficulty: "standard" },
    })).rejects.toThrow("independent pause before model call");
    expect(repairs).toBe(1);
  });
});
