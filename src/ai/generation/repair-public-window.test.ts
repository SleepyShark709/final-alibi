import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import type { StructuredModelProvider } from "@/ai/model-provider";

import { createCaseGenerationGraph } from "./case-generation-graph";
import { buildEvidenceReviewPlan } from "./evidence-review";
import type { PublicWindowReview } from "./generation-schema";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";

describe("public window handoff into repair", () => {
  it.each([false, true])("preserves current review context through an invalid patch, then clears it after application (invalid first: %s)", async (invalidFirst) => {
    const artifact = makeGeneratedCaseArtifact("case_window_handoff", "supporting-seed-0");
    const plan = buildEvidenceReviewPlan(artifact);
    const exclusion = plan.obligations.find((item) => item.kind === "excludes")!;
    const evidence = artifact.evidence.find((item) => item.id === exclusion.evidenceId)!;
    const recorded: { context?: PublicWindowReview } = {};
    const repairs: { repairScope: unknown; validationIssues: { code: string }[]; repairSnapshot: { publicWindowReview: PublicWindowReview } }[] = [];
    let openings = 0;
    const provider: StructuredModelProvider = {
      async invokeStructured(request) {
        let value: unknown;
        if (request.schemaName === "case_artifact") value = artifact;
        else if (request.schemaName === "case_opening_review") {
          if (++openings === 2) throw new Error("pause after patch");
          value = { issues: [] };
        } else if (request.schemaName === "case_evidence_review") {
          const review = makeSupportedEvidenceReview(JSON.parse(request.messages[1]!.content).reviewPlan);
          const result = review.results.find((item) => item.obligationId === exclusion.id);
          if (result) Object.assign(result, { verdict: "unsupported", reason: "已取得记录的连续覆盖不足。" });
          value = review;
        } else if (request.schemaName === "case_artifact_repair_patch") {
          const payload = JSON.parse(request.messages[1]!.content);
          repairs.push(payload);
          recorded.context = payload.repairSnapshot.publicWindowReview;
          value = invalidFirst && repairs.length === 1 ? { title: "不能借格式失败越权改标题" }
            : { evidence: [{ id: evidence.id, description: `${evidence.description} 已补公开核验的取得说明。` }] };
        } else throw new Error(`Unexpected request ${request.schemaName}`);
        return { value: request.schema.parse(value), model: "mock", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 }, rawResponse: {} };
      },
    };
    const graph = createCaseGenerationGraph(provider, { checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "window-handoff" } };
    await expect(graph.invoke({ request: { seed: artifact.seed, theme: "窗口传递回归", difficulty: "standard" }, reviewFeedback: [{ code: "stale_resolved_issue", path: "evidence[0]", message: "旧稿已修的问题" }] }, config)).rejects.toThrow("pause after patch");
    expect(recorded.context!.window).toEqual(makeSupportedEvidenceReview(plan).results[0]!.publicWindow);
    expect(recorded.context!.sources).toEqual(plan.sources.filter((source) => recorded.context!.window!.startSourceIds.includes(source.id)));
    expect(recorded.context!.temporalEvidenceIds).toContain(evidence.id);
    const snapshot = await graph.getState(config);
    expect(snapshot.values.attempt).toBe(invalidFirst ? 3 : 2);
    expect(snapshot.values.publicWindowReview).toBeNull();
    expect(snapshot.values.validationIssues).toEqual([]);
    expect(snapshot.values.draft.evidence.find((item: { id: string }) => item.id === evidence.id).description).not.toBe(evidence.description);
    expect(snapshot.next).toEqual(["blind_solve_case"]);
    if (invalidFirst) {
      expect(repairs).toHaveLength(2);
      expect(repairs[0]!.repairScope).not.toBeNull();
      expect(repairs[1]!.repairScope).toEqual(repairs[0]!.repairScope);
      expect(repairs[1]!.repairSnapshot.publicWindowReview).toEqual(repairs[0]!.repairSnapshot.publicWindowReview);
      expect(repairs[1]!.repairSnapshot).toEqual(repairs[0]!.repairSnapshot);
      expect(repairs[1]!.validationIssues).toEqual(expect.arrayContaining(repairs[0]!.validationIssues));
      expect(repairs[1]!.validationIssues.map((issue) => issue.code)).toContain("invalid_repair_patch");
      expect(repairs[1]!.validationIssues.map((issue) => issue.code)).not.toContain("stale_resolved_issue");
    }
  });
});
