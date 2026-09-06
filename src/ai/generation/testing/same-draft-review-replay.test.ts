import { describe, expect, it } from "vitest";

import { createModelCallAudit } from "@/ai/model-audit";
import type { StructuredModelRequest } from "@/ai/model-provider";
import { parseCaseArtifact } from "@/domain/case/case-artifact";

import { buildEvidenceReviewPlan } from "../evidence-review";
import { buildEvidenceReviewBatches } from "../evidence-review-batches";
import { buildEvidenceReviewMessages } from "../generation-prompts";
import { evidenceReviewSchema } from "../generation-schema";
import innCounterexample from "./fixtures/inn-evidence-review-counterexample.json";
import { SameDraftReviewReplay, type RecordedReview } from "./same-draft-review-replay";
import { makeSupportedEvidenceReview } from "./scripted-evidence-review";

describe("same-draft audit response replay", () => {
  it("reuses completed relation groups with their original rejection and audit while only lead groups need new requests", () => {
    const artifact = parseCaseArtifact(innCounterexample);
    const batches = buildEvidenceReviewBatches(buildEvidenceReviewPlan(artifact));
    const requests: StructuredModelRequest<Record<string, unknown>>[] = batches.map((batch, index) => ({
      tier: "pro", schema: evidenceReviewSchema, schemaName: "case_evidence_review", messages: buildEvidenceReviewMessages(artifact, batch, { index, count: batches.length, publicWindowContext: [] }),
    }));
    const records: RecordedReview[] = requests.flatMap((request, index) => {
      if (batches[index]!.obligations[0]!.kind === "interview_lead") return [];
      const oldMessages = structuredClone(request.messages);
      const payload = JSON.parse(oldMessages[1]!.content);
      payload.reviewBatch.count -= 3;
      oldMessages[1]!.content = JSON.stringify(payload);
      const value = makeSupportedEvidenceReview(batches[index]!);
      if (index === 1) Object.assign(value.results[0]!, { verdict: "unsupported", reason: "保存原稿的真实拒绝结论。", citations: [] });
      const result = { value, model: "mock", usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 80 }, rawResponse: { id: `old-${index}`, content: JSON.stringify(value), responseMetadata: { finish_reason: "stop" } } };
      return [{ artifactHash: "same-draft", request: { schemaName: request.schemaName, messages: oldMessages }, result, audit: createModelCallAudit("evidence_review", "pro", oldMessages, result) }];
    });
    const replay = new SameDraftReviewReplay(records);
    const hits = requests.map((request) => replay.take("same-draft", request));
    expect(hits.filter(Boolean)).toHaveLength(records.length);
    expect(hits.filter((hit) => !hit)).toHaveLength(batches.filter((batch) => batch.obligations[0]!.kind === "interview_lead").length);
    expect(hits[1]!.result.value).toEqual(records[1]!.result.value);
    expect(evidenceReviewSchema.parse(hits[1]!.result.value).results[0]!.verdict).toBe("unsupported");
    const graphAudits = hits.flatMap((hit, index) => hit ? [createModelCallAudit("evidence_review", "pro", requests[index]!.messages, hit.result)] : []);
    expect(replay.restoreAuditIds(graphAudits)).toEqual(records.map((record) => record.audit));
    expect(replay.restoreAuditIds(graphAudits).map((audit) => audit.request.invocationId)).toEqual(records.map((record) => record.audit.request.invocationId));
  });
});
