import { describe, expect, it, vi } from "vitest";

import { StructuredOutputParseError, type StructuredModelProvider, type StructuredModelRequest } from "@/ai/model-provider";
import { parseCaseArtifact } from "@/domain/case/case-artifact";

import { buildEvidenceReviewPlan, validateEvidenceReview, type EvidenceReviewPlan } from "./evidence-review";
import { EvidenceReviewBatchError, reviewEvidenceInBatches } from "./evidence-review-batches";
import type { EvidenceReviewResult } from "./generation-schema";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";

const artifact = parseCaseArtifact(innCounterexample);
const fullPlan = buildEvidenceReviewPlan(artifact);
const window = fullPlan.obligations.find((item) => item.kind === "public_window")!;
type Request = StructuredModelRequest<Record<string, unknown>>;

function subset(obligations: EvidenceReviewPlan["obligations"], sourcePlan = fullPlan): EvidenceReviewPlan {
  const allowed = new Set(obligations.flatMap((item) => item.allowedSourceIds));
  return { obligations, sources: sourcePlan.sources.filter((source) => allowed.has(source.id)) };
}

function providerWith(respond: (plan: EvidenceReviewPlan, request: Request) => EvidenceReviewResult | Promise<EvidenceReviewResult>): StructuredModelProvider {
  return {
    async invokeStructured(request) {
      const plan = JSON.parse(request.messages[1]!.content).reviewPlan as EvidenceReviewPlan;
      const value = await respond(plan, request);
      return { value: request.schema.parse(value), model: "deepseek-v4-pro", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, rawResponse: {} };
    },
  };
}

function support(evidenceId: string) {
  return fullPlan.obligations.find((item) => item.kind === "supports" && item.evidenceId === evidenceId)!;
}

describe("independent evidence batch challenge", () => {
  it("rejects exchanged batch answers even when their union would cover every global obligation", async () => {
    const left = support("evidence_lin_phone");
    const right = support("evidence_lin_contract");
    const plan = subset([window, left, right]);
    const globallyComplete = { results: [
      ...makeSupportedEvidenceReview(subset([window])).results,
      ...makeSupportedEvidenceReview(subset([right])).results,
      ...makeSupportedEvidenceReview(subset([left])).results,
    ] };
    expect(validateEvidenceReview(plan, globallyComplete)).toEqual([]);
    const provider = providerWith((batch) => {
      const target = batch.obligations[0]!;
      return makeSupportedEvidenceReview(target.id === window.id ? batch : subset([target.id === left.id ? right : left]));
    });
    await expect(reviewEvidenceInBatches(provider, artifact, plan)).rejects.toBeInstanceOf(EvidenceReviewBatchError);
  });

  it("rejects using a delivered record's description to prove that the record was actually delivered", async () => {
    const localArtifact = structuredClone(artifact);
    localArtifact.evidence.find((item) => item.id === "evidence_lin_testimony")!.kind = "digital";
    const localPlan = buildEvidenceReviewPlan(localArtifact);
    const localWindow = localPlan.obligations.find((item) => item.kind === "public_window")!;
    const left = localPlan.obligations.find((item) => item.kind === "record_delivery" && item.evidenceId === "evidence_lin_testimony")!;
    const right = localPlan.obligations.find((item) => item.kind === "implicates" && item.evidenceId === "evidence_lin_testimony")!;
    const borrowed = right.allowedSourceIds.find((id) => !left.allowedSourceIds.includes(id))!;
    expect(borrowed).toBeDefined();
    let attacked = false;
    const provider = providerWith((batch) => {
      const review = makeSupportedEvidenceReview(batch);
      const result = review.results.find((item) => item.obligationId === left.id);
      if (result) {
        expect(batch.obligations.some((item) => item.id === right.id)).toBe(true);
        expect(batch.sources.some((source) => source.id === borrowed)).toBe(true);
        result.citations = [{ sourceId: borrowed, aspects: ["basis"] }];
        attacked = true;
      }
      return review;
    });
    await expect(reviewEvidenceInBatches(provider, localArtifact, subset([localWindow, left, right], localPlan))).rejects.toBeInstanceOf(EvidenceReviewBatchError);
    expect(attacked).toBe(true);
  });

  it("keeps a paid parse failure after a parallel late success and does not start the next batch", async () => {
    const plan = subset([window, support("evidence_lin_phone"), support("evidence_lin_contract"), support("evidence_zheng_testimony")]);
    const requests: Request[] = [];
    let failFirst!: (error: Error) => void;
    let releaseLate!: () => void;
    const first = new Promise<never>((_, reject) => { failFirst = reject; });
    const late = new Promise<void>((resolve) => { releaseLate = resolve; });
    let relationCalls = 0;
    const provider = providerWith(async (batch, request) => {
      requests.push(request);
      if (batch.obligations[0]!.kind === "public_window") return makeSupportedEvidenceReview(batch);
      relationCalls += 1;
      if (relationCalls === 1) return first;
      if (relationCalls === 2) await late;
      return makeSupportedEvidenceReview(batch);
    });
    const pending = reviewEvidenceInBatches(provider, artifact, plan).then((result) => ({ result }), (error: unknown) => ({ error }));
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    failFirst(new StructuredOutputParseError("case_evidence_review", "deepseek-v4-pro", {
      inputTokens: 10, cachedInputTokens: 0, outputTokens: 3_200,
    }, { finish_reason: "length", content: "" }, "thinking exhausted the response budget"));
    await vi.waitFor(() => expect(requests[2]!.signal!.aborted).toBe(true));
    releaseLate();
    const outcome = await pending;
    expect("error" in outcome).toBe(true);
    const error = (outcome as { error: EvidenceReviewBatchError }).error;
    expect(error).toBeInstanceOf(EvidenceReviewBatchError);
    expect(error.message).toContain("thinking exhausted");
    expect(requests).toHaveLength(3);
    expect(error.startedBatchIndices).toEqual([0, 1, 2]);
    expect(error.modelCalls.some((call) => call.outputTokens === 3_200)).toBe(true);
    expect(error.unreportedUsageBatchIndices).toContain(2);
    expect(requests.every((request) => request.maxRetries === 0 && request.maxTokens === 3_200)).toBe(true);
  });
});
