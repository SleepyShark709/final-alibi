import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNull, or } from "drizzle-orm";

import {
  parseCaseArtifact,
  type CaseArtifact,
} from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";
import {
  startGame,
  type GameEvent,
  type GameSession,
  type StartGameOptions,
} from "@/domain/game/game-runtime";
import type { DatabaseHandle } from "@/infrastructure/db/database";
import {
  anonymousPlayers,
  caseArtifacts,
  gameCommands,
  gameEvents,
  gameSessions,
  jobs,
  modelRuns,
} from "@/infrastructure/db/schema";

export type CaseSource = "tutorial" | "generated" | "imported";
export type JobType = "generate_case" | "validate_case" | "blind_solve" | "summarize";
export type JobStage =
  | "queued"
  | "starting"
  | "drafting"
  | "validating"
  | "repairing"
  | "blind_solving"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AnonymousIdentity {
  playerId: string;
  accessToken: string;
}

export interface PersistedGame {
  caseArtifact: CaseArtifact;
  session: GameSession;
}

export interface ReadyCaseSummary {
  id: string;
  title: string;
  briefing: string;
  source: CaseSource;
  createdAt: string;
}

export interface BeginGameCommandInput {
  playerId: string;
  sessionId: string;
  commandId: string;
  kind: string;
  request: Record<string, unknown>;
  expectedRevision?: number;
  now?: string;
}

export type BeginGameCommandResult<T> =
  | {
      status: "accepted";
      caseArtifact: CaseArtifact;
      session: GameSession;
      baseRevision: number;
    }
  | {
      status: "committed";
      session: GameSession;
      outcome: T;
      committedRevision: number;
    }
  | { status: "running"; error?: string }
  | { status: "failed"; error?: string };

export interface ExecuteGameCommandInput extends BeginGameCommandInput {}

export interface ExecuteGameCommandResult<T> {
  session: GameSession;
  outcome: T;
  replayed: boolean;
}

export interface EnqueueJobInput {
  playerId?: string;
  type: JobType;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  now?: string;
}

