import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DialogueService } from "@/application/dialogue/dialogue-service";
import { GameService } from "@/application/game/game-service";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { parseCaseArtifact } from "@/domain/case/case-artifact";
import { getPlayerCaseView, startGame } from "@/domain/game/game-runtime";
import { createDatabase, type DatabaseHandle } from "@/infrastructure/db/database";
import { GameRepository } from "@/infrastructure/persistence/game-repository";

import { POST as action } from "../../app/api/games/[sessionId]/actions/route";
import { POST as dialogue } from "../../app/api/games/[sessionId]/dialogue/route";
import { GET as getGame } from "../../app/api/games/[sessionId]/route";
import { createPlayerProtocol } from "./player-protocol";

const boundary = vi.hoisted(() => ({ playerId: "", services: undefined as unknown }));
vi.mock("@/server/access", () => ({ requireAccess: async () => undefined }));
vi.mock("@/server/player-session", () => ({ requireAnonymousPlayer: async () => boundary.playerId }));
vi.mock("@/server/rate-limit", () => ({ enforceRateLimit: () => undefined }));
vi.mock("@/server/services", () => ({ getServerServices: async () => boundary.services }));

function caseWithAnswerId() {
  return parseCaseArtifact(JSON.parse(JSON.stringify(tutorialCase).replaceAll(tutorialCase.culpritId, "character_culprit")));
}

function errorSignature(run: () => unknown) {
  try { run(); return null; } catch (error) {
    const value = error as { status: number; code: string; message: string };
    return { status: value.status, code: value.code, message: value.message };
  }
}

const invalidReference = { status: 400, code: "invalid_player_reference", message: "引用的选项已失效，请刷新案卷后重试。" };
const protocolKey = "independent-player-protocol-test-secret-2026";

