import {
  createModelCallAudit,
  createModelCallAuditFromStructuredOutputParseError,
  createModelCallAuditFromStructuredOutputValidationError,
  type ModelCallAudit,
} from "@/ai/model-audit";
import {
  isStructuredOutputParseError,
  isStructuredOutputValidationError,
  type StructuredModelProvider,
} from "@/ai/model-provider";
import type { CaseArtifact } from "@/domain/case/case-artifact";

import { evidenceReviewHasProtocolViolation, extractPublicWindow, type EvidenceReviewPlan, validateEvidenceReview } from "./evidence-review";
import { buildEvidenceReviewMessages } from "./generation-prompts";
import { evidenceReviewSchema, type EvidenceReviewResult, type PublicWindow } from "./generation-schema";

export const EVIDENCE_REVIEW_LIMITS = {
  obligationsPerBatch: 4,
  interviewLeadsPerBatch: 1,
  maxBatches: 20,
  maxTokensPerBatch: 3_200,
  concurrency: 2,
  timeoutMs: 240_000,
} as const;

/** 编号和每项白名单来自同一个全局 plan；同组来源并集不授予交叉引用权。 */
export function buildEvidenceReviewBatches(plan: EvidenceReviewPlan): EvidenceReviewPlan[] {
  const groups = new Map<string, EvidenceReviewPlan["obligations"]>();
  for (const obligation of plan.obligations) {
    const key = obligation.kind === "public_window" || obligation.kind === "interview_lead"
      ? obligation.kind : `evidence:${obligation.evidenceId}`;
    const group = groups.get(key) ?? [];
    group.push(obligation);
    groups.set(key, group);
  }
  const batches: EvidenceReviewPlan[] = [];
  const ordered = [groups.get("public_window") ?? [], ...[...groups].filter(([key]) => key !== "public_window" && key !== "interview_lead").map(([, group]) => group), groups.get("interview_lead") ?? []];
  for (const group of ordered) {
    const size = group[0]?.kind === "public_window" ? 1 : group[0]?.kind === "interview_lead"
      ? EVIDENCE_REVIEW_LIMITS.interviewLeadsPerBatch : EVIDENCE_REVIEW_LIMITS.obligationsPerBatch;
    for (let index = 0; index < group.length; index += size) {
      const obligations = group.slice(index, index + size);
      const sourceIds = new Set(obligations.flatMap((item) => item.allowedSourceIds));
      batches.push({ obligations, sources: plan.sources.filter((item) => sourceIds.has(item.id)) });
    }
  }
  if (batches.length > EVIDENCE_REVIEW_LIMITS.maxBatches) {
    throw new Error(`Evidence review requires ${batches.length} batches; maximum is ${EVIDENCE_REVIEW_LIMITS.maxBatches}.`);
  }
  return batches;
}

export class EvidenceReviewBatchError extends Error {
  constructor(
    cause: unknown,
    public readonly modelCalls: ModelCallAudit[],
    public readonly startedBatchIndices: number[],
    public readonly unreportedUsageBatchIndices: number[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "EvidenceReviewBatchError";
  }
}

export async function reviewEvidenceInBatches(
  provider: StructuredModelProvider,
  artifact: CaseArtifact,
  plan: EvidenceReviewPlan,
) {
  const batches = buildEvidenceReviewBatches(plan);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Evidence review exceeded its shared 240-second deadline.")), EVIDENCE_REVIEW_LIMITS.timeoutMs);
  const results: EvidenceReviewResult[] = [];
  const audits: Array<ModelCallAudit | undefined> = [];
  const started: number[] = [];
  let firstError: unknown;
  let failed = false;
  let next = 0;
  let publicWindow: PublicWindow | null = null;
  let publicWindowContext: EvidenceReviewPlan["sources"] = [];

  const invokeBatch = async (index: number) => {
    const batch = batches[index]!;
    const messages = buildEvidenceReviewMessages(artifact, batch, {
      index, count: batches.length, publicWindowContext, publicWindow,
    });
    started.push(index);
    try {
      const response = await withAbort(provider.invokeStructured({
        tier: "pro", schema: evidenceReviewSchema, schemaName: "case_evidence_review", messages,
        reasoning: false, temperature: 0,
        maxTokens: EVIDENCE_REVIEW_LIMITS.maxTokensPerBatch, maxRetries: 0, signal: controller.signal,
      }), controller.signal);
      audits[index] = createModelCallAudit("evidence_review", "pro", messages, response);
      // 全局覆盖不能替代逐组覆盖：A 回 B、B 回 A 即使合并齐全也不成立。
      const issues = validateEvidenceReview(batch, response.value, publicWindow);
      if (evidenceReviewHasProtocolViolation(batch, response.value)) throw new Error(`Evidence review batch ${index + 1} violated its coverage/source contract: ${issues.map((issue) => issue.message).join(" ")}`);
      results[index] = response.value;
    } catch (error) {
      // 共享取消的 reason 可能正是另一组的计费错误，不能复制成自己的账单。
      const cancelledByAnotherBatch = controller.signal.aborted && error === controller.signal.reason;
      if (!cancelledByAnotherBatch && isStructuredOutputParseError(error)) audits[index] = createModelCallAuditFromStructuredOutputParseError("evidence_review", "pro", messages, error);
      else if (!cancelledByAnotherBatch && isStructuredOutputValidationError(error)) audits[index] = createModelCallAuditFromStructuredOutputValidationError("evidence_review", "pro", messages, error);
      if (!failed) { firstError = error; failed = true; }
      controller.abort(firstError);
    }
  };

  try {
    // 先明确玩家的公开窗口；后续仅作时间约束，绝不扩展关系的引用白名单。
    if (batches[0]?.obligations[0]?.kind === "public_window") {
      await invokeBatch(next++);
      publicWindow = results[0] ? extractPublicWindow(batches[0], results[0]) : null;
      const citedIds = new Set(publicWindow ? [...publicWindow.startSourceIds, ...publicWindow.endSourceIds] : []);
      publicWindowContext = plan.sources.filter((source) => citedIds.has(source.id));
    }
    const worker = async () => {
      while (!failed && !controller.signal.aborted && next < batches.length) await invokeBatch(next++);
    };
    await Promise.all(Array.from({ length: EVIDENCE_REVIEW_LIMITS.concurrency }, worker));
    if (failed || controller.signal.aborted) {
      throw new EvidenceReviewBatchError(firstError ?? controller.signal.reason, audits.filter((audit): audit is ModelCallAudit => audit !== undefined), started, started.filter((index) => !audits[index]));
    }
    const review = { results: results.flatMap((result) => result.results) };
    return {
      review, issues: validateEvidenceReview(plan, review),
      publicWindowReview: {
        window: publicWindow, sources: publicWindowContext,
        temporalEvidenceIds: [...new Set(plan.obligations.filter((item) => item.kind !== "public_window" && item.requiredAspects.includes("window")).flatMap((item) => item.evidenceId ? [item.evidenceId] : []))],
      },
      modelCalls: audits.filter((audit): audit is ModelCallAudit => audit !== undefined),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  try {
    signal.throwIfAborted();
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
