import { createHash, randomUUID } from "node:crypto";

import type { BaseCheckpointSaver } from "@langchain/langgraph";

import {
  createCaseGenerationGraph,
  type CaseGenerationProgressListener,
} from "@/ai/generation/case-generation-graph";
import {
  caseGenerationRequestSchema,
  type BlindSolveResult,
  type CaseGenerationRequest,
} from "@/ai/generation/generation-schema";
import type { ModelCallAudit } from "@/ai/model-audit";
import type { StructuredModelProvider } from "@/ai/model-provider";
import type { CaseArtifact } from "@/domain/case/case-artifact";
import type {
  ClaimedJob,
  GameRepository,
} from "@/infrastructure/persistence/game-repository";

export interface GenerateCaseResult {
  caseArtifact: CaseArtifact;
  blindSolve: BlindSolveResult;
  attemptCount: number;
  estimatedCostMicrosCny: number;
}

interface GenerationErrorDetails {
  name: string;
  message: string;
  code?: string;
  status?: number;
  stack?: string;
  validationIssues?: Array<{
    code: string;
    path: string;
    message: string;
  }>;
}

export class CaseGenerationRejectedError extends Error {
  constructor(
    message: string,
    readonly validationIssues: Array<{
      code: string;
      path: string;
      message: string;
    }>,
  ) {
    super(message);
    this.name = "CaseGenerationRejectedError";
  }
}

export class CaseGenerationService {
  private readonly graph;

  constructor(
    private readonly repository: GameRepository,
    private readonly provider: StructuredModelProvider,
    private readonly checkpointer?: BaseCheckpointSaver,
  ) {
    this.graph = createCaseGenerationGraph(provider, { checkpointer });
  }

  async enqueue(
    playerId: string,
    input: Omit<Partial<CaseGenerationRequest>, "seed"> & { seed?: string },
    now?: string,
  ) {
    // Web 请求只入 durable queue；耗时生成由独立 worker 完成，避免受 Route Handler 生命周期影响。
    const request = caseGenerationRequestSchema.parse({
      ...input,
      seed: input.seed ?? `case-seed-${randomUUID()}`,
    });
    const jobId = await this.repository.enqueueJob({
      playerId,
      type: "generate_case",
      payload: request,
      maxAttempts: 3,
      now,
    });
    return { jobId, seed: request.seed };
  }

  async generateNow(
    requestInput: CaseGenerationRequest,
    generationId = `generation_${randomUUID().replaceAll("-", "")}`,
    options: { onProgress?: CaseGenerationProgressListener } = {},
  ): Promise<GenerateCaseResult> {
    // generationId 同时是审计关联键和 checkpoint thread id；重试必须传入新的 id。
    const request = caseGenerationRequestSchema.parse(requestInput);
    // 有进度订阅的 worker 需要独立 graph 实例；常规直接调用仍复用预编译图。
    const graph = options.onProgress
      ? createCaseGenerationGraph(this.provider, {
          checkpointer: this.checkpointer,
          onProgress: options.onProgress,
        })
      : this.graph;
    const result = await graph.invoke(
      {
        request,
        attempt: 0,
        draft: null,
        validationIssues: [],
        formatRepairTargets: [],
        blindSolve: null,
        finalArtifact: null,
        rejectionReason: null,
        modelCalls: [],
      },
      { configurable: { thread_id: generationId } },
    );

    if (!result.finalArtifact || !result.blindSolve) {
      await this.persistModelCalls(result.modelCalls, generationId);
      throw new CaseGenerationRejectedError(
        result.rejectionReason ?? "generated case did not pass validation",
        result.validationIssues,
      );
    }

    const estimatedCostMicrosCny = result.modelCalls.reduce(
      (total, call) => total + call.estimatedCostMicrosCny,
      0,
    );
    const caseArtifact = await this.repository.registerCase(
      result.finalArtifact,
      "generated",
      {
        generationMetadata: {
          generationId,
          request,
          attemptCount: result.attempt,
          blindSolve: result.blindSolve,
          estimatedCostMicrosCny,
          modelNames: [...new Set(result.modelCalls.map((call) => call.model))],
        },
      },
    );
    await this.persistModelCalls(result.modelCalls, generationId, caseArtifact.id);

    return {
      caseArtifact,
      blindSolve: result.blindSolve,
      attemptCount: result.attempt,
      estimatedCostMicrosCny,
    };
  }

