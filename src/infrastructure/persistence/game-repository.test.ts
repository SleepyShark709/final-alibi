import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GameService } from "@/application/game/game-service";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { parseCaseArtifact } from "@/domain/case/case-artifact";
import { performInvestigation } from "@/domain/game/game-runtime";
import {
  createDatabase,
  type DatabaseHandle,
} from "@/infrastructure/db/database";
import {
  gameCommands,
  gameEvents,
  jobs,
  modelRuns,
} from "@/infrastructure/db/schema";

import { GameRepository } from "./game-repository";

describe("GameRepository", () => {
  let database: DatabaseHandle;
  let repository: GameRepository;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "spy-game-db-test-"));
    database = await createDatabase({
      url: `file:${path.join(testDirectory, "test.sqlite")}`,
    });
    repository = new GameRepository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("creates a revocable anonymous identity without storing the bearer token", async () => {
    const identity = await repository.createAnonymousIdentity(
      "2026-08-31T10:00:00+08:00",
    );

    await expect(
      repository.authenticateAnonymousPlayer(
        identity.accessToken,
        "2026-08-31T10:01:00+08:00",
      ),
    ).resolves.toBe(identity.playerId);
    await expect(repository.authenticateAnonymousPlayer("wrong-token")).resolves.toBeNull();

    const stored = await database.client.execute(
      "select access_token_hash from anonymous_players",
    );
    expect(stored.rows[0]?.access_token_hash).not.toBe(identity.accessToken);
  });

  it("persists a frozen case and isolates games by anonymous player", async () => {
    const owner = await repository.createAnonymousIdentity();
    const stranger = await repository.createAnonymousIdentity();
    const created = await repository.createGame(owner.playerId, tutorialCase, {
      sessionId: "game_persistence_test",
      source: "tutorial",
      now: "2026-08-31T10:00:00+08:00",
    });
    const loaded = await repository.loadGame(owner.playerId, created.session.id);

    expect({
      caseId: loaded.caseArtifact.id,
      title: loaded.caseArtifact.title,
      session: loaded.session,
    }).toEqual({
      caseId: tutorialCase.id,
      title: "雨夜书房",
      session: created.session,
    });
    await expect(
      repository.loadGame(stranger.playerId, created.session.id),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("commits a command and its event atomically, then replays its cached outcome", async () => {
    const identity = await repository.createAnonymousIdentity();
    const { session } = await repository.createGame(identity.playerId, tutorialCase, {
      sessionId: "game_atomic_test",
      source: "tutorial",
      now: "2026-08-31T10:00:00+08:00",
    });
    const request = {
      commandId: "command_find_memo",
      text: "检查碎纸篓",
      sceneId: "scene_study",
      now: "2026-08-31T10:01:00+08:00",
    };
    const execute = () =>
      repository.executeGameCommand(
        {
          playerId: identity.playerId,
          sessionId: session.id,
          commandId: request.commandId,
          kind: "investigate",
          request,
          expectedRevision: 0,
          now: request.now,
        },
        (caseArtifact, currentSession) =>
          performInvestigation(caseArtifact, currentSession, request),
      );

    const first = await execute();
    const replay = await execute();
    const rows = await database.db.select().from(gameEvents);

    expect({
      firstStatus: first.outcome.status,
      firstRevision: first.session.revision,
      firstReplayed: first.replayed,
      replayStatus: replay.outcome.status,
      replayRevision: replay.session.revision,
      replayed: replay.replayed,
      eventSequences: rows.map((event) => event.sequence),
    }).toEqual({
      firstStatus: "discovered",
      firstRevision: 1,
      firstReplayed: false,
      replayStatus: "discovered",
      replayRevision: 1,
      replayed: true,
      eventSequences: [0, 1],
    });
  });

  it("rejects stale revisions before accepting work", async () => {
    const identity = await repository.createAnonymousIdentity();
    const { session } = await repository.createGame(identity.playerId, tutorialCase, {
      sessionId: "game_revision_test",
      source: "tutorial",
    });
    await repository.executeGameCommand(
      {
        playerId: identity.playerId,
        sessionId: session.id,
        commandId: "command_first",
        kind: "investigate",
        request: { text: "检查碎纸篓" },
        expectedRevision: 0,
      },
      (caseArtifact, currentSession) =>
        performInvestigation(caseArtifact, currentSession, {
          commandId: "command_first",
          text: "检查碎纸篓",
          sceneId: "scene_study",
        }),
    );

    await expect(
      repository.beginGameCommand({
        playerId: identity.playerId,
        sessionId: session.id,
        commandId: "command_stale",
        kind: "hint",
        request: {},
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("never overwrites an existing case truth ledger", async () => {
    await repository.registerCase(tutorialCase, "tutorial");
    const conflicting = parseCaseArtifact({
      ...tutorialCase,
      title: "被篡改的标题",
    });

    await expect(repository.registerCase(conflicting, "imported")).rejects.toMatchObject({
      code: "case_id_conflict",
    });
  });

  it("publishes the current tutorial release beside a legacy tutorial ledger", async () => {
    const legacyTutorial = parseCaseArtifact({
      ...tutorialCase,
      id: "case_rainy_study",
      title: "雨夜书房（旧版）",
    });
    await repository.registerCase(legacyTutorial, "tutorial");

    await expect(new GameService(repository).initializeContent()).resolves.toBeUndefined();

    const cases = await repository.listReadyCases();
    expect(cases.map((caseItem) => caseItem.id).sort()).toEqual([
      "case_rainy_study",
      "case_rainy_study_v2",
    ]);
  });

  it("queues durable work and records model telemetry", async () => {
    const identity = await repository.createAnonymousIdentity();
    const jobId = await repository.enqueueJob({
      playerId: identity.playerId,
      type: "generate_case",
      payload: { seed: "seed_01" },
      now: "2026-08-31T10:00:00+08:00",
    });
    const claimed = await repository.claimNextJob("2026-08-31T10:01:00+08:00");
    await repository.completeJob(
      jobId,
      { caseId: tutorialCase.id },
      "2026-08-31T10:02:00+08:00",
    );
    const modelRunId = await repository.startModelRun({
      graphName: "case_generation",
      nodeName: "draft",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      promptHash: "prompt_hash",
      request: { seed: "seed_01" },
      now: "2026-08-31T10:00:00+08:00",
    });
    await repository.finishModelRun({
      id: modelRunId,
      response: { ok: true },
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 40,
      estimatedCostMicrosCny: 900,
      now: "2026-08-31T10:00:01+08:00",
    });

    const [storedJob] = await database.db.select().from(jobs);
    const [storedRun] = await database.db.select().from(modelRuns);
    expect({
      claimed,
      jobStatus: storedJob?.status,
      modelStatus: storedRun?.status,
      modelCost: storedRun?.estimatedCostMicrosCny,
    }).toEqual({
      claimed: {
        id: jobId,
        playerId: identity.playerId,
        type: "generate_case",
        payload: { seed: "seed_01" },
        attempts: 1,
        maxAttempts: 3,
      },
      jobStatus: "succeeded",
      modelStatus: "succeeded",
      modelCost: 900,
    });
  });

  it("persists generation stage, percentage, and worker heartbeat for the polling UI", async () => {
    const identity = await repository.createAnonymousIdentity();
    const jobId = await repository.enqueueJob({
      playerId: identity.playerId,
      type: "generate_case",
      payload: { seed: "progress-seed" },
      now: "2026-08-31T10:00:00.000Z",
    });

    const queued = await repository.getJob(identity.playerId, jobId);
    await repository.claimNextJob("2026-08-31T10:01:00.000Z");
    await repository.updateJobProgress({
      jobId,
      stage: "drafting",
      progress: 18,
      now: "2026-08-31T10:01:10.000Z",
    });
    await repository.heartbeatJob(jobId, "2026-08-31T10:01:20.000Z");
    const running = await repository.getJob(identity.playerId, jobId);

    expect({
      queued: { stage: queued.stage, progress: queued.progress },
      running: {
        status: running.status,
        stage: running.stage,
        progress: running.progress,
        updatedAt: running.updatedAt,
      },
    }).toEqual({
      queued: { stage: "queued", progress: 0 },
      running: {
        status: "running",
        stage: "drafting",
        progress: 18,
        updatedAt: "2026-08-31T10:01:20.000Z",
      },
    });
  });

  it("recovers a generation job left running by a crashed worker", async () => {
    const identity = await repository.createAnonymousIdentity();
    const jobId = await repository.enqueueJob({
      playerId: identity.playerId,
      type: "generate_case",
      payload: { seed: "stale-seed" },
      now: "2026-08-31T00:00:00.000Z",
    });
    await repository.claimNextJob("2026-08-31T00:01:00.000Z");

    const recovered = await repository.recoverStaleJobs({
      olderThanMs: 30 * 60_000,
      now: "2026-08-31T01:00:00.000Z",
    });
    const job = await repository.getJob(identity.playerId, jobId);

    expect({ recovered, status: job.status, attempts: job.attempts }).toEqual({
      recovered: 1,
      status: "queued",
      attempts: 1,
    });
  });

  it("marks a stale running game command as interrupted on startup recovery", async () => {
    const identity = await repository.createAnonymousIdentity();
    const { session } = await repository.createGame(identity.playerId, tutorialCase, {
      sessionId: "game_stale_command",
      source: "tutorial",
    });
    await repository.beginGameCommand({
      playerId: identity.playerId,
      sessionId: session.id,
      commandId: "command_interrupted",
      kind: "dialogue",
      request: { text: "在崩溃前发出的询问" },
      expectedRevision: 0,
      now: "2026-08-31T00:00:00.000Z",
    });

    const recovered = await repository.recoverStaleGameCommands({
      olderThanMs: 30 * 60_000,
      now: "2026-08-31T01:00:00.000Z",
    });
    const [command] = await database.db.select().from(gameCommands);

    expect({ recovered, status: command?.status, error: command?.error }).toEqual({
      recovered: 1,
      status: "failed",
      error: "command interrupted before commit; retry with a new command id",
    });
  });

  it("keeps another player's dialogue audit out of the same-case God snapshot", async () => {
    const owner = await repository.createAnonymousIdentity();
    const stranger = await repository.createAnonymousIdentity();
    const ownerGame = await repository.createGame(owner.playerId, tutorialCase, {
      sessionId: "game_god_owner",
      source: "tutorial",
    });
    const strangerGame = await repository.createGame(stranger.playerId, tutorialCase, {
      sessionId: "game_god_stranger",
      source: "tutorial",
    });
    await repository.startModelRun({
      sessionId: ownerGame.session.id,
      caseId: tutorialCase.id,
      graphName: "character_dialogue",
      nodeName: "owner_call",
      provider: "deepseek",
      model: "mock",
      promptHash: "owner_hash",
      request: {},
    });
    await repository.startModelRun({
      sessionId: strangerGame.session.id,
      caseId: tutorialCase.id,
      graphName: "character_dialogue",
      nodeName: "stranger_call",
      provider: "deepseek",
      model: "mock",
      promptHash: "stranger_hash",
      request: {},
    });
    await repository.startModelRun({
      caseId: tutorialCase.id,
      graphName: "case_generation",
      nodeName: "generation_call",
      provider: "deepseek",
      model: "mock",
      promptHash: "generation_hash",
      request: {},
    });

    const snapshot = await repository.getGodModeSnapshot(
      owner.playerId,
      ownerGame.session.id,
    );

    expect(snapshot.modelRuns.map((run) => run.nodeName).sort()).toEqual([
      "generation_call",
      "owner_call",
    ]);
  });
});
