import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EvidenceReviewBatchError } from "@/ai/generation/evidence-review-batches";
import { makeGeneratedCaseArtifact } from "@/ai/generation/testing/make-generated-case-artifact";
import { createModelCallAudit, createModelCallAuditFromStructuredOutputParseError, type ModelCallAudit } from "@/ai/model-audit";
import { StructuredOutputParseError, type StructuredModelProvider } from "@/ai/model-provider";
import { createDatabase, type DatabaseHandle } from "@/infrastructure/db/database";
import { caseArtifacts, modelRuns } from "@/infrastructure/db/schema";
import { GameRepository } from "@/infrastructure/persistence/game-repository";

import { CaseGenerationService } from "./case-generation-service";

// 本验收独立控制图的恢复结果，只测真实 service / repository 的审计持久化，不复测分组协议。
const graph = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/ai/generation/case-generation-graph", () => ({ createCaseGenerationGraph: () => graph }));

const request = { seed: "independent-audit-seed", theme: "雨夜书房", difficulty: "standard" as const };
const messages = [{ role: "user" as const, content: "审核当前证据。" }];
const usage = { inputTokens: 120, cachedInputTokens: 20, outputTokens: 40 };
const occurredAt = new Date("2026-09-05T00:00:00Z");
const noModel: StructuredModelProvider = { async invokeStructured() { throw new Error("Independent audit tests never call a provider"); } };

function completedCall() {
  return createModelCallAudit("evidence_review", "pro", messages, {
    value: { results: [] }, model: "independent-audit-model", usage,
    rawResponse: { content: "{\"results\":[]}", finishReason: "stop" },
  }, occurredAt);
}

function failure(calls: ModelCallAudit[], unknownUsage = false) {
  return new EvidenceReviewBatchError(new Error("audit fixture failure"), calls, unknownUsage ? [0, 1] : [0], unknownUsage ? [1] : []);
}

describe("independent generation audit persistence", () => {
  let directory: string;
  let database: DatabaseHandle;
  let repository: GameRepository;
  let service: CaseGenerationService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "final-alibi-generation-audit-"));
    database = await createDatabase({ url: `file:${path.join(directory, "audit.sqlite")}` });
    repository = new GameRepository(database);
    service = new CaseGenerationService(repository, noModel);
    graph.invoke.mockReset();
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("stores a truncated response's known usage once and does not invent usage for a cancelled sibling", async () => {
    const parseError = new StructuredOutputParseError("case_evidence_review", "independent-audit-model", usage,
      { content: "{\"results\":[", finishReason: "length" }, "truncated response");
    const audit = createModelCallAuditFromStructuredOutputParseError("evidence_review", "pro", messages, parseError, occurredAt);
    const originalFailure = failure([audit], true);
    graph.invoke.mockRejectedValueOnce(originalFailure);
    await expect(service.generateNow(request, "generation_audit_failure")).rejects.toBe(originalFailure);
    const [stored] = await database.db.select().from(modelRuns);
    expect(stored).toMatchObject({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 40, estimatedCostMicrosCny: audit.estimatedCostMicrosCny });
    expect(stored?.responseJson).toMatchObject({ content: "{\"results\":[", finishReason: "length", structuredOutputParse: { diagnostic: "truncated response" } });
    expect(originalFailure.unreportedUsageBatchIndices).toEqual([1]);
    const restored = JSON.parse(JSON.stringify(audit)) as ModelCallAudit;
    graph.invoke.mockRejectedValueOnce(failure([restored], true));
    await expect(new CaseGenerationService(repository, noModel).generateNow(request, "generation_audit_failure")).rejects.toThrow();
    expect(await database.db.select().from(modelRuns)).toEqual([stored]);
    expect(await database.db.select().from(caseArtifacts)).toEqual([]);
  });

  it("gives two actual calls different IDs even when request, reply and usage are identical", async () => {
    const first = completedCall();
    const second = completedCall();
    expect(first.request.invocationId).not.toBe(second.request.invocationId);
    expect(first.response).toEqual(second.response);
    graph.invoke.mockRejectedValueOnce(failure([first]));
    await expect(service.generateNow(request, "generation_same_content")).rejects.toThrow();
    graph.invoke.mockRejectedValueOnce(failure([JSON.parse(JSON.stringify(first)) as ModelCallAudit, second]));
    await expect(service.generateNow(request, "generation_same_content")).rejects.toThrow();
    const rows = await database.db.select().from(modelRuns);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.reduce((total, row) => total + row.estimatedCostMicrosCny, 0)).toBe(first.estimatedCostMicrosCny + second.estimatedCostMicrosCny);
  });

  it("preserves two identical legacy call occurrences without adding them again during recovery", async () => {
    const legacy = completedCall();
    delete legacy.request.invocationId;
    const history = [legacy, structuredClone(legacy)];
    graph.invoke.mockRejectedValue(failure(history));
    await expect(service.generateNow(request, "generation_legacy_history")).rejects.toThrow();
    await expect(service.generateNow(request, "generation_legacy_history")).rejects.toThrow();
    const rows = await database.db.select().from(modelRuns);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((total, row) => total + row.estimatedCostMicrosCny, 0)).toBe(legacy.estimatedCostMicrosCny * 2);
  });

  it("links an already persisted call to its eventual case without charging it twice", async () => {
    const history = completedCall();
    graph.invoke.mockRejectedValueOnce(failure([history]));
    await expect(service.generateNow(request, "generation_recovered_case")).rejects.toThrow();
    const artifact = makeGeneratedCaseArtifact("case_recovered_audit", request.seed);
    const latest = completedCall();
    graph.invoke.mockResolvedValueOnce({ finalArtifact: artifact,
      blindSolve: { culpritId: artifact.culpritId, evidenceIds: artifact.evidence.map((item) => item.id), reasoning: "完整证据相互印证动机、手法及身份。" },
      attempt: 1, modelCalls: [structuredClone(history), latest], validationIssues: [], rejectionReason: null,
    });
    const result = await service.generateNow(request, "generation_recovered_case");
    expect(result.estimatedCostMicrosCny).toBe(history.estimatedCostMicrosCny + latest.estimatedCostMicrosCny);
    const rows = await database.db.select().from(modelRuns);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.caseId === artifact.id)).toBe(true);
    const player = await repository.createAnonymousIdentity();
    const { session } = await repository.createGame(player.playerId, result.caseArtifact, { sessionId: "game_recovered_audit" });
    const snapshot = await repository.getGodModeSnapshot(player.playerId, session.id);
    expect(snapshot.modelRuns).toHaveLength(2);
    expect(snapshot.modelRuns.reduce((total, row) => total + row.estimatedCostMicrosCny, 0)).toBe(result.estimatedCostMicrosCny);
  });

  it("does not turn an entirely unreported cancellation into a zero-token completed call", async () => {
    const cancelled = new EvidenceReviewBatchError(new Error("request cancelled"), [], [0], [0]);
    graph.invoke.mockRejectedValue(cancelled);
    await expect(service.generateNow(request, "generation_cancelled_audit")).rejects.toBe(cancelled);
    expect(await database.db.select().from(modelRuns)).toEqual([]);
    expect(await database.db.select().from(caseArtifacts)).toEqual([]);
  });
});
