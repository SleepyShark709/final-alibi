import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemorySaver } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  StructuredModelProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { parseCaseArtifact } from "@/domain/case/case-artifact";
import {
  createDatabase,
  type DatabaseHandle,
} from "@/infrastructure/db/database";
import { caseArtifacts, modelRuns } from "@/infrastructure/db/schema";
import { GameRepository } from "@/infrastructure/persistence/game-repository";

import {
  CaseGenerationService,
  processNextCaseGenerationJob,
} from "./case-generation-service";

describe("CaseGenerationService", () => {
  let directory: string;
  let database: DatabaseHandle;
  let repository: GameRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "spy-game-generation-service-"));
    database = await createDatabase({
      url: `file:${path.join(directory, "test.sqlite")}`,
    });
    repository = new GameRepository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("runs a queued generation job and freezes the exact artifact for replay", async () => {
    const identity = await repository.createAnonymousIdentity();
    const artifact = parseCaseArtifact({
      ...tutorialCase,
      id: "case_service_generated",
      seed: "service-seed",
    });
    const provider = new ScriptedProvider([
      artifact,
      {
        culpritId: artifact.culpritId,
        evidenceIds: [
          "evidence_transfer_ledger",
          "evidence_smart_lock_log",
          "evidence_brass_bookend",
        ],
        reasoning: "账目锁定动机，门禁记录与凶器痕迹共同建立机会和作案手法，排除其他嫌疑人。",
      },
    ]);
    const service = new CaseGenerationService(
      repository,
      provider,
      new MemorySaver(),
    );
    const queued = await service.enqueue(identity.playerId, {
      seed: "service-seed",
      theme: "雨夜宅邸",
      difficulty: "standard",
    });

    const processed = await processNextCaseGenerationJob(repository, service);
    const job = await repository.getJob(identity.playerId, queued.jobId);
    const storedCases = await database.db.select().from(caseArtifacts);
    const storedRuns = await database.db.select().from(modelRuns);

    expect({
      processed,
      jobStatus: job.status,
      result: job.result,
      caseIds: storedCases.map((row) => row.id),
      modelNodes: storedRuns.map((row) => row.nodeName),
    }).toEqual({
      processed: { jobId: queued.jobId, status: "succeeded" },
      jobStatus: "succeeded",
      result: {
        caseId: "case_service_generated",
        title: "雨夜书房",
        estimatedCostMicrosCny: expect.any(Number),
      },
      caseIds: ["case_service_generated"],
      modelNodes: ["case_draft", "blind_solve"],
    });
    expect(job.result?.estimatedCostMicrosCny).toEqual(expect.any(Number));
    expect(Number(job.result?.estimatedCostMicrosCny)).toBeGreaterThan(0);
  });

  it("persists and logs actionable details when a generation job fails", async () => {
    const identity = await repository.createAnonymousIdentity();
    const service = new CaseGenerationService(
      repository,
      new FailingProvider(),
      new MemorySaver(),
    );
    const queued = await service.enqueue(identity.playerId, {
      seed: "service-failure-seed",
      theme: "雨夜宅邸",
      difficulty: "standard",
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const processed = await processNextCaseGenerationJob(repository, service);
      const job = await repository.getJob(identity.playerId, queued.jobId);

      expect(processed).toEqual({ jobId: queued.jobId, status: "failed" });
      expect(job).toMatchObject({
        status: "failed",
        error:
          "Error [status=400, code=MODEL_VALIDATION_FAILED]: model returned an invalid case artifact",
      });
      expect(errorLog).toHaveBeenCalledWith(
        "[generation-worker] job failed",
        expect.objectContaining({
          jobId: queued.jobId,
          attempt: 1,
          maxAttempts: 3,
          retryable: false,
          error: expect.objectContaining({
            name: "Error",
            message: "model returned an invalid case artifact",
            status: 400,
            code: "MODEL_VALIDATION_FAILED",
          }),
        }),
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});

class ScriptedProvider implements StructuredModelProvider {
  constructor(private readonly responses: unknown[]) {}

  async invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted response remains");
    return {
      value: request.schema.parse(response),
      model: "mock-deepseek-v4-pro",
      usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500 },
      rawResponse: { schema: request.schemaName },
    };
  }
}

class FailingProvider implements StructuredModelProvider {
  async invokeStructured<T extends Record<string, unknown>>(
    _request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    throw Object.assign(new Error("model returned an invalid case artifact"), {
      code: "MODEL_VALIDATION_FAILED",
      status: 400,
    });
  }
}
