import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StructuredModelProvider, StructuredModelRequest, StructuredModelResult } from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { performInvestigation, presentEvidence } from "@/domain/game/game-runtime";
import { createDatabase, type DatabaseHandle } from "@/infrastructure/db/database";
import { GameRepository } from "@/infrastructure/persistence/game-repository";

import { DialogueService } from "./dialogue-service";

const characterId = "character_li_wenzhou";
const alibiStatement = "案发当晚我一直在物业办公室加班。";
type Proof = "witness" | "alone" | "unknown";
type ProviderMode = "healthy" | "semantic_failure" | "unavailable";

describe.each<ProviderMode>(["healthy", "semantic_failure", "unavailable"])("dialogue replay with %s provider", (mode) => {
  let directory: string;
  let database: DatabaseHandle;
  let repository: GameRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "alibi-replay-"));
    database = await createDatabase({ url: `file:${path.join(directory, "test.sqlite")}` });
    repository = new GameRepository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each<Proof>(["witness", "alone", "unknown"])("persists a continuous alibi, proof, witness-time, rephrased proof and contradiction conversation: %s", async (proof) => {
    const caseArtifact = officeCase(proof);
    const identity = await repository.createAnonymousIdentity();
    const created = await repository.createGame(identity.playerId, caseArtifact, { source: "tutorial" });
    let session = created.session;
    const provider = new ReplayProvider(mode, proof);
    const service = new DialogueService(repository, provider);
    const questions = [
      "当天你在做什么？",
      "谁能证明你在物业办公室加班？",
      "他几点见你？",
      "换个问法，到底谁能为你作证？",
      "这份监控玻璃中的倒影和你的说法矛盾，你怎么解释？",
    ];
    const utterances: string[] = [];

    for (const [index, text] of questions.entries()) {
      if (index === 4) {
        for (const [commandId, sceneId, action] of [
          ["find_ledger", "scene_study", "翻找书桌抽屉"],
          ["find_memo", "scene_study", "检查碎纸篓"],
          ["find_log", "scene_security_room", "恢复门禁日志"],
          ["find_reflection", "scene_security_room", "逐帧查看监控"],
        ]) {
          const result = await repository.executeGameCommand({
            playerId: identity.playerId, sessionId: session.id, commandId,
            expectedRevision: session.revision, kind: "investigation", request: {},
          }, (artifact, current) => performInvestigation(artifact, current, { commandId, sceneId, text: action }));
          session = result.session;
        }
        const presented = await repository.executeGameCommand({
          playerId: identity.playerId, sessionId: session.id, commandId: "present_log",
          expectedRevision: session.revision, kind: "present_evidence", request: {},
        }, (artifact, current) => presentEvidence(artifact, current, {
          commandId: "present_log", characterId, evidenceId: "evidence_camera_reflection",
        }));
        expect(presented.outcome.status).toBe("presented");
        session = presented.session;
      }

      const result = await service.talk({
        playerId: identity.playerId, sessionId: session.id, commandId: `talk_${index}`,
        expectedRevision: session.revision, characterId, text,
      });
      session = result.session;
      expect(session.dialogue).toHaveLength(index + 1);
      expect(session.dialogue.at(-1)?.playerText).toBe(text);
      expect(result.outcome.response?.stateDelta).toEqual({ trust: 0, pressure: 0, alertness: 0 });
      utterances.push(result.outcome.response!.utterance);
    }

    expect(utterances[0]).toBe(alibiStatement);
    expect(utterances.slice(1)).not.toContain(alibiStatement);
    expect(utterances[1]).not.toBe(utterances[3]);
    if (proof === "witness") {
      expect(utterances[1]).toContain("老周");
      expect(utterances[2]).toContain("八点二十分");
      expect(utterances[3]).toContain("老周");
    } else {
      expect(utterances[2]).toMatch(/无法确认|没有能确认/);
      expect(utterances.slice(1, 4).join(" ")).not.toMatch(/老周|八点二十分|九点/);
      if (proof === "alone") {
        expect(utterances[1]).toMatch(/没有人|没人/);
        expect(utterances[3]).toMatch(/没有人|没人/);
      } else {
        expect(utterances.slice(1, 4).join(" ")).not.toMatch(/没有人|没人|无人|没有监控|没有记录/);
        expect(utterances[1]).toMatch(/无法确认|提供不了/);
      }
    }
    expect(utterances[4]).toContain("监控玻璃中的倒影");
    expect(utterances[4]).toMatch(/冲突|矛盾/);
    expect(utterances.join(" ")).not.toContain("备用门卡藏在");
    expect(session.discoveredClaimIds).not.toContain("claim_locked_witness");
    expect(session.discoveredEvidenceIds).not.toContain("evidence_locked_witness");
    // 可核验的人证、时点和已出示的矛盾都采用完整账本命题，不再让模型改写限定。
    expect(new Set(provider.historyLengths)).toEqual(new Set([0]));
    expect(provider.guardCalls).toBe(0);
  });
});

