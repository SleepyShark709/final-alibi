import { describe, expect, it } from "vitest";

import { createModelCallAudit } from "@/ai/model-audit";
import type { StructuredModelRequest } from "@/ai/model-provider";
import { parseCaseArtifact } from "@/domain/case/case-artifact";

import { buildEvidenceReviewPlan, type EvidenceReviewPlan } from "./evidence-review";
import { buildEvidenceReviewMessages } from "./generation-prompts";
import { evidenceReviewSchema, openingReviewSchema } from "./generation-schema";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";
import { SameDraftReviewReplay, type RecordedReview } from "./testing/same-draft-review-replay";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";

const artifact = parseCaseArtifact(innCounterexample);
const full = buildEvidenceReviewPlan(artifact);
const obligation = full.obligations.find((item) => item.kind === "supports" && item.evidenceId === "evidence_lin_phone")!;
const plan: EvidenceReviewPlan = { obligations: [obligation], sources: full.sources.filter((source) => obligation.allowedSourceIds.includes(source.id)) };
const artifactHash = "original_v3_hash";

function fixture(opening = false) {
  const value = opening ? { issues: [] } : makeSupportedEvidenceReview(plan);
  if ("results" in value) {
    value.results[0]!.verdict = "unsupported";
    value.results[0]!.citations = [];
    value.results[0]!.reason = "原审核明确拒绝：手机在附近不能证明本人进入书房。";
  }
  const request: StructuredModelRequest<Record<string, unknown>> = {
    tier: "pro", schemaName: opening ? "case_opening_review" : "case_evidence_review",
    schema: opening ? openingReviewSchema : evidenceReviewSchema,
    messages: opening ? [{ role: "system", content: "开局审查协议" }, { role: "user", content: JSON.stringify({ briefing: artifact.briefing }) }]
      : buildEvidenceReviewMessages(artifact, plan, { index: 1, count: 10, publicWindowContext: [full.sources.find((source) => source.path === "briefing")!] }),
  };
  const result = { value, model: "deepseek-v4-pro", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 80 },
    rawResponse: { id: "original_paid_response", content: JSON.stringify(value), responseMetadata: { finish_reason: "stop" } } };
  const audit = createModelCallAudit(opening ? "case_opening_review" : "evidence_review", "pro", request.messages, result);
  const record: RecordedReview = { artifactHash, request: { schemaName: request.schemaName, messages: request.messages }, result, audit };
  return { record, request };
}

function changedInput(request: StructuredModelRequest<Record<string, unknown>>, change: (payload: {
  reviewPlan: EvidenceReviewPlan; facts: typeof artifact.facts; setting: typeof artifact.setting;
  publicWindowContext: EvidenceReviewPlan["sources"]; reviewBatch: { index: number; count: number };
}) => void) {
  const messages = structuredClone(request.messages);
  const payload = JSON.parse(messages[1]!.content);
  change(payload);
  messages[1]!.content = JSON.stringify(payload);
  return { ...request, messages };
}

describe("independent same-draft review replay challenge", () => {
  it("replays a complete rejection across scheduling changes without creating another paid identity", () => {
    const { record, request } = fixture();
    const replay = new SameDraftReviewReplay([record]);
    const current = changedInput(request, (payload) => { payload.reviewBatch.index = 2; payload.reviewBatch.count = 13; });
    const hit = replay.take(artifactHash, current)!;
    expect(hit.result.value).toEqual(record.result.value);
    expect(hit.audit.request.invocationId).toBe(record.audit.request.invocationId);
    const graphAudit = createModelCallAudit("evidence_review", "pro", current.messages, hit.result);
    expect(graphAudit.request.invocationId).not.toBe(record.audit.request.invocationId);
    expect(replay.restoreAuditIds([graphAudit])).toEqual([record.audit]);
    expect(new SameDraftReviewReplay([record]).restoreAuditIds([graphAudit])).toEqual([graphAudit]);
  });

  it.each(["source", "target", "permission", "time", "public_window"])("does not reuse a result after the semantic %s input changes", (field) => {
    const { record, request } = fixture();
    const current = changedInput(request, (payload) => {
      if (field === "source") payload.reviewPlan.sources[0]!.text += " 原记录并未确认本人。";
      if (field === "target") payload.facts[0]!.statement += " 并且在场持续了整晚。";
      if (field === "permission") payload.reviewPlan.obligations[0]!.allowedSourceIds = [];
      if (field === "time") payload.setting.occurredAt = "2026-09-05T22:10:00+08:00";
      if (field === "public_window") payload.publicWindowContext[0]!.text += " 实施窗口另有变化。";
    });
    expect(new SameDraftReviewReplay([record]).take(artifactHash, current)).toBeUndefined();
  });

  it.each([false, true])("requires the same artifact and complete system/user input for opening=%s", (opening) => {
    const { record, request } = fixture(opening);
    expect(new SameDraftReviewReplay([record]).take("changed_draft_hash", request)).toBeUndefined();
    const messages = structuredClone(request.messages);
    messages[0]!.content += " 审查协议已改变。";
    expect(new SameDraftReviewReplay([record]).take(artifactHash, { ...request, messages })).toBeUndefined();
    messages[0] = request.messages[0]!;
    const payload = JSON.parse(messages[1]!.content);
    payload.extraPublicClue = "新的公开线索";
    messages[1]!.content = JSON.stringify(payload);
    expect(new SameDraftReviewReplay([record]).take(artifactHash, { ...request, messages })).toBeUndefined();
  });

  it("does not reuse length-truncated JSON, missing obligations or a foreign source", () => {
    const { record, request } = fixture();
    const truncated = structuredClone(record);
    (truncated.result.rawResponse.responseMetadata as { finish_reason: string }).finish_reason = "length";
    expect(new SameDraftReviewReplay([truncated]).take(artifactHash, request)).toBeUndefined();
    const missing = structuredClone(record);
    missing.result.value = { results: [] };
    expect(() => new SameDraftReviewReplay([missing]).take(artifactHash, request)).toThrow();
    const foreign = structuredClone(record);
    const review = makeSupportedEvidenceReview(plan);
    review.results[0]!.citations = [{ sourceId: "source_from_another_group", aspects: ["basis"] }];
    foreign.result.value = review;
    expect(() => new SameDraftReviewReplay([foreign]).take(artifactHash, request)).toThrow();
  });

  it("cannot replace the original rejected response with a different valid decoded verdict", () => {
    const { record, request } = fixture();
    const original = structuredClone(record.result.value);
    record.result.value = makeSupportedEvidenceReview(plan);
    let returned: Record<string, unknown> | undefined;
    try { returned = new SameDraftReviewReplay([record]).take(artifactHash, request)?.result.value; } catch { return; }
    expect(returned === undefined || JSON.stringify(returned) === JSON.stringify(original)).toBe(true);
  });
});