describe("independent player protocol challenge", () => {
  it("does not let a player derive the culprit alias from the generation seed and public case ID", () => {
    const playerKnownSeed = "player_selected_seed_2026";
    const artifact = { ...caseWithAnswerId(), seed: playerKnownSeed };
    const session = startGame(artifact);
    const publicView = createPlayerProtocol(artifact, session, protocolKey).encode(getPlayerCaseView(artifact, session));
    // 攻击者只用创建任务返回的seed、公开case ID和作者常用命名猜词，不读取隐藏案卷。
    const guessedAlias = `person_${createHash("sha256")
      .update(JSON.stringify(["player-protocol-v1", publicView.case.id, playerKnownSeed, "character", "character_culprit"]))
      .digest("hex").slice(0, 20)}`;
    expect(publicView.reportOptions.suspects.map((person) => person.id)).not.toContain(guessedAlias);
  });

  it("preserves real protocol enums when legal author IDs are identical to their values", () => {
    const original = caseWithAnswerId();
    const words = ["investigating", "closed", "guarded", "testimony", "suspect", "contemporary", "already_discovered"];
    const artifact = parseCaseArtifact({ ...original, facts: [...original.facts, ...words.map((id) => ({ id, type: "context", statement: "仅用于检验ID命名空间，不得改写协议字段。" }))] });
    const session = startGame(artifact);
    const value = {
      view: getPlayerCaseView(artifact, session),
      outcome: { status: "already_discovered", dialogue: { characterId: artifact.culpritId, demeanor: "guarded" } },
    };
    const encoded = createPlayerProtocol(artifact, session, protocolKey).encode(value);
    expect({
      status: encoded.view.session.status,
      era: encoded.view.case.setting.era,
      roles: encoded.view.characters.map((person) => person.roleTier),
      outcomeStatus: encoded.outcome.status,
      demeanor: encoded.outcome.dialogue.demeanor,
    }).toEqual({
      status: value.view.session.status,
      era: value.view.case.setting.era,
      roles: value.view.characters.map((person) => person.roleTier),
      outcomeStatus: value.outcome.status,
      demeanor: value.outcome.dialogue.demeanor,
    });
    expect(encoded.outcome.dialogue.characterId).not.toBe(artifact.culpritId);
  });

  it.each(["text", "reasoning"])("does not reveal whether an author reference in %s exists", (field) => {
    const artifact = caseWithAnswerId();
    const protocol = createPlayerProtocol(artifact, startGame(artifact), protocolKey);
    for (const id of [artifact.culpritId, "character_nonexistent", "evidence_nonexistent", "timeline_nonexistent", "person_unknown"]) {
      expect(errorSignature(() => protocol.decodeCommand({ [field]: `请核对${id}的证据依据。` }))).toEqual(invalidReference);
    }
  });

  it("keeps ordinary prose independent from hidden single-word author IDs", () => {
    const artifact = structuredClone(caseWithAnswerId());
    artifact.facts.push({ id: "investigating", type: "context", statement: "未披露的事实。" });
    const protocol = createPlayerProtocol(artifact, startGame(artifact), protocolKey);
    expect(protocol.decodeCommand({ text: "这里的 investigating 是什么意思？" })).toEqual({ text: "这里的 investigating 是什么意思？" });
  });

  it("rejects raw, unknown, foreign, hidden and wrong-kind selections uniformly", () => {
    const artifact = caseWithAnswerId();
    const session = startGame(artifact);
    const protocol = createPlayerProtocol(artifact, session, protocolKey);
    const alias = (id: string) => protocol.encode({ id }).id;
    const other = { ...artifact, id: "case_foreign_challenge", seed: "foreign_challenge" };
    const foreign = createPlayerProtocol(other, startGame(other), protocolKey).encode({ id: artifact.culpritId }).id;
    const hidden = artifact.evidence.find((item) => !session.discoveredEvidenceIds.includes(item.id))!;
    const invalidCommands = [
      { characterId: artifact.culpritId }, { characterId: "person_unknown" }, { characterId: foreign },
      { characterId: alias(hidden.id) }, { evidenceId: alias(hidden.id) },
      { evidenceId: alias(artifact.culpritId) }, { sceneId: alias(artifact.culpritId) },
    ];
    for (const command of invalidCommands) expect(errorSignature(() => protocol.decodeCommand(command))).toEqual(invalidReference);
  });

  it("roundtrips available selections and text while preserving command/session identity and revision", () => {
    const artifact = caseWithAnswerId();
    const session = startGame(artifact, { sessionId: artifact.culpritId });
    const protocol = createPlayerProtocol(artifact, session, protocolKey);
    const command = {
      commandId: artifact.culpritId, sessionId: session.id, expectedRevision: 8,
      characterId: artifact.culpritId, text: `请核对${artifact.culpritId}的说法。`,
    };
    const encoded = protocol.encode(command);
    expect(encoded.commandId).toBe(command.commandId);
    expect(encoded.sessionId).toBe(command.sessionId);
    expect(encoded.expectedRevision).toBe(8);
    expect(encoded.characterId).not.toBe(command.characterId);
    expect(encoded.text).not.toContain(artifact.culpritId);
    expect(protocol.decodeCommand(encoded)).toEqual(command);
    expect(protocol.encode({ session: { id: session.id, revision: 8 } })).toEqual({ session: { id: session.id, revision: 8 } });
  });
});