function officeCase(proof: Proof) {
  const artifact = structuredClone(tutorialCase);
  const character = artifact.characters.find((candidate) => candidate.id === characterId)!;
  artifact.claims.find((claim) => claim.id === "claim_li_alibi")!.statement = alibiStatement;
  character.lieRules[0].coverStatement = alibiStatement;
  if (proof !== "unknown") {
    const statement = proof === "witness"
      ? "保安老周在八点二十分看见我在物业办公室。"
      : "当时我独自在物业办公室，没有人能替我直接作证。";
    artifact.facts.push({ id: "fact_office_proof", type: "alibi", statement });
    artifact.claims.push({ id: "claim_office_proof", speakerId: characterId, kind: "truth", statement, factIds: ["fact_office_proof"] });
    character.knowledge.factIds.push("fact_office_proof");
    character.knowledge.claimIds.push("claim_office_proof");
  }
  const lockedStatement = "备用门卡藏在我办公室的保险柜里。";
  artifact.facts.push({ id: "fact_locked_witness", type: "opportunity", statement: lockedStatement });
  artifact.claims.push({ id: "claim_locked_witness", speakerId: characterId, kind: "withheld", statement: lockedStatement, factIds: ["fact_locked_witness"] });
  character.knowledge.factIds.push("fact_locked_witness");
  character.knowledge.claimIds.push("claim_locked_witness");
  character.secretFactIds.push("fact_locked_witness");
  artifact.evidence.push({
    id: "evidence_locked_witness", name: "尚未解锁的证言", description: lockedStatement,
    kind: "testimony", supportsFactIds: ["fact_locked_witness"], contradictsClaimIds: [],
    implicatesCharacterIds: [], excludesCharacterIds: [], critical: false,
    discovery: { method: "interview", characterId, actionAliases: ["追问藏卡位置"], dialogueAliases: ["谁能证明你在办公室", "那张备用门卡在哪里", "你把门卡放在哪里了"], dialogueUtterance: lockedStatement, prerequisiteEvidenceIds: ["evidence_livestream_record"] },
  });
  return artifact;
}

class ReplayProvider implements StructuredModelProvider {
  readonly historyLengths: number[] = [];
  guardCalls = 0;

  constructor(private readonly mode: ProviderMode, private readonly proof: Proof) {}

  async invokeStructured<T extends Record<string, unknown>>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>> {
    let value: unknown;
    if (request.schemaName === "dialogue_guard") {
      this.guardCalls += 1;
      const context = JSON.parse(request.messages[1].content);
      value = this.mode === "semantic_failure"
        ? { safe: false, violationCodes: ["unsupported_claim"], feedback: "不能编造证人或时间" }
        : { safe: true, violationCodes: [], feedback: "", groundingChecks: context.permittedFactStatements
          .filter((statement: string) => /老周|独自在物业办公室|门禁/u.test(statement))
          .map((sourceText: string) => ({ candidateText: context.candidate.utterance, sourceText })) };
    } else {
      const context = JSON.parse(request.messages[1].content.replace(/^CHARACTER_CONTEXT\n/u, ""));
      const turn = context.recentDialogue.length;
      this.historyLengths.push(turn);
      if (this.mode === "unavailable") throw new Error("Provider unavailable");
      const proofStatement = this.proof === "witness"
        ? "老周在八点二十分见过我，当时我在物业办公室。"
        : this.proof === "alone"
          ? "当时没人和我一起，无法提供直接证明人。"
          : "谁能替这段行踪作证，我目前无法确认。";
      const utterance = turn === 0 ? alibiStatement
        : this.mode === "semantic_failure" ? "陈默和赵衡在九点十五分见过我，监控也能证明。"
          : turn === 1 ? proofStatement
            : turn === 2 ? this.proof === "witness" ? "老周见到我的时间是八点二十分。" : "你问的见面时间，我目前无法确认。"
              : turn === 3 ? `关于谁能证明，我还是只能说明：${proofStatement}`
                : "你出示的恢复的书房门禁日志和我的说法有矛盾，我暂时解释不了。";
      value = {
        utterance, demeanor: "guarded", memorySummary: `侦探追问：${context.detectiveSays}`,
        disclosedClaimIds: turn === 0 ? ["claim_li_alibi"]
          : this.mode === "healthy" && this.proof !== "unknown" && turn < 4 ? ["claim_office_proof"] : [],
        stateDelta: { trust: 0, pressure: 0, alertness: 0 },
      };
    }
    return { value: request.schema.parse(value), model: "mock", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, rawResponse: {} };
  }
}
