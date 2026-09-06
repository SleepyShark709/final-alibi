import { createHash } from "node:crypto";

import { MemorySaver } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StructuredOutputParseError, type StructuredModelProvider, type StructuredModelRequest, type StructuredModelResult } from "@/ai/model-provider";
import { parseCaseArtifact } from "@/domain/case/case-artifact";

import { createCaseGenerationGraph } from "./case-generation-graph";
import { buildEvidenceReviewPlan, type EvidenceReviewPlan } from "./evidence-review";
import { buildEvidenceReviewBatches, EVIDENCE_REVIEW_LIMITS, EvidenceReviewBatchError, reviewEvidenceInBatches } from "./evidence-review-batches";
import { buildEvidenceReviewMessages } from "./generation-prompts";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";
import { ScriptedBlindProtocol } from "./testing/scripted-blind-protocol";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";

const inn = parseCaseArtifact(innCounterexample);
afterEach(() => vi.useRealTimers());

class SupportedProvider implements StructuredModelProvider {
  readonly requests: StructuredModelRequest<Record<string, unknown>>[] = [];
  delayMs = 0;

  async invokeStructured<T extends Record<string, unknown>>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>> {
    this.requests.push(request);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const plan = JSON.parse(request.messages[1]!.content).reviewPlan as EvidenceReviewPlan;
    return { value: request.schema.parse(makeSupportedEvidenceReview(plan)), model: "mock", usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 60 }, rawResponse: { id: `response-${this.requests.length}` } };
  }
}