export interface ClaimedJob {
  id: string;
  playerId: string | null;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface JobView {
  id: string;
  type: JobType;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: JobStage;
  progress: number;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface StartModelRunInput {
  sessionId?: string;
  caseId?: string;
  commandId?: string;
  graphName: string;
  nodeName: string;
  provider: string;
  model: string;
  promptHash: string;
  request: Record<string, unknown>;
  now?: string;
}

export class PersistenceError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_case"
      | "case_id_conflict"
      | "revision_conflict"
      | "command_running"
      | "command_failed"
      | "invalid_transition",
    message: string,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

/**
 * 领域持久化边界。SQLite 中的 case/session/event/command 是业务真相；
 * LangGraph checkpoint 只保存一次 Agent 执行的恢复游标，不能拿来替代这些记录。
 */
export class GameRepository {
  constructor(private readonly database: DatabaseHandle) {}

  async createAnonymousIdentity(now = new Date().toISOString()): Promise<AnonymousIdentity> {
    const playerId = `player_${randomUUID().replaceAll("-", "")}`;
    const accessToken = `anon_${randomBytes(32).toString("base64url")}`;

    await this.database.db.insert(anonymousPlayers).values({
      id: playerId,
      accessTokenHash: hashSecret(accessToken),
      createdAt: now,
      lastSeenAt: now,
    });

    return { playerId, accessToken };
  }

  async authenticateAnonymousPlayer(
    accessToken: string,
    now = new Date().toISOString(),
  ): Promise<string | null> {
    const [player] = await this.database.db
      .select({ id: anonymousPlayers.id })
      .from(anonymousPlayers)
      .where(eq(anonymousPlayers.accessTokenHash, hashSecret(accessToken)))
      .limit(1);
    if (!player) return null;

    await this.database.db
      .update(anonymousPlayers)
      .set({ lastSeenAt: now })
      .where(eq(anonymousPlayers.id, player.id));
    return player.id;
  }

  async registerCase(
    input: CaseArtifact,
    source: CaseSource,
    options: {
      now?: string;
      generationMetadata?: Record<string, unknown>;
    } = {},
  ): Promise<CaseArtifact> {
    // 先执行发布门禁，再按内容哈希绑定 case id；已有 id 绝不能被另一份真相账本覆盖。
    const caseArtifact = parseCaseArtifact(input);
    const validation = validatePublishableCaseArtifact(caseArtifact);
    if (!validation.valid) {
      throw new PersistenceError(
        "invalid_case",
        validation.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; "),
      );
    }

    const contentHash = hashJson(caseArtifact);
    const [existing] = await this.database.db
      .select({ contentHash: caseArtifacts.contentHash })
      .from(caseArtifacts)
      .where(eq(caseArtifacts.id, caseArtifact.id))
      .limit(1);
    if (existing) {
      if (existing.contentHash !== contentHash) {
        throw new PersistenceError(
          "case_id_conflict",
          `case id "${caseArtifact.id}" is already bound to a different truth ledger`,
        );
      }
      return caseArtifact;
    }

    const now = options.now ?? new Date().toISOString();
    await this.database.db
      .insert(caseArtifacts)
      .values({
        id: caseArtifact.id,
        schemaVersion: caseArtifact.schemaVersion,
        source,
        status: "ready",
        seed: caseArtifact.seed,
        contentHash,
        artifactJson: caseArtifact,
        generationMetadataJson: options.generationMetadata ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const [stored] = await this.database.db
      .select({
        contentHash: caseArtifacts.contentHash,
        artifactJson: caseArtifacts.artifactJson,
      })
      .from(caseArtifacts)
      .where(eq(caseArtifacts.id, caseArtifact.id))
      .limit(1);
    if (!stored || stored.contentHash !== contentHash) {
      throw new PersistenceError(
        "case_id_conflict",
        `case id "${caseArtifact.id}" could not be bound to this truth ledger`,
      );
    }
    return parseCaseArtifact(stored.artifactJson);
  }

  async createGame(
    playerId: string,
    caseArtifact: CaseArtifact,
    options: StartGameOptions & { source?: CaseSource } = {},
  ): Promise<PersistedGame> {
    const registeredCase = await this.registerCase(
      caseArtifact,
      options.source ?? "generated",
      { now: options.now },
    );
    await this.requirePlayer(playerId);

    const session = startGame(registeredCase, options);
    const startedEvent = session.events[0];
    if (!startedEvent) {
      throw new PersistenceError("invalid_transition", "new game has no start event");
    }

    await this.database.db.transaction(async (transaction) => {
      await transaction.insert(gameSessions).values({
        id: session.id,
        playerId,
        caseId: session.caseId,
        status: session.status,
        revision: session.revision,
        stateJson: session,
        createdAt: session.startedAt,
        updatedAt: session.updatedAt,
      });
      await transaction.insert(gameEvents).values(eventRow(session.id, startedEvent));
    });

    return { caseArtifact: registeredCase, session };
  }

  async getReadyCase(caseId: string): Promise<CaseArtifact> {
    const [row] = await this.database.db
      .select({
        status: caseArtifacts.status,
        artifactJson: caseArtifacts.artifactJson,
      })
      .from(caseArtifacts)
      .where(eq(caseArtifacts.id, caseId))
      .limit(1);
    if (!row || row.status !== "ready") {
      throw new PersistenceError("not_found", `ready case "${caseId}" does not exist`);
    }
    return parseCaseArtifact(row.artifactJson);
  }

  async listReadyCases(): Promise<ReadyCaseSummary[]> {
    const rows = await this.database.db
      .select({
        id: caseArtifacts.id,
        source: caseArtifacts.source,
        artifactJson: caseArtifacts.artifactJson,
        createdAt: caseArtifacts.createdAt,
      })
      .from(caseArtifacts)
      .where(eq(caseArtifacts.status, "ready"))
      .orderBy(desc(caseArtifacts.createdAt));
    return rows.map((row) => ({
      id: row.id,
      title: row.artifactJson.title,
      briefing: row.artifactJson.briefing,
      source: row.source,
      createdAt: row.createdAt,
    }));
  }

  async loadGame(playerId: string, sessionId: string): Promise<PersistedGame> {
    const [sessionRow] = await this.database.db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.id, sessionId))
      .limit(1);
    if (!sessionRow) {
      throw new PersistenceError("not_found", `game "${sessionId}" does not exist`);
    }
    if (sessionRow.playerId !== playerId) {
      throw new PersistenceError("forbidden", "game belongs to another player");
    }

    const [caseRow] = await this.database.db
      .select({ artifactJson: caseArtifacts.artifactJson })
      .from(caseArtifacts)
      .where(eq(caseArtifacts.id, sessionRow.caseId))
      .limit(1);
    if (!caseRow) {
      throw new PersistenceError(
        "not_found",
        `case "${sessionRow.caseId}" does not exist`,
      );
    }

    return {
      caseArtifact: parseCaseArtifact(caseRow.artifactJson),
      session: parseStoredSession(sessionRow.stateJson, sessionRow.id, sessionRow.caseId),
    };
  }

  async listGames(playerId: string): Promise<GameSession[]> {
    const rows = await this.database.db
      .select({
        id: gameSessions.id,
        caseId: gameSessions.caseId,
        stateJson: gameSessions.stateJson,
      })
      .from(gameSessions)
      .where(eq(gameSessions.playerId, playerId));

    return rows.map((row) => parseStoredSession(row.stateJson, row.id, row.caseId));
  }

  async beginGameCommand<T = unknown>(
    input: BeginGameCommandInput,
  ): Promise<BeginGameCommandResult<T>> {
    // 此短事务只认领幂等 commandId 与 base revision，绝不把可能很慢的 LLM 调用包在事务里。
    const now = input.now ?? new Date().toISOString();

    return this.database.db.transaction(async (transaction) => {
      const [sessionRow] = await transaction
        .select()
        .from(gameSessions)
        .where(eq(gameSessions.id, input.sessionId))
        .limit(1);
      if (!sessionRow) {
        throw new PersistenceError(
          "not_found",
          `game "${input.sessionId}" does not exist`,
        );
      }
      if (sessionRow.playerId !== input.playerId) {
        throw new PersistenceError("forbidden", "game belongs to another player");
      }

      const [existingBeforeRevisionCheck] = await transaction
        .select()
        .from(gameCommands)
        .where(
          and(
            eq(gameCommands.sessionId, input.sessionId),
            eq(gameCommands.commandId, input.commandId),
          ),
        )
        .limit(1);
      if (existingBeforeRevisionCheck) {
        return existingCommandResult<T>(existingBeforeRevisionCheck, sessionRow);
      }

      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== sessionRow.revision
      ) {
        throw new PersistenceError(
          "revision_conflict",
          `expected revision ${input.expectedRevision}, found ${sessionRow.revision}`,
        );
      }

      const inserted = await transaction
        .insert(gameCommands)
        .values({
          id: `command_${randomUUID().replaceAll("-", "")}`,
          sessionId: input.sessionId,
          playerId: input.playerId,
          commandId: input.commandId,
          kind: input.kind,
          status: "running",
          baseRevision: sessionRow.revision,
          requestJson: input.request,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [gameCommands.sessionId, gameCommands.commandId],
        })
        .returning({ id: gameCommands.id });

      if (inserted.length === 0) {
        const [existing] = await transaction
          .select()
          .from(gameCommands)
          .where(
            and(
              eq(gameCommands.sessionId, input.sessionId),
              eq(gameCommands.commandId, input.commandId),
            ),
          )
          .limit(1);
        if (!existing) {
          throw new PersistenceError(
            "invalid_transition",
            "idempotency row vanished during command begin",
          );
        }
        if (existing.playerId !== input.playerId) {
          throw new PersistenceError("forbidden", "command belongs to another player");
        }
        return existingCommandResult<T>(existing, sessionRow);
      }

      const [caseRow] = await transaction
        .select({ artifactJson: caseArtifacts.artifactJson })
        .from(caseArtifacts)
        .where(eq(caseArtifacts.id, sessionRow.caseId))
        .limit(1);
      if (!caseRow) {
        throw new PersistenceError(
          "not_found",
          `case "${sessionRow.caseId}" does not exist`,
        );
      }

      return {
        status: "accepted",
        caseArtifact: parseCaseArtifact(caseRow.artifactJson),
        session: parseStoredSession(
          sessionRow.stateJson,
          sessionRow.id,
          sessionRow.caseId,
        ),
        baseRevision: sessionRow.revision,
      };
    });
  }

  async commitGameCommand<T>(input: {
    playerId: string;
    sessionId: string;
    commandId: string;
    baseRevision: number;
    nextSession: GameSession;
    outcome: T;
    now?: string;
  }): Promise<ExecuteGameCommandResult<T>> {
    // CAS 更新 session、追加事件和提交 command 在同一事务中完成，避免部分写入。
    const now = input.now ?? new Date().toISOString();

    return this.database.db.transaction(async (transaction) => {
      const [command] = await transaction
        .select()
        .from(gameCommands)
        .where(
          and(
            eq(gameCommands.sessionId, input.sessionId),
            eq(gameCommands.commandId, input.commandId),
          ),
        )
        .limit(1);
      if (!command) {
        throw new PersistenceError("not_found", "command has not been started");
      }
      if (command.playerId !== input.playerId) {
        throw new PersistenceError("forbidden", "command belongs to another player");
      }
      if (command.status === "committed") {
        const persisted = await loadSessionRow(transaction, input.sessionId);
        return {
          session: parseStoredSession(
            persisted.stateJson,
            persisted.id,
            persisted.caseId,
          ),
          outcome: readStoredOutcome<T>(command.resultJson),
          replayed: true,
        };
      }
      if (command.status === "failed") {
        throw new PersistenceError(
          "command_failed",
          command.error ?? "command previously failed",
        );
      }
      validateNextSession(input, command.baseRevision);

      const updated = await transaction
        .update(gameSessions)
        .set({
          status: input.nextSession.status,
          revision: input.nextSession.revision,
          stateJson: input.nextSession,
          updatedAt: input.nextSession.updatedAt,
          closedAt:
            input.nextSession.status === "closed" ? input.nextSession.updatedAt : null,
        })
        .where(
          and(
            eq(gameSessions.id, input.sessionId),
            eq(gameSessions.playerId, input.playerId),
            eq(gameSessions.revision, input.baseRevision),
          ),
        )
        .returning({ id: gameSessions.id });
      if (updated.length === 0) {
        throw new PersistenceError(
          "revision_conflict",
          `game advanced beyond revision ${input.baseRevision}`,
        );
      }

      const newEvents = input.nextSession.events.filter(
        (event) => event.sequence > input.baseRevision,
      );
      if (newEvents.length !== 1 || newEvents[0]?.commandId !== input.commandId) {
        throw new PersistenceError(
          "invalid_transition",
          "a command must append exactly one matching domain event",
        );
      }
      await transaction
        .insert(gameEvents)
        .values(newEvents.map((event) => eventRow(input.sessionId, event)));
      await transaction
        .update(gameCommands)
        .set({
          status: "committed",
          committedRevision: input.nextSession.revision,
          resultJson: toJsonRecord({ outcome: input.outcome }),
          updatedAt: now,
        })
        .where(eq(gameCommands.id, command.id));

      return { session: input.nextSession, outcome: input.outcome, replayed: false };
    });
  }

  async executeGameCommand<T>(
    input: ExecuteGameCommandInput,
    transition: (
      caseArtifact: CaseArtifact,
      session: GameSession,
    ) => Promise<{ session: GameSession; outcome: T }> | { session: GameSession; outcome: T },
  ): Promise<ExecuteGameCommandResult<T>> {
    const begun = await this.beginGameCommand<T>(input);
    if (begun.status === "committed") {
      return { session: begun.session, outcome: begun.outcome, replayed: true };
    }
    if (begun.status === "running") {
      throw new PersistenceError("command_running", "command is already running");
    }
    if (begun.status === "failed") {
      throw new PersistenceError(
        "command_failed",
        begun.error ?? "command previously failed",
      );
    }

    try {
      // transition 可执行 LLM/守卫等副作用，但此时 command 已经 durable 地处于 running 状态。
      const result = await transition(begun.caseArtifact, begun.session);
      return await this.commitGameCommand({
        playerId: input.playerId,
        sessionId: input.sessionId,
        commandId: input.commandId,
        baseRevision: begun.baseRevision,
        nextSession: result.session,
        outcome: result.outcome,
        now: input.now,
      });
    } catch (error) {
      await this.failGameCommand(
        input.sessionId,
        input.commandId,
        errorMessage(error),
        input.now,
      );
      throw error;
    }
  }

  async failGameCommand(
    sessionId: string,
    commandId: string,
    error: string,
    now = new Date().toISOString(),
  ): Promise<void> {
    await this.database.db
      .update(gameCommands)
      .set({ status: "failed", error, updatedAt: now })
      .where(
        and(
          eq(gameCommands.sessionId, sessionId),
          eq(gameCommands.commandId, commandId),
          eq(gameCommands.status, "running"),
        ),
      );
  }

  async recoverStaleGameCommands(options: {
    olderThanMs?: number;
    now?: string;
  } = {}): Promise<number> {
    // 进程在副作用期间退出时不能伪造结果；过期 command 标为失败，客户端以新 commandId 重试。
    const now = options.now ?? new Date().toISOString();
    const cutoffTime =
      Date.parse(now) - (options.olderThanMs ?? 30 * 60_000);
    const running = await this.database.db
      .select({
        id: gameCommands.id,
        updatedAt: gameCommands.updatedAt,
      })
      .from(gameCommands)
      .where(eq(gameCommands.status, "running"));
    let recovered = 0;
    for (const command of running) {
      if (Date.parse(command.updatedAt) >= cutoffTime) continue;
      const updated = await this.database.db
        .update(gameCommands)
        .set({
          status: "failed",
          error: "command interrupted before commit; retry with a new command id",
          updatedAt: now,
        })
        .where(
          and(
            eq(gameCommands.id, command.id),
            eq(gameCommands.status, "running"),
            eq(gameCommands.updatedAt, command.updatedAt),
          ),
        )
        .returning({ id: gameCommands.id });
      recovered += updated.length;
    }
    return recovered;
  }

  async enqueueJob(input: EnqueueJobInput): Promise<string> {
    if (input.playerId) await this.requirePlayer(input.playerId);
    const id = `job_${randomUUID().replaceAll("-", "")}`;
    const now = input.now ?? new Date().toISOString();
    await this.database.db.insert(jobs).values({
      id,
      playerId: input.playerId,
      type: input.type,
      status: "queued",
      stage: "queued",
      progress: 0,
      payloadJson: input.payload,
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async claimNextJob(now = new Date().toISOString()): Promise<ClaimedJob | null> {
    // 用 queued -> running 的条件更新实现单机 worker 的原子认领。
    return this.database.db.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .orderBy(asc(jobs.createdAt))
        .limit(1);
      if (!candidate) return null;

      const claimed = await transaction
        .update(jobs)
        .set({
          status: "running",
          stage: "starting",
          progress: 5,
          attempts: candidate.attempts + 1,
          startedAt: now,
          updatedAt: now,
        })
        .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")))
        .returning({ id: jobs.id });
      if (claimed.length === 0) return null;

      return {
        id: candidate.id,
        playerId: candidate.playerId,
        type: candidate.type,
        payload: candidate.payloadJson,
        attempts: candidate.attempts + 1,
        maxAttempts: candidate.maxAttempts,
      };
    });
  }

  async recoverStaleJobs(options: {
    olderThanMs?: number;
    now?: string;
  } = {}): Promise<number> {
    // 生成任务的 lease 到期后才入队重试；每次尝试会获得新的 LangGraph thread id。
    const now = options.now ?? new Date().toISOString();
    const cutoff = new Date(
      new Date(now).getTime() - (options.olderThanMs ?? 30 * 60_000),
    ).toISOString();
    const running = await this.database.db
      .select({
        id: jobs.id,
        attempts: jobs.attempts,
        maxAttempts: jobs.maxAttempts,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(eq(jobs.status, "running"));
    const cutoffTime = Date.parse(cutoff);
    const stale = running.filter((job) => Date.parse(job.updatedAt) < cutoffTime);
    let recovered = 0;
    for (const job of stale) {
      const exhausted = job.attempts >= job.maxAttempts;
      const updated = await this.database.db
        .update(jobs)
        .set({
          status: exhausted ? "failed" : "queued",
          stage: exhausted ? "failed" : "queued",
          progress: 0,
          error: exhausted
            ? "worker lease expired after the final attempt"
            : "worker lease expired; queued for retry",
          startedAt: null,
          finishedAt: exhausted ? now : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, "running"),
            eq(jobs.updatedAt, job.updatedAt),
          ),
        )
        .returning({ id: jobs.id });
      recovered += updated.length;
    }
    return recovered;
  }

  async getJob(playerId: string, jobId: string): Promise<JobView> {
    const [job] = await this.database.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    if (!job) throw new PersistenceError("not_found", `job "${jobId}" does not exist`);
    if (job.playerId !== playerId) {
      throw new PersistenceError("forbidden", "job belongs to another player");
    }
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      result: job.resultJson,
      error: job.error,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  async completeJob(
    jobId: string,
    result: Record<string, unknown>,
    now = new Date().toISOString(),
  ): Promise<void> {
    await this.database.db
      .update(jobs)
      .set({
        status: "succeeded",
        stage: "succeeded",
        progress: 100,
        resultJson: result,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")));
  }

  async failJob(
    jobId: string,
    error: string,
    options: { retryable?: boolean; now?: string } = {},
  ): Promise<void> {
    const now = options.now ?? new Date().toISOString();
    const [job] = await this.database.db
      .select({ attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    if (!job) throw new PersistenceError("not_found", `job "${jobId}" does not exist`);
    const shouldRetry = Boolean(options.retryable) && job.attempts < job.maxAttempts;
    await this.database.db
      .update(jobs)
      .set({
        status: shouldRetry ? "queued" : "failed",
        stage: shouldRetry ? "queued" : "failed",
        ...(shouldRetry ? { progress: 0 } : {}),
        error,
        startedAt: shouldRetry ? null : undefined,
        finishedAt: shouldRetry ? null : now,
        updatedAt: now,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")));
  }

  async updateJobProgress(input: {
    jobId: string;
    stage: Exclude<JobStage, "succeeded" | "failed" | "cancelled">;
    progress: number;
    now?: string;
  }): Promise<boolean> {
    // 进度只用于让轮询 UI 知道 worker 仍在推进；终态仍由 completeJob/failJob 决定。
    const progress = Number.isFinite(input.progress)
      ? Math.min(99, Math.max(0, Math.trunc(input.progress)))
      : 0;
    const updated = await this.database.db
      .update(jobs)
      .set({
        stage: input.stage,
        progress,
        updatedAt: input.now ?? new Date().toISOString(),
      })
      .where(and(eq(jobs.id, input.jobId), eq(jobs.status, "running")))
      .returning({ id: jobs.id });
    return updated.length === 1;
  }

  async heartbeatJob(
    jobId: string,
    now = new Date().toISOString(),
  ): Promise<boolean> {
    // LLM 请求可能持续数十秒；独立心跳避免健康 worker 被误判为 stale job。
    const updated = await this.database.db
      .update(jobs)
      .set({ updatedAt: now })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
      .returning({ id: jobs.id });
    return updated.length === 1;
  }

  async startModelRun(input: StartModelRunInput): Promise<string> {
    // 审计记录保存请求摘要、模型与 token 成本；不要在此处写入 API key。
    const id = `modelrun_${randomUUID().replaceAll("-", "")}`;
    await this.database.db.insert(modelRuns).values({
      id,
      sessionId: input.sessionId,
      caseId: input.caseId,
      commandId: input.commandId,
      graphName: input.graphName,
      nodeName: input.nodeName,
      provider: input.provider,
      model: input.model,
      promptHash: input.promptHash,
      status: "running",
      requestJson: input.request,
      createdAt: input.now ?? new Date().toISOString(),
    });
    return id;
  }

  async finishModelRun(input: {
    id: string;
    response: Record<string, unknown>;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostMicrosCny?: number;
    now?: string;
  }): Promise<void> {
    await this.database.db
      .update(modelRuns)
      .set({
        status: "succeeded",
        responseJson: input.response,
        inputTokens: input.inputTokens ?? 0,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        estimatedCostMicrosCny: input.estimatedCostMicrosCny ?? 0,
        finishedAt: input.now ?? new Date().toISOString(),
      })
      .where(and(eq(modelRuns.id, input.id), eq(modelRuns.status, "running")));
  }

  async getGodModeSnapshot(playerId: string, sessionId: string) {
    // 先按玩家归属加载 session；模型调用只限本局或该案件的无 session 生成记录，不能横向泄露其他玩家。
    const game = await this.loadGame(playerId, sessionId);
    const [caseRow] = await this.database.db
      .select({ generationMetadataJson: caseArtifacts.generationMetadataJson })
      .from(caseArtifacts)
      .where(eq(caseArtifacts.id, game.caseArtifact.id))
      .limit(1);
    const commands = await this.database.db
      .select()
      .from(gameCommands)
      .where(eq(gameCommands.sessionId, sessionId))
      .orderBy(asc(gameCommands.createdAt));
    const events = await this.database.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.sessionId, sessionId))
      .orderBy(asc(gameEvents.sequence));
    const calls = await this.database.db
      .select()
      .from(modelRuns)
      .where(
        or(
          eq(modelRuns.sessionId, sessionId),
          and(
            eq(modelRuns.caseId, game.caseArtifact.id),
            isNull(modelRuns.sessionId),
          ),
        ),
      )
      .orderBy(asc(modelRuns.createdAt));

    return {
      truthLedger: game.caseArtifact,
      privateRuntimeState: game.session,
      generationMetadata: caseRow?.generationMetadataJson ?? {},
      commands,
      events,
      modelRuns: calls,
    };
  }

  private async requirePlayer(playerId: string): Promise<void> {
    const [player] = await this.database.db
      .select({ id: anonymousPlayers.id })
      .from(anonymousPlayers)
      .where(eq(anonymousPlayers.id, playerId))
      .limit(1);
    if (!player) {
      throw new PersistenceError("not_found", `player "${playerId}" does not exist`);
    }
  }
}

type Transaction = Parameters<
  Parameters<DatabaseHandle["db"]["transaction"]>[0]
>[0];

async function loadSessionRow(transaction: Transaction, sessionId: string) {
  const [row] = await transaction
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.id, sessionId))
    .limit(1);
  if (!row) {
    throw new PersistenceError("not_found", `game "${sessionId}" does not exist`);
  }
  return row;
}

function eventRow(sessionId: string, event: GameEvent) {
  return {
    sessionId,
    sequence: event.sequence,
    commandId: event.commandId,
    type: event.type,
    summary: event.summary,
    payloadJson: toJsonRecord(event.data),
    occurredAt: event.at,
  };
}

function validateNextSession(
  input: {
    sessionId: string;
    commandId: string;
    baseRevision: number;
    nextSession: GameSession;
  },
  storedBaseRevision: number,
) {
  if (
    storedBaseRevision !== input.baseRevision ||
    input.nextSession.id !== input.sessionId ||
    input.nextSession.revision !== input.baseRevision + 1 ||
    !input.nextSession.processedCommandIds.includes(input.commandId)
  ) {
    throw new PersistenceError(
      "invalid_transition",
      "next session does not match the accepted command and base revision",
    );
  }
}

function parseStoredSession(
  value: unknown,
  expectedId: string,
  expectedCaseId: string,
): GameSession {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    value.id !== expectedId ||
    !("caseId" in value) ||
    value.caseId !== expectedCaseId
  ) {
    throw new PersistenceError("invalid_transition", "stored game state is corrupt");
  }
  return value as GameSession;
}

function readStoredOutcome<T>(value: Record<string, unknown> | null): T {
  if (!value || !("outcome" in value)) {
    throw new PersistenceError(
      "invalid_transition",
      "committed command has no stored outcome",
    );
  }
  return value.outcome as T;
}

function existingCommandResult<T>(
  command: typeof gameCommands.$inferSelect,
  session: typeof gameSessions.$inferSelect,
): Exclude<BeginGameCommandResult<T>, { status: "accepted" }> {
  if (command.status === "committed") {
    return {
      status: "committed",
      session: parseStoredSession(session.stateJson, session.id, session.caseId),
      outcome: readStoredOutcome<T>(command.resultJson),
      committedRevision: command.committedRevision ?? command.baseRevision,
    };
  }
  return { status: command.status, error: command.error ?? undefined };
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  const serialized = JSON.parse(JSON.stringify(value)) as unknown;
  if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) {
    throw new PersistenceError("invalid_transition", "value is not a JSON object");
  }
  return serialized as Record<string, unknown>;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
