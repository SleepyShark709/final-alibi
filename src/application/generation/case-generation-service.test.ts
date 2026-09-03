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
import { makeGeneratedCaseArtifact } from "@/ai/generation/testing/make-generated-case-artifact";
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
    const artifact = makeGeneratedCaseArtifact(
      "case_service_generated",
      "service-seed",
    );
    const provider = new ScriptedProvider([
      artifact,
      {
        culpritId: artifact.culpritId,
        evidenceIds: artifact.evidence.map((evidence) => evidence.id),
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

  it("requeues a structurally rejected case for a fresh full draft", async () => {
    const identity = await repository.createAnonymousIdentity();
    const valid = makeGeneratedCaseArtifact(
      "case_service_retried",
      "service-retry-seed",
    );
    const invalid = structuredClone(valid);
    invalid.scenes = invalid.scenes.slice(0, 2);
    const provider = new ScriptedProvider([
      invalid,
      { title: valid.title },
      { title: valid.title },
      { title: valid.title },
      valid,
      {
        culpritId: valid.culpritId,
        evidenceIds: valid.evidence.map((evidence) => evidence.id),
        reasoning: "账目、门禁与凶器痕迹共同形成完整的动机、机会和手法闭环。",
      },
    ]);
    const service = new CaseGenerationService(
      repository,
      provider,
      new MemorySaver(),
    );
    const queued = await service.enqueue(identity.playerId, {
      seed: "service-retry-seed",
      theme: "雨夜宅邸",
      difficulty: "standard",
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const first = await processNextCaseGenerationJob(repository, service);
      const afterFirst = await repository.getJob(identity.playerId, queued.jobId);
      const second = await processNextCaseGenerationJob(repository, service);
      const completed = await repository.getJob(identity.playerId, queued.jobId);

      expect({
        first,
        firstStatus: afterFirst.status,
        firstAttempts: afterFirst.attempts,
        firstError: afterFirst.error,
        second,
        completedStatus: completed.status,
        completedAttempts: completed.attempts,
        caseId: completed.result?.caseId,
      }).toEqual({
        first: { jobId: queued.jobId, status: "retrying" },
        firstStatus: "queued",
        firstAttempts: 1,
        firstError: expect.stringContaining("CaseGenerationRejectedError"),
        second: { jobId: queued.jobId, status: "succeeded" },
        completedStatus: "succeeded",
        completedAttempts: 2,
        caseId: "case_service_retried",
      });
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
