import type { ModelCallAudit } from "@/ai/model-audit";
import type { ModelMessage, StructuredModelRequest, StructuredModelResult } from "@/ai/model-provider";

import { evidenceReviewHasProtocolViolation, type EvidenceReviewPlan } from "../evidence-review";
import { evidenceReviewSchema, openingReviewSchema } from "../generation-schema";

export interface RecordedReview {
  artifactHash: string;
  request: { schemaName: string; messages: ModelMessage[] };
  result: StructuredModelResult<Record<string, unknown>>;
  audit: ModelCallAudit;
}

/** 仅供隔离审计续跑：重放同一失败轮中已经完整返回的原响应，不接产品缓存。 */
export class SameDraftReviewReplay {
  private readonly replayed: RecordedReview[] = [];

  constructor(private readonly records: RecordedReview[]) {}

  take<T extends Record<string, unknown>>(artifactHash: string, request: StructuredModelRequest<T>): { result: StructuredModelResult<T>; audit: ModelCallAudit } | undefined {
    if (request.schemaName !== "case_evidence_review" && request.schemaName !== "case_opening_review") return;
    const record = this.records.find((item) => item.artifactHash === artifactHash && item.request.schemaName === request.schemaName && semanticInput(item.request.messages) === semanticInput(request.messages));
    if (!record || (record.result.rawResponse.responseMetadata as Record<string, unknown> | undefined)?.finish_reason !== "stop" || (record.audit.response.responseMetadata as Record<string, unknown> | undefined)?.finish_reason !== "stop") return;
    if (typeof record.result.rawResponse.id !== "string" || record.result.rawResponse.id !== record.audit.response.id || typeof record.audit.request.invocationId !== "string") throw new Error("Stored review lacks its original invocation identity");
    const value = request.schema.parse(record.result.value);
    const originalContent = record.audit.response.content;
    if (typeof originalContent !== "string" || originalContent !== record.result.rawResponse.content ||
      JSON.stringify(request.schema.parse(JSON.parse(originalContent))) !== JSON.stringify(value) ||
      semanticInput(record.audit.request.messages as ModelMessage[]) !== semanticInput(record.request.messages)) {
      throw new Error("Stored review differs from its original raw response or request");
    }
    if (request.schemaName === "case_evidence_review") {
      const review = evidenceReviewSchema.parse(value);
      const plan = JSON.parse(request.messages[1]!.content).reviewPlan as EvidenceReviewPlan;
      if (evidenceReviewHasProtocolViolation(plan, review)) throw new Error("Stored evidence review violates exact coverage/source contract");
    } else {
      openingReviewSchema.parse(value);
    }
    this.replayed.push(record);
    return { result: { ...record.result, value }, audit: record.audit };
  }

  /** Graph 的账本只校正回原调用身份；不修改案卷、结论、响应或用量。 */
  restoreAuditIds(calls: ModelCallAudit[]): ModelCallAudit[] {
    return calls.map((call) => this.replayed.find((record) =>
      record.result.rawResponse.id === call.response.id &&
      semanticInput(record.request.messages) === semanticInput(call.request.messages as ModelMessage[]),
    )?.audit ?? call);
  }
}

function semanticInput(messages: ModelMessage[]): string {
  return JSON.stringify(messages.map((message) => {
    if (message.role !== "user") return message;
    const payload = JSON.parse(message.content);
    if (payload.reviewBatch) {
      const semanticBatch = { ...payload.reviewBatch };
      delete semanticBatch.index;
      delete semanticBatch.count;
      if (Object.keys(semanticBatch).length) payload.reviewBatch = semanticBatch;
      else delete payload.reviewBatch;
    }
    return { ...message, content: JSON.stringify(payload) };
  }));
}
