import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DialogueService } from "@/application/dialogue/dialogue-service";
import { GameService } from "@/application/game/game-service";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import type { CaseArtifact } from "@/domain/case/case-artifact";
import { startGame, type GameSession } from "@/domain/game/game-runtime";
import { createDatabase, type DatabaseHandle } from "@/infrastructure/db/database";
import { gameSessions } from "@/infrastructure/db/schema";
import { GameRepository } from "@/infrastructure/persistence/game-repository";

import { POST as createGame } from "../../app/api/games/route";
import { GET as getGame } from "../../app/api/games/[sessionId]/route";
import { POST as action } from "../../app/api/games/[sessionId]/actions/route";
import { POST as dialogue } from "../../app/api/games/[sessionId]/dialogue/route";
import { GET as review } from "../../app/api/games/[sessionId]/review/route";
import { createPlayerProtocol } from "./player-protocol";

const boundary = vi.hoisted(() => ({ playerId: "", services: undefined as unknown }));
vi.mock("@/server/access", () => ({ requireAccess: async () => undefined }));
vi.mock("@/server/player-session", () => ({ requireAnonymousPlayer: async () => boundary.playerId }));
vi.mock("@/server/rate-limit", () => ({ enforceRateLimit: () => undefined }));
vi.mock("@/server/services", () => ({ getServerServices: async () => boundary.services }));