describe("bounded evidence review batches", () => {
  it("retains the exact global obligations and each complete source while grouping related work", () => {
    const plan = buildEvidenceReviewPlan(inn);
    const batches = buildEvidenceReviewBatches(plan);
    expect(batches[0]!.obligations.map((item) => item.kind)).toEqual(["public_window"]);
    expect(batches.flatMap((batch) => batch.obligations).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...plan.obligations].sort((a, b) => a.id.localeCompare(b.id)));
    for (const batch of batches) {
      expect(batch.obligations.length).toBeLessThanOrEqual(4);
      if (batch.obligations.some((item) => item.kind === "interview_lead")) expect(batch.obligations).toHaveLength(1);
      const ids = new Set(batch.obligations.flatMap((item) => item.allowedSourceIds));
      expect(batch.sources).toEqual(plan.sources.filter((item) => ids.has(item.id)));
      if (!batch.obligations.some((item) => item.kind === "interview_lead")) expect(new Set(batch.obligations.map((item) => item.evidenceId)).size).toBe(1);
    }
  });

  it("sends only batch targets and complete allowed sources, with public-window context granting no new sources", () => {
    const plan = buildEvidenceReviewPlan(inn);
    const batch = buildEvidenceReviewBatches(plan).find((item) => item.obligations.some((obligation) => obligation.evidenceId === "evidence_lin_testimony"))!;
    const publicWindowContext = plan.sources.filter((item) => item.evidenceId === "evidence_lin_phone");
    const messages = buildEvidenceReviewMessages(inn, batch, { index: 1, count: 12, publicWindowContext });
    const payload = JSON.parse(messages[1]!.content);
    expect(payload.evidence.map((item: { id: string }) => item.id)).toEqual(["evidence_lin_testimony"]);
    expect(payload.claims).toContainEqual(expect.objectContaining({ id: "claim_lin_alibi" }));
    expect(payload).not.toHaveProperty("publicContext");
    expect(payload.reviewPlan).toEqual(batch);
    expect(payload.reviewPlan.sources.some((item: { evidenceId: string }) => item.evidenceId === "evidence_lin_phone")).toBe(false);
    expect(payload.publicWindowContext).toEqual(publicWindowContext);
    expect(payload).not.toHaveProperty("truthTimeline");
    expect(payload.setting).toEqual({ era: inn.setting.era, place: inn.setting.place });
    expect(payload.publicWindow).toBeNull();
    expect(messages[1]!.content.length).toBeLessThan(buildEvidenceReviewMessages(inn)[1]!.content.length / 2);
  });

  it("preserves a complete wound-plus-weapon prerequisite chain for a later method verification", async () => {
    const artifact = structuredClone(inn);
    const verification = structuredClone(artifact.evidence.find((item) => item.id === "evidence_body_wound")!);
    verification.id = "evidence_method_verification";
    verification.description = "法医对照已取得的伤口与铜镇纸，确认三处创口形状吻合，该铜镇纸多次击打致死。";
    verification.discovery.prerequisiteEvidenceIds = ["evidence_body_wound", "evidence_paperweight"];
    verification.supportsFactIds = ["fact_method_blunt"];
    artifact.evidence.push(verification);
    const plan = buildEvidenceReviewPlan(artifact);
    const provider = new SupportedProvider();
    const result = await reviewEvidenceInBatches(provider, artifact, plan);
    const request = provider.requests.find((item) => JSON.parse(item.messages[1]!.content).reviewPlan.obligations.some((obligation: { evidenceId: string }) => obligation.evidenceId === verification.id))!;
    const batch = JSON.parse(request.messages[1]!.content).reviewPlan as EvidenceReviewPlan;
    expect(batch.sources.filter((item) => ["evidence_body_wound", "evidence_paperweight", verification.id].includes(item.evidenceId ?? ""))).toHaveLength(3);
    expect(result.issues).toEqual([]);
    expect(result.modelCalls).toHaveLength(provider.requests.length);
    expect(provider.requests).toHaveLength(buildEvidenceReviewBatches(plan).length);
    for (const request of provider.requests) {
      expect(request).toMatchObject({ reasoning: false, maxTokens: 3_200, maxRetries: 0 });
      expect(request.reasoningEffort).toBeUndefined();
    }
    expect(result.modelCalls.every((call) => typeof call.request.invocationId === "string")).toBe(true);
  });

  it("refuses an oversized plan before any paid request", async () => {
    const plan: EvidenceReviewPlan = { sources: [{ id: "s0", path: "evidence", text: "原文" }], obligations: Array.from({ length: 21 }, (_, index) => ({ id: `o${index}`, kind: "supports", evidenceId: `e${index}`, targetId: "fact", path: "evidence", allowedSourceIds: ["s0"], requiredAspects: ["basis"] })) };
    const provider = new SupportedProvider();
    await expect(reviewEvidenceInBatches(provider, inn, plan)).rejects.toThrow("maximum is 20");
    expect(provider.requests).toHaveLength(0);
    expect(EVIDENCE_REVIEW_LIMITS.maxBatches * EVIDENCE_REVIEW_LIMITS.maxTokensPerBatch).toBe(64_000);
  });

  it("carries the certified upstream interval into each batch and rejects a short coverage despite supported", async () => {
    const full = buildEvidenceReviewPlan(inn);
    const exclusion = full.obligations.find((obligation) => obligation.kind === "excludes")!;
    const plan = { ...full, obligations: [full.obligations[0]!, exclusion] };
    const expectedWindow = makeSupportedEvidenceReview(plan).results[0]!.publicWindow!;
    const provider: StructuredModelProvider = {
      async invokeStructured(request) {
        const payload = JSON.parse(request.messages[1]!.content);
        const value = makeSupportedEvidenceReview(payload.reviewPlan);
        if (payload.reviewBatch.index !== 0) {
          expect(payload.publicWindow).toEqual(expectedWindow);
          expect(payload.publicWindowContext.map((source: { id: string }) => source.id)).toEqual(expectedWindow.startSourceIds);
          value.results[0]!.coverage!.startAt = "2024-01-01T21:30:00+08:00";
          value.results[0]!.coverage!.endAt = "2024-01-01T22:30:00+08:00";
        }
        return { value: request.schema.parse(value), model: "mock", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 }, rawResponse: {} };
      },
    };
    const result = await reviewEvidenceInBatches(provider, inn, plan);
    expect(result.issues).toEqual([expect.objectContaining({ path: exclusion.path, message: expect.stringContaining("未完整覆盖公开作案窗口") })]);
    expect(result.review.results.find((item) => item.obligationId === exclusion.id)!.verdict).toBe("supported");
  });

  it("shares one 240-second deadline across queued and in-flight work", async () => {
    vi.useFakeTimers();
    const provider = new SupportedProvider();
    provider.delayMs = 60_000;
    const pending = reviewEvidenceInBatches(provider, inn, buildEvidenceReviewPlan(inn)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(240_000);
    const error = await pending;
    expect(error).toBeInstanceOf(EvidenceReviewBatchError);
    expect((error as Error).message).toContain("240-second");
    expect(provider.requests).toHaveLength(7);
    expect(new Set(provider.requests.map((request) => request.signal)).size).toBe(1);
    expect(provider.requests.every((request) => request.signal?.aborted)).toBe(true);
    expect((error as EvidenceReviewBatchError).unreportedUsageBatchIndices).toEqual([5, 6]);
  });

  it("resumes the same third-version checkpoint with fresh batch coverage and unchanged artifact", async () => {
    const artifact = makeGeneratedCaseArtifact("case_resume_batches", "supporting-seed-0");
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const originalHash = hash(artifact);
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: "generation_resume_batches" } };
    const blindProtocol = new ScriptedBlindProtocol();
    blindProtocol.reply({ schemaName: "case_artifact", messages: [] }, artifact);
    let fail = true;
    const calls: string[] = [];
    const provider: StructuredModelProvider = {
      async invokeStructured(request) {
        calls.push(request.schemaName);
        const value = request.schemaName === "case_opening_review" ? { issues: [] }
          : request.schemaName === "case_evidence_review" ? makeSupportedEvidenceReview(JSON.parse(request.messages[1]!.content).reviewPlan)
          : blindProtocol.reply(request, { culpritId: artifact.culpritId, evidenceIds: artifact.evidence.map((item) => item.id), reasoning: "全部可达来源建立动机、手法、指向与排除。" });
        if (fail && request.schemaName === "case_evidence_review") throw new StructuredOutputParseError("case_evidence_review", "mock", { inputTokens: 100, cachedInputTokens: 0, outputTokens: 3_200 }, { content: "", reasoningContentChars: 7_000 }, "empty content, finish_reason=length");
        return { value: request.schema.parse(value), model: "mock", usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 80 }, rawResponse: {} };
      },
    };
    const graph = createCaseGenerationGraph(provider, { checkpointer });
    await graph.updateState(config, { request: { seed: artifact.seed, theme: "回归", difficulty: "standard" }, attempt: 3, draft: artifact, validationIssues: [], modelCalls: [] }, "validate_case");
    await expect(graph.invoke(null, config)).rejects.toBeInstanceOf(EvidenceReviewBatchError);
    const failed = await graph.getState(config);
    expect(failed.next).toEqual(["blind_solve_case"]);
    expect(failed.values.attempt).toBe(3);
    expect(hash(failed.values.draft)).toBe(originalHash);
    fail = false;
    const result = await createCaseGenerationGraph(provider, { checkpointer }).invoke(null, config);
    expect(result.attempt).toBe(3);
    expect(hash(result.finalArtifact)).toBe(originalHash);
    expect(calls).not.toContain("case_artifact");
    expect(calls).not.toContain("case_artifact_repair_patch");
    expect(calls.filter((name) => name === "case_evidence_review")).toHaveLength(1 + buildEvidenceReviewBatches(buildEvidenceReviewPlan(artifact)).length);
  });
});