describe("independent player HTTP reference challenge", () => {
  let directory: string;
  let database: DatabaseHandle;
  let repository: GameRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "final-alibi-player-challenge-"));
    database = await createDatabase({ url: `file:${path.join(directory, "challenge.sqlite")}` });
    repository = new GameRepository(database);
    boundary.playerId = (await repository.createAnonymousIdentity()).playerId;
    boundary.services = { repository, game: new GameService(repository) };
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects existing and nonexistent author IDs in search text with identical HTTP output and no state change", async () => {
    const artifact = caseWithAnswerId();
    const { session } = await repository.createGame(boundary.playerId, artifact, { sessionId: "game_reference_oracle", source: "tutorial" });
    const bodies: unknown[] = [];
    for (const id of [artifact.culpritId, "character_nonexistent"]) {
      const response = await action(new NextRequest("http://localhost/api/games/test/actions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "investigate", commandId: "probe", expectedRevision: 0, text: `核实${id}。` }),
      }), { params: Promise.resolve({ sessionId: session.id }) });
      bodies.push(await response.json());
      expect(response.status).toBe(400);
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect((await repository.loadGame(boundary.playerId, session.id)).session.revision).toBe(0);
  });

  it("lets players query an ordinary account name with an underscore and receive the matching record", async () => {
    const draft = structuredClone(caseWithAnswerId());
    draft.evidence.push({
      id: "evidence_login_record", name: "登录核验记录", description: "账号admin_02是前台录入访客信息的普通登录名。",
      kind: "digital", supportsFactIds: [], contradictsClaimIds: [], implicatesCharacterIds: [], excludesCharacterIds: [], critical: false,
      discovery: { method: "query", actionAliases: ["查询登录名 admin_02"], prerequisiteEvidenceIds: [] },
    });
    const artifact = parseCaseArtifact(draft);
    const { session } = await repository.createGame(boundary.playerId, artifact, { sessionId: "game_account_query", source: "tutorial" });
    const response = await action(new NextRequest("http://localhost/api/games/test/actions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "investigate", commandId: "query_account", expectedRevision: 0, text: "查询登录名 admin_02" }),
    }), { params: Promise.resolve({ sessionId: session.id }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.view.evidence).toContainEqual(expect.objectContaining({ name: "登录核验记录", description: expect.stringContaining("admin_02") }));
    const stored = await repository.loadGame(boundary.playerId, session.id);
    expect(stored.session.discoveredEvidenceIds).toContain("evidence_login_record");
  });

  it("does not resolve a guessed nonstandard author ID through the player's own question echo", async () => {
    const artifact = parseCaseArtifact(JSON.parse(JSON.stringify(caseWithAnswerId()).replaceAll("character_culprit", "li_culprit")));
    const { session } = await repository.createGame(boundary.playerId, artifact, { sessionId: "game_question_echo", source: "tutorial" });
    boundary.services = { repository, game: new GameService(repository),
      dialogue: new DialogueService(repository, { async invokeStructured() { throw new Error("Independent protocol tests never call paid models"); } }),
    };
    const context = { params: Promise.resolve({ sessionId: session.id }) };
    const publicView = await (await getGame(new Request("http://localhost"), context)).json();
    const text = "案发时你在哪里？请核实 li_culprit。";
    const response = await dialogue(new NextRequest("http://localhost/api/games/test/dialogue", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "guess_author_id", expectedRevision: 0, characterId: publicView.view.characters[0].id, text }),
    }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.view.dialogue.at(-1).playerText).toBe(text);
  });

  it("preserves aliases and replays a command after the database and services restart", async () => {
    const artifact = caseWithAnswerId();
    const { session } = await repository.createGame(boundary.playerId, artifact, { sessionId: "game_protocol_restart", source: "tutorial" });
    const context = { params: Promise.resolve({ sessionId: session.id }) };
    const firstView = await (await getGame(new Request("http://localhost"), context)).json();
    const sourceScene = artifact.scenes.find((scene) => scene.initiallyUnlocked)!;
    const sourceObject = sourceScene.objects.find((object) => object.evidenceIds.length > 0)!;
    const scene = firstView.view.scenes.find((item: { name: string }) => item.name === sourceScene.name);
    const object = scene.objects.find((item: { name: string }) => item.name === sourceObject.name);
    const command = { type: "investigate", commandId: "command_before_restart", expectedRevision: 0,
      sceneId: scene.id, objectId: object.id, text: sourceObject.actionAliases[0]! };
    const request = () => new NextRequest("http://localhost/api/games/test/actions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
    });
    const firstResponse = await action(request(), context);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.outcome.discoveredEvidenceIds.length).toBeGreaterThan(0);

    database.close();
    database = await createDatabase({ url: `file:${path.join(directory, "challenge.sqlite")}` });
    repository = new GameRepository(database);
    boundary.services = { repository, game: new GameService(repository) };
    const restored = await (await getGame(new Request("http://localhost"), context)).json();
    expect(restored.view.characters.map((person: { id: string }) => person.id)).toEqual(firstView.view.characters.map((person: { id: string }) => person.id));
    expect(restored.view.evidence).toEqual(first.view.evidence);
    const replayResponse = await action(request(), context);
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json();
    expect(replay.replayed).toBe(true);
    expect(replay.outcome).toEqual(first.outcome);
    expect(replay.view.session.revision).toBe(first.view.session.revision);
    expect(JSON.stringify(replay)).not.toContain(artifact.culpritId);
  });
});
