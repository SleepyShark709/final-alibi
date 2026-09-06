import type { ModelMessage } from "@/ai/model-provider";

import type { EvidenceReviewPlan } from "../evidence-review";
import type { EvidenceReviewResult } from "../generation-schema";

/** 假 Provider 的协议回应；不做语义判断，也不用于真实发布。 */
export function makeSupportedEvidenceReview(plan: EvidenceReviewPlan): EvidenceReviewResult {
  return {
    results: plan.obligations.map((obligation) => ({
      obligationId: obligation.id,
      verdict: "supported",
      citations: obligation.allowedSourceIds[0]
        ? [{ sourceId: obligation.allowedSourceIds[0], aspects: obligation.requiredAspects }]
        : [],
      ...(obligation.kind === "public_window" ? { publicWindow: {
        startAt: "2024-01-01T21:00:00+08:00", endAt: "2024-01-01T23:00:00+08:00",
        startSourceIds: obligation.allowedSourceIds.slice(0, 1), endSourceIds: obligation.allowedSourceIds.slice(0, 1),
      } } : {}),
      ...(obligation.kind === "excludes" || obligation.kind === "supports" && obligation.requiredAspects.includes("window") ? { coverage: {
        startAt: "2024-01-01T21:00:00+08:00", endAt: "2024-01-01T23:00:00+08:00",
        startSourceIds: obligation.allowedSourceIds.slice(0, 1), endSourceIds: obligation.allowedSourceIds.slice(0, 1),
      } } : {}),
      reason: "测试脚本确认该项证明义务。",
    })),
  };
}

/** 保留既有行为测试的错误脚本，同时让假模型必须回答完整义务集合。 */
export function scriptEvidenceReview(request: { schemaName: string; messages: ModelMessage[] }, scripted: unknown): unknown {
  if (request.schemaName !== "case_evidence_review" || !scripted || typeof scripted !== "object" || !("issues" in scripted) || !Array.isArray(scripted.issues)) return scripted;
  const payload = JSON.parse(request.messages[1]!.content);
  const plan = payload.reviewPlan as EvidenceReviewPlan;
  const review = makeSupportedEvidenceReview(plan);
  const kinds = {
    unsupportedFactIds: "supports", unsupportedImplicatedCharacterIds: "implicates",
    unsupportedExcludedCharacterIds: "excludes", unsupportedContradictedClaimIds: "contradicts",
  } as const;
  for (const issue of scripted.issues) {
    const failedIds: string[] = [];
    for (const [key, kind] of Object.entries(kinds)) {
      for (const targetId of issue[key] ?? []) {
        const id = plan.obligations.find((item) => item.kind === kind && item.evidenceId === issue.evidenceId && item.targetId === targetId)?.id;
        if (id || !payload.reviewBatch) failedIds.push(id ?? `unknown_${kind}_${targetId}`);
      }
    }
    if (issue.missingInterviewLead) {
      const id = plan.obligations.find((item) => item.kind === "interview_lead" && item.evidenceId === issue.evidenceId)?.id;
      if (id || !payload.reviewBatch) failedIds.push(id ?? `unknown_lead_${issue.evidenceId}`);
    }
    for (const obligationId of failedIds) {
      const result = review.results.find((item) => item.obligationId === obligationId);
      const failed = { obligationId, verdict: "unsupported" as const, citations: [], reason: issue.reason };
      if (result) Object.assign(result, failed);
      else review.results.push(failed);
    }
  }
  return review;
}

/** 一个语义脚本对应一轮审核；本轮各组仅回答自己收到的义务。 */
export class ScriptedEvidenceReview {
  private scripted: unknown;

  reply(request: { schemaName: string; messages: ModelMessage[] }, nextScript: () => unknown) {
    const batch = JSON.parse(request.messages[1]!.content).reviewBatch;
    if (!batch || batch.index === 0) this.scripted = nextScript();
    return scriptEvidenceReview(request, this.scripted);
  }
}
