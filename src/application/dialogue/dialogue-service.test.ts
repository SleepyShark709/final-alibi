import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemorySaver } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  StructuredModelProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { startGame } from "@/domain/game/game-runtime";
import {
  createDatabase,
  type DatabaseHandle,
} from "@/infrastructure/db/database";
import { modelRuns } from "@/infrastructure/db/schema";
import { GameRepository } from "@/infrastructure/persistence/game-repository";

import {
  buildDeterministicDialogueFallback,
  DialogueService,
} from "./dialogue-service";

describe("DialogueService", () => {
  let directory: string;
  let database: DatabaseHandle;
  let repository: GameRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "spy-game-dialogue-service-"));
    database = await createDatabase({
      url: `file:${path.join(directory, "test.sqlite")}`,
    });
    repository = new GameRepository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("persists a guarded reply, its domain event, and raw model telemetry once", async () => {
    const identity = await repository.createAnonymousIdentity();
    const { session } = await repository.createGame(identity.playerId, tutorialCase, {
      sessionId: "game_dialogue_service",
      source: "tutorial",
    });
    const provider = new ScriptedProvider([
      {
        utterance: "李闻舟接过茶盘，说由他送去书房。",
        demeanor: "cooperative",
        disclosedClaimIds: ["claim_luo_tea"],
        memorySummary: "我已经说明李闻舟拿走茶盘。",
        stateDelta: { trust: 3, pressure: 1, alertness: 0 },
      },
      { safe: true, violationCodes: [], feedback: "" },
    ]);
    const service = new DialogueService(repository, provider, new MemorySaver());
    const input = {
      playerId: identity.playerId,
      sessionId: session.id,
      commandId: "command_talk_luo",
      expectedRevision: 0,
      characterId: "character_luo_fang",
      text: "谁把茶送进书房？",
      now: "2026-08-31T10:05:00+08:00",
    };

    const first = await service.talk(input);
    const replay = await service.talk(input);
    const storedRuns = await database.db.select().from(modelRuns);

    expect({
      status: first.outcome.status,
      revision: first.session.revision,
      evidence: first.outcome.discoveredEvidenceIds,
      replayed: replay.replayed,
      providerCalls: provider.callCount,
      modelRuns: storedRuns.map((run) => ({
        node: run.nodeName,
        status: run.status,
      })),
    }).toEqual({
      status: "responded",
      revision: 1,
      evidence: ["evidence_housekeeper_testimony"],
      replayed: true,
      providerCalls: 2,
      modelRuns: [
        { node: "character_response", status: "succeeded" },
        { node: "dialogue_guard", status: "succeeded" },
      ],
    });
  });

  it("keeps an interview playable with a grounded fallback when the model is unavailable", async () => {
    const identity = await repository.createAnonymousIdentity();
    const { session } = await repository.createGame(identity.playerId, tutorialCase, {
      sessionId: "game_dialogue_fallback",
      source: "tutorial",
    });
    const service = new DialogueService(
      repository,
      new ScriptedProvider([]),
      new MemorySaver(),
    );

    const result = await service.talk({
      playerId: identity.playerId,
      sessionId: session.id,
      commandId: "command_fallback_luo",
      expectedRevision: 0,
      characterId: "character_luo_fang",
      text: "询问罗芳谁送了茶",
    });

    expect(result.outcome.status).toBe("responded");
    expect(result.outcome.discoveredEvidenceIds).toEqual([
      "evidence_housekeeper_testimony",
    ]);
    expect(result.outcome.response?.utterance).toContain("李闻舟");
  });

  it("does not reveal fallback testimony before its prerequisite evidence is found", () => {
    const gatedCase = structuredClone(tutorialCase);
    const testimony = gatedCase.evidence.find(
      (evidence) => evidence.id === "evidence_housekeeper_testimony",
    );
    if (!testimony) throw new Error("tutorial testimony is missing");
    testimony.discovery.prerequisiteEvidenceIds = ["evidence_torn_audit_memo"];
    const session = startGame(gatedCase, { sessionId: "game_locked_testimony" });

    const response = buildDeterministicDialogueFallback(
      gatedCase,
      session,
      "character_luo_fang",
      "询问罗芳谁送了茶",
    );

    expect(response.disclosedClaimIds).toEqual([]);
    expect(response.utterance).not.toContain("李闻舟");
    expect(response.utterance).not.toBe(testimony.description);
  });
});

class ScriptedProvider implements StructuredModelProvider {
  callCount = 0;

  constructor(private readonly responses: unknown[]) {}

  async invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    this.callCount += 1;
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted response remains");
    return {
      value: request.schema.parse(response),
      model: "mock-deepseek",
      usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 30 },
      rawResponse: { responseNumber: this.callCount },
    };
  }
}