  async processClaimedJob(
    job: ClaimedJob,
    onProgress?: CaseGenerationProgressListener,
  ): Promise<GenerateCaseResult> {
    if (job.type !== "generate_case") {
      throw new Error(`Unsupported job type "${job.type}"`);
    }
    // attempt 进入 thread id，防止过期 job 恢复上一轮的图状态。
    return this.generateNow(
      caseGenerationRequestSchema.parse(job.payload),
      `job:${job.id}:attempt:${job.attempts}`,
      { onProgress },
    );
  }

  private async persistModelCalls(
    calls: ModelCallAudit[],
    generationId: string,
    caseId?: string,
  ) {
    for (const call of calls) {
      const modelRunId = await this.repository.startModelRun({
        caseId,
        commandId: generationId,
        graphName: "case_generation",
        nodeName: call.task,
        provider: "deepseek",
        model: call.model,
        promptHash: createHash("sha256")
          .update(JSON.stringify(call.request))
          .digest("hex"),
        request: call.request,
      });
      await this.repository.finishModelRun({
        id: modelRunId,
        response: call.response,
        inputTokens: call.inputTokens,
        cachedInputTokens: call.cachedInputTokens,
        outputTokens: call.outputTokens,
        estimatedCostMicrosCny: call.estimatedCostMicrosCny,
      });
    }
  }
}

export async function processNextCaseGenerationJob(
  repository: GameRepository,
  service: CaseGenerationService,
  now = new Date().toISOString(),
): Promise<{ jobId: string; status: "succeeded" | "retrying" | "failed" } | null> {
  const job = await repository.claimNextJob(now);
  if (!job) return null;

  // 心跳不持锁；它只刷新 running job 的 updatedAt，防止一次长模型调用被当成 crashed worker。
  const heartbeat = setInterval(() => {
    void repository.heartbeatJob(job.id).catch(() => undefined);
  }, 10_000);

  try {
    const result = await service.processClaimedJob(job, async ({ stage, progress }) => {
      await repository.updateJobProgress({ jobId: job.id, stage, progress });
    });
    await repository.completeJob(
      job.id,
      {
        caseId: result.caseArtifact.id,
        title: result.caseArtifact.title,
        estimatedCostMicrosCny: result.estimatedCostMicrosCny,
      },
      now,
    );
    return { jobId: job.id, status: "succeeded" };
  } catch (error) {
    const retryable = isTransientModelError(error);
    const failure = describeGenerationError(error);
    const status = retryable && job.attempts < job.maxAttempts ? "retrying" : "failed";

    console.error("[generation-worker] job failed", {
      jobId: job.id,
      playerId: job.playerId,
      type: job.type,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      retryable,
      status,
      error: failure,
    });

    await repository.failJob(job.id, formatGenerationError(failure), { retryable, now });
    return {
      jobId: job.id,
      status,
    };
  } finally {
    clearInterval(heartbeat);
  }
}

function isTransientModelError(error: unknown) {
  if (error instanceof CaseGenerationRejectedError) return false;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: number; code?: string };
  return (
    candidate.status === 429 ||
    candidate.status === 500 ||
    candidate.status === 503 ||
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "ECONNRESET"
  );
}

function describeGenerationError(error: unknown): GenerationErrorDetails {
  const record = isRecord(error) ? error : undefined;
  const name =
    error instanceof Error
      ? error.name || "Error"
      : readNonEmptyString(record?.name) ?? "UnknownError";
  const message = errorMessage(error, record);
  const code = readErrorCode(record?.code);
  const status =
    typeof record?.status === "number" && Number.isFinite(record.status)
      ? record.status
      : undefined;

  return {
    name,
    message,
    ...(code ? { code } : {}),
    ...(status === undefined ? {} : { status }),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    ...(error instanceof CaseGenerationRejectedError
      ? { validationIssues: error.validationIssues }
      : {}),
  };
}

function formatGenerationError(error: GenerationErrorDetails) {
  const context = [
    error.status === undefined ? undefined : `status=${error.status}`,
    error.code ? `code=${error.code}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const prefix = context.length > 0 ? `${error.name} [${context.join(", ")}]` : error.name;
  return `${prefix}: ${error.message}`;
}

function errorMessage(error: unknown, record?: Record<string, unknown>) {
  if (error instanceof Error && error.message) return error.message;
  const message = readNonEmptyString(record?.message);
  if (message) return message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readErrorCode(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}
