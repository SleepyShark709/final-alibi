import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { StructuredOutputValidationError, type StructuredModelProvider } from "@/ai/model-provider";

import { createCaseGenerationGraph } from "./case-generation-graph";
import type { CaseRepairScope } from "./case-repair-contract";
import { buildEvidenceReviewPlan, type EvidenceReviewPlan } from "./evidence-review";
import type { PublicWindowReview } from "./generation-schema";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";

describe("independent failed-repair scope challenge", () => {
  it("retains the same draft, current semantic issue, bounds and permissions after a rejected patch, then clears them only after applying a patch", async () => {
    const draft = makeGeneratedCaseArtifact("case_failed_patch_scope_challenge", "seed-one");
    const plan = buildEvidenceReviewPlan(draft);
    const target = plan.obligations.find((item) => item.kind === "excludes")!;
    const evidence = draft.evidence.find((item) => item.id === target.evidenceId)!;
    const repairs: Array<{
      validationIssues: Array<{ code: string; path: string; message: string }>;
      repairScope: CaseRepairScope;
      repairSnapshot: { publicWindowReview: PublicWindowReview };
    }> = [];
    let openings = 0;
    const forbiddenPatch = { setting: draft.setting };
    const provider: StructuredModelProvider = {
      async invokeStructured(request) {
        let value: unknown;
        if (request.schemaName === "case_artifact") value = draft;
        else if (request.schemaName === "case_opening_review") {
          if (++openings === 2) throw new Error("independent pause after successful patch");
          value = { issues: [] };
        } else if (request.schemaName === "case_evidence_review") {
          const batch = JSON.parse(request.messages[1]!.content).reviewPlan as EvidenceReviewPlan;
          const review = makeSupportedEvidenceReview(batch);
          const rejection = review.results.find((item) => item.obligationId === target.id);
          if (rejection) Object.assign(rejection, { verdict: "unsupported", citations: [], reason: "原记录的连续覆盖尚未证明。" });
          value = review;
        } else if (request.schemaName === "case_artifact_repair_patch") {
          expect(request.reasoning).toBe(false);
          expect(request.reasoningEffort).toBeUndefined();
          expect(request.maxTokens).toBe(3_200);
          repairs.push(JSON.parse(request.messages[1]!.content));
          const rejected = request.schema.safeParse(forbiddenPatch);
          expect(rejected.success).toBe(false);
          if (repairs.length === 1) {
            if (rejected.success) throw new Error("test requires a genuinely forbidden patch");
            throw new StructuredOutputValidationError(
              request.schemaName, forbiddenPatch,
              rejected.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message, received: JSON.stringify(forbiddenPatch) })),
              "independent-script", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
              { content: JSON.stringify(forbiddenPatch) },
            );
          }
          expect(repairs).toHaveLength(2);
          value = { evidence: [{ id: evidence.id, description: `${evidence.description} 已补充原始记录的取得说明。` }] };
        } else throw new Error(`Unexpected model request ${request.schemaName}`);
        return { value: request.schema.parse(value), model: "independent-script", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, rawResponse: {} };
      },
    };
    const graph = createCaseGenerationGraph(provider, { checkpointer: new MemorySaver(), maxArtifactAttempts: 3 });
    const config = { configurable: { thread_id: "independent-invalid-patch-window-scope" } };
    await expect(graph.invoke({
      request: { seed: draft.seed, theme: "保持失败补丁的原权限", difficulty: "standard" },
      reviewFeedback: [{ code: "historical_unrelated_failure", path: "facts[0]", message: "此前已修的历史问题不能重新扩大本次权限。" }],
    }, config)).rejects.toThrow("independent pause after successful patch");

    expect(repairs).toHaveLength(2);
    const [first, second] = repairs;
    expect(first!.repairScope).not.toBeNull();
    expect(first!.repairScope.writableFields).not.toContain("setting");
    expect(second!.repairScope).toEqual(first!.repairScope);
    expect(second!.repairSnapshot).toEqual(first!.repairSnapshot);
    expect(second!.repairSnapshot.publicWindowReview.window).not.toBeNull();
    expect(second!.repairSnapshot.publicWindowReview.temporalEvidenceIds).toContain(target.evidenceId);
    expect(second!.validationIssues.filter((issue) => issue.code !== "invalid_repair_patch")).toEqual(first!.validationIssues);
    expect(second!.validationIssues.some((issue) => issue.code === "invalid_repair_patch" && issue.message.length > 0)).toBe(true);
    expect(second!.validationIssues.some((issue) => issue.code === "historical_unrelated_failure")).toBe(false);

    const state = (await graph.getState(config)).values;
    expect(state.attempt).toBe(3);
    expect(state.publicWindowReview).toBeNull();
    expect(state.repairFormatIssues).toEqual([]);
    expect(state.validationIssues).toEqual([]);
    expect(state.draft.setting).toEqual(draft.setting);
    expect(state.draft.evidence.find((item: { id: string }) => item.id === evidence.id).description).toContain("已补充原始记录的取得说明");
  });
});