describe("player HTTP protocol with existing raw-ID saves", () => {
  let directory: string;
  let database: DatabaseHandle;
  let repository: GameRepository;
  let game: GameService;
  let artifact: CaseArtifact;
  let session: GameSession;
  let protocolKey: string;
  const context = () => ({ params: Promise.resolve({ sessionId: session.id }) });
  const request = (body: unknown) => new NextRequest("http://localhost/api/games/test/actions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const protocol = () => createPlayerProtocol(artifact, session, protocolKey);
  const alias = (id: string) => protocol().encode({ id }).id;
  const expectNoAuthorIds = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const entity of [...artifact.characters, ...artifact.evidence, ...artifact.facts, ...artifact.scenes,
      ...artifact.scenes.flatMap((scene) => scene.objects), ...artifact.timeline, ...artifact.claims,
      ...artifact.unlockRules, ...artifact.hintChains]) expect(text).not.toContain(entity.id);
  };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "final-alibi-player-protocol-"));
    database = await createDatabase({ url: `file:${path.join(directory, "test.sqlite")}` });
    repository = new GameRepository(database);
    protocolKey = await repository.getPlayerProtocolKey();
    boundary.playerId = (await repository.createAnonymousIdentity()).playerId;
    artifact = JSON.parse(JSON.stringify(tutorialCase)
      .replaceAll(tutorialCase.id, "case_player_protocol")
      .replaceAll(tutorialCase.culpritId, "character_culprit")
      .replaceAll("evidence_housekeeper_testimony", "evidence_culprit_testimony")) as CaseArtifact;
    ({ session } = await repository.createGame(boundary.playerId, artifact, { sessionId: "game_legacy_protocol", source: "tutorial" }));
    game = new GameService(repository);
    boundary.services = {
      repository, game,
      dialogue: new DialogueService(repository, { async invokeStructured() { throw new Error("HTTP protocol tests do not call paid models"); } }),
    };
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function prepareLegacyDossier() {
    session = {
      ...session,
      unlockedCharacterIds: artifact.characters.filter((character) => character.roleTier !== "victim").map((character) => character.id),
      unlockedSceneIds: artifact.scenes.map((scene) => scene.id),
      discoveredEvidenceIds: artifact.evidence.map((evidence) => evidence.id),
      discoveredClaimIds: artifact.claims.map((claim) => claim.id),
    };
    // 直接装入旧格式 JSON 作为兼容性夹具，生产迁移和真实用户数据库均不参与。
    await database.db.update(gameSessions).set({ stateJson: session }).where(eq(gameSessions.id, session.id));
  }

  it("encodes both create and GET responses while retaining the original stored artifact", async () => {
    const first = await getGame(new Request("http://localhost"), context());
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expectNoAuthorIds(firstBody);
    expect(firstBody.view.session.id).toBe(session.id);
    expect(firstBody.view.characters.find((person: { name: string }) => person.name === artifact.characters.find((person) => person.id === artifact.culpritId)!.name).id).toBe(alias(artifact.culpritId));
    const created = await createGame(request({ caseId: artifact.id }));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expectNoAuthorIds(createdBody);
    expect(createdBody.view.characters.map((person: { id: string }) => person.id)).toEqual(firstBody.view.characters.map((person: { id: string }) => person.id));
    const stored = await repository.loadGame(boundary.playerId, session.id);
    expect(stored.caseArtifact.culpritId).toBe("character_culprit");
    expect(stored.session.revision).toBe(0);
  });

  it("returns the same non-disclosing 400 for raw IDs, unknown aliases and aliases from another case", async () => {
    const other = { ...artifact, id: "case_other_protocol", seed: "another_seed" };
    const otherAlias = createPlayerProtocol(other, startGame(other), protocolKey).encode({ id: artifact.culpritId }).id;
    const bodies = [];
    for (const characterId of [artifact.culpritId, "person_unknown", otherAlias]) {
      const response = await dialogue(request({ commandId: "invalid_reference", expectedRevision: 0, characterId, text: "你好。" }), context());
      expect(response.status).toBe(400);
      bodies.push(await response.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0]).toEqual({ error: { code: "invalid_player_reference", message: "引用的选项已失效，请刷新案卷后重试。" } });
    const hidden = artifact.evidence.find((evidence) => !session.discoveredEvidenceIds.includes(evidence.id))!;
    const response = await action(request({ type: "present_evidence", commandId: "hidden_reference", expectedRevision: 0, characterId: alias(artifact.culpritId), evidenceId: alias(hidden.id) }), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(bodies[0]);
    expect((await repository.loadGame(boundary.playerId, session.id)).session.revision).toBe(0);
  });

  it("replays an old raw-ID command through the same encoded outcome and view", async () => {
    const scene = artifact.scenes.find((item) => item.initiallyUnlocked)!;
    const object = scene.objects.find((item) => item.evidenceIds.length > 0)!;
    const original = { playerId: boundary.playerId, sessionId: session.id, commandId: "legacy_investigation", expectedRevision: 0,
      sceneId: scene.id, objectId: object.id, text: `${object.actionAliases[0]!}；核实（${artifact.culpritId}）。` };
    const before = await game.investigate(original);
    expect(before.outcome.discoveredEvidenceIds.length).toBeGreaterThan(0);
    const response = await action(request({ type: "investigate", commandId: original.commandId, expectedRevision: 0,
      sceneId: alias(scene.id), objectId: alias(object.id), text: protocol().encode({ text: original.text }).text }), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.replayed).toBe(true);
    expect(body.outcome).toEqual(protocol().encode(before.outcome));
    expect(body.view.session.revision).toBe(before.view.session.revision);
    expectNoAuthorIds(body);
    const stored = await repository.loadGame(boundary.playerId, session.id);
    expect(stored.session.discoveredEvidenceIds).toEqual(before.outcome.discoveredEvidenceIds);
  });

  it("encodes dialogue testimony and evidence presentation in every response branch", async () => {
    const testimony = artifact.evidence.find((evidence) => evidence.id === "evidence_culprit_testimony")!;
    const characterId = testimony.discovery.characterId!;
    const talked = await dialogue(request({ commandId: "dialogue_protocol", expectedRevision: 0, characterId: alias(characterId),
      text: testimony.discovery.dialogueAliases![0]! }), context());
    expect(talked.status).toBe(200);
    const body = await talked.json();
    expect(body.outcome.discoveredEvidenceIds).toContain(alias(testimony.id));
    expectNoAuthorIds(body);
    session = (await repository.loadGame(boundary.playerId, session.id)).session;
    const presented = await action(request({ type: "present_evidence", commandId: "present_protocol", expectedRevision: session.revision,
      characterId: alias(artifact.culpritId), evidenceId: alias(testimony.id) }), context());
    expect(presented.status).toBe(200);
    expectNoAuthorIds(await presented.json());
    session = (await repository.loadGame(boundary.playerId, session.id)).session;
    expect(session.presentedEvidenceByCharacter[artifact.culpritId]).toContain(testimony.id);
    const hint = await action(request({ type: "hint", commandId: "hint_protocol", expectedRevision: session.revision }), context());
    expect(hint.status).toBe(200);
    expectNoAuthorIds(await hint.json());
  });

  it.each(["submit_report", "resolve_confrontation"])("continues a legacy save and encodes closure, review and replay: %s", async (type) => {
    await prepareLegacyDossier();
    if (type === "resolve_confrontation") {
      await game.startConfrontation({ playerId: boundary.playerId, sessionId: session.id, commandId: "legacy_confrontation", expectedRevision: 0, suspectId: artifact.culpritId });
      session = (await repository.loadGame(boundary.playerId, session.id)).session;
      const restored = await getGame(new Request("http://localhost"), context());
      expect((await restored.json()).view.session.confrontation.suspectId).toBe(alias(artifact.culpritId));
      const replayed = await action(request({ type: "start_confrontation", commandId: "legacy_confrontation", expectedRevision: 0, suspectId: alias(artifact.culpritId) }), context());
      expect(replayed.status).toBe(200);
      const replayedBody = await replayed.json();
      expect(replayedBody.replayed).toBe(true);
      expect(replayedBody.outcome.confrontation.suspectId).toBe(alias(artifact.culpritId));
      expectNoAuthorIds(replayedBody);
    }
    const command = { type, commandId: "close_protocol", expectedRevision: session.revision,
      culpritId: alias(artifact.solution.culpritId), motiveFactId: alias(artifact.solution.motiveFactId), methodFactId: alias(artifact.solution.methodFactId),
      evidenceIds: artifact.evidence.map((evidence) => alias(evidence.id)), timelineEventIds: artifact.timeline.map((event) => alias(event.id)),
      reasoning: `证据已经形成完整链条，结合${alias(artifact.culpritId)}与【${alias(artifact.evidence[0]!.id)}】逐项核实动机、手法和时间线。` };
    const response = await action(request(command), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.view.session.status).toBe("closed");
    expect(body.review.culprit.id).toBe(alias(artifact.culpritId));
    expectNoAuthorIds(body);
    const replayed = await action(request(command), context());
    expect(replayed.status).toBe(200);
    const replayedBody = await replayed.json();
    expect(replayedBody.replayed).toBe(true);
    expect(replayedBody.outcome).toEqual(body.outcome);
    const reviewResponse = await review(new Request("http://localhost"), context());
    expect(reviewResponse.status).toBe(200);
    expect(await reviewResponse.json()).toEqual({ review: body.review });
    const stored = await repository.loadGame(boundary.playerId, session.id);
    expect(stored.caseArtifact.culpritId).toBe("character_culprit");
    expect(stored.session.report?.submitted.culpritId).toBe(artifact.culpritId);
    expect(stored.session.report?.submitted.reasoning).toContain(artifact.culpritId);
    expect(stored.session.processedCommandIds).toContain("close_protocol");
  });
});
