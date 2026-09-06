import { describe, expect, it } from "vitest";

import type { StructuredModelProvider, StructuredModelRequest, StructuredModelResult } from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { buildGroundedDialogueFallback, recordDialogueTurn, startGame } from "@/domain/game/game-runtime";

import { createDialogueGraph } from "./dialogue-graph";
import { buildCharacterContext } from "./dialogue-prompts";
import type { CharacterResponse } from "./dialogue-schema";

const characterId = "character_li_wenzhou";

describe("independent dialogue challenges", () => {
  it("answers an explicit change of topic instead of continuing the previous alibi", () => {
    const artifact = structuredClone(tutorialCase);
    const proof = "老周在八点二十分看见我在物业办公室。";
    addKnownClaim(artifact, "proof", proof);
    addKnownClaim(artifact, "records", "我负责保管公司的财务记录。");
    const session = recordDialogueTurn(artifact, startGame(artifact, { sessionId: "challenge_topic" }), {
      commandId: "previous_proof", characterId, playerText: "谁见过你？",
      response: response(proof, ["claim_challenge_proof"]),
    }).session;

    const reply = buildGroundedDialogueFallback(artifact, session, characterId, "公司的财务记录由谁保管？");
    expect(reply.utterance).toContain("财务记录");
    expect(reply.utterance).toContain("保管");
    expect(reply.utterance).not.toMatch(/老周|办公室|八点二十分/);
  });

  it("preserves a witness's negative observation and the later actual sighting", () => {
    const artifact = structuredClone(tutorialCase);
    const proof = "老周在八点二十分到办公室时，没有见到我；九点整才看见我。";
    addKnownClaim(artifact, "qualified_sighting", proof);
    const session = startGame(artifact, { sessionId: "challenge_sighting" });

    const reply = buildGroundedDialogueFallback(artifact, session, characterId, "老周是几点见到你的？");
    expect(reply.utterance).toContain("九点整");
    if (reply.utterance.includes("八点二十分")) {
      expect(reply.utterance).toContain("没有见到我");
    }
  });

  it("answers a specific work question from an available duty record after an alibi paraphrase", async () => {
    const artifact = structuredClone(tutorialCase);
    const cover = "案发那晚我在物业办公室加班，有监控为证。";
    const duty = "当晚我在物业办公室校对消防巡检登记表。";
    artifact.claims.find((claim) => claim.id === "claim_li_alibi")!.statement = cover;
    artifact.characters.find((character) => character.id === characterId)!.lieRules
      .find((rule) => rule.factId === "fact_opportunity_stolen_card")!.coverStatement = cover;
    addKnownClaim(artifact, "duty", duty);
    const session = recordDialogueTurn(artifact, startGame(artifact, { sessionId: "challenge_work_detail" }), {
      commandId: "office_paraphrase", characterId, playerText: "案发当晚你在什么地方？",
      response: response("我那晚在物业办公室加班。", ["claim_li_alibi"]),
    }).session;
    const result = await createDialogueGraph(new PermissiveProvider(response(duty, ["claim_challenge_duty"])), { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session, characterId, commandId: "specific_work",
      playerText: "刚才说在办公室，你具体在做什么？",
    });

    expect(result.finalResponse?.utterance).toContain("校对消防巡检登记表");
    expect(result.finalResponse?.utterance).not.toBe(cover);
  });

  it("allows an explicit authorized employment duration instead of refusing all tenure questions", async () => {
    const artifact = structuredClone(tutorialCase);
    const tenure = "我在这个小区任物业经理六年整。";
    addKnownClaim(artifact, "tenure", tenure);
    const result = await createDialogueGraph(new PermissiveProvider(response(tenure, ["claim_challenge_tenure"])), { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact, { sessionId: "challenge_known_tenure" }),
      characterId, commandId: "known_tenure", playerText: "你在物业工作多久了？",
    });

    expect(result.finalResponse?.utterance).toContain("六年整");
    expect(result.finalResponse?.utterance).not.toMatch(/无法确认|没有可以确认/);
  });

  it.each(["briefing", "victim_profile"])("allows a basic public identity answer with the victim's explicit identity in %s", async (sourceLocation) => {
    const artifact = structuredClone(tutorialCase);
    const character = artifact.characters.find((candidate) => candidate.id === characterId)!;
    const victim = artifact.characters.find((candidate) => candidate.id === artifact.victimId)!;
    character.occupation = "小区物业经理";
    character.publicProfile = "李闻舟担任小区物业经理。";
    const victimIdentity = `${victim.name}是小区业主。`;
    if (sourceLocation === "briefing") artifact.briefing = victimIdentity;
    else victim.publicProfile = victimIdentity;
    const answer = `我担任小区物业经理，${victim.name}是小区业主。`;
    const provider = new PermissiveProvider(response(answer), [
      { candidateText: "我担任小区物业经理", sourceText: `${character.name}的职业是${character.occupation}。` },
      { candidateText: `${victim.name}是小区业主`, sourceText: victimIdentity },
    ]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact, { sessionId: `challenge_public_identity_${sourceLocation}` }),
      characterId, commandId: "public_identity", playerText: "你和死者是什么关系？",
    });

    expect(result.finalResponse?.utterance).toBe(answer);
  });

  it("does not attribute a generic public financial dispute to this character merely because the guard cites it", async () => {
    const artifact = structuredClone(tutorialCase);
    artifact.briefing = "死者与部分来访者存在经济纠纷，具体涉及谁尚待调查。";
    const inventedAttribution = "我与死者之间存在经济纠纷。";
    const provider = new PermissiveProvider(response(inventedAttribution), [{
      candidateText: inventedAttribution,
      sourceText: artifact.briefing,
    }]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact, { sessionId: "challenge_generic_attribution" }),
      characterId, commandId: "generic_attribution", playerText: "你和死者是什么关系？",
    });

    expect(result.finalResponse?.utterance).not.toContain("我与死者之间存在经济纠纷");
  });

  it("does not approve a sighting at the earlier denied time even when the guard quotes the full record", async () => {
    const artifact = structuredClone(tutorialCase);
    const source = "老周在八点二十分到办公室时，没有见到我；九点整才看见我。";
    const falseSighting = "老周在八点二十分就看见了我。";
    addKnownClaim(artifact, "qualified_guard_sighting", source);
    const provider = new PermissiveProvider(response(falseSighting, ["claim_challenge_qualified_guard_sighting"]), [{
      candidateText: falseSighting,
      sourceText: source,
    }]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact, { sessionId: "challenge_guard_sighting" }),
      characterId, commandId: "false_sighting", playerText: "老周是几点见到你的？",
    });

    expect(result.finalResponse?.utterance).not.toContain("八点二十分就看见了我");
    expect(result.finalResponse?.utterance).toContain("九点整");
  });

  it.each([
    "关于那晚我很晚才回去。",
    "我无法解释为什么那晚我带走了死者的钱。",
  ])("does not exempt new facts merely because a reply uses a boundary phrase: %s", async (inventedDetail) => {
    const provider = new PermissiveProvider(response(inventedDetail));
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: tutorialCase,
      session: startGame(tutorialCase, { sessionId: "challenge_boundary_phrase" }),
      characterId, commandId: "embedded_fact", playerText: "请补充你知道的情况。",
    });

    expect(result.finalResponse?.utterance).not.toBe(inventedDetail);
    expect(result.finalResponse?.utterance).not.toMatch(/很晚才回去|带走了死者的钱/);
  });

  it("does not put a known but unrevealed secret into the character's permitted context", () => {
    const secret = tutorialCase.facts.find((fact) => fact.id === "fact_motive_embezzlement")!;
    const context = buildCharacterContext({
      caseArtifact: tutorialCase, session: startGame(tutorialCase, { sessionId: "challenge_secret_prompt" }),
      characterId, playerText: "请补充你知道的情况。",
    });
    expect(JSON.stringify(context)).not.toContain(secret.statement);
  });

  it.each([false, true])("blocks an unrevealed secret even when the model guard approves it (with truth claim: %s)", async (withClaim) => {
    const artifact = structuredClone(tutorialCase);
    const secret = artifact.facts.find((fact) => fact.id === "fact_motive_embezzlement")!;
    const secretClaimId = "claim_challenge_secret";
    if (withClaim) {
      artifact.claims.push({ id: secretClaimId, speakerId: characterId, kind: "truth", statement: secret.statement, factIds: [secret.id] });
      artifact.characters.find((character) => character.id === characterId)!.knowledge.claimIds.push(secretClaimId);
    }
    const graph = createDialogueGraph(new PermissiveProvider(response(secret.statement, withClaim ? [secretClaimId] : [])), { maxDraftAttempts: 1 });
    const result = await graph.invoke({
      caseArtifact: artifact, session: startGame(artifact, { sessionId: `challenge_secret_${withClaim}` }),
      commandId: "unsafe_model_reply", characterId, playerText: "请补充你知道的情况。",
    });

    expect(result.finalResponse).not.toBeNull();
    expect(result.finalResponse?.utterance).not.toContain(secret.statement);
    expect(result.finalResponse?.disclosedClaimIds).not.toContain(secretClaimId);
  });
});

function addKnownClaim(artifact: typeof tutorialCase, suffix: string, statement: string) {
  const factId = `fact_challenge_${suffix}`;
  const claimId = `claim_challenge_${suffix}`;
  artifact.facts.push({ id: factId, type: "context", statement });
  artifact.claims.push({ id: claimId, speakerId: characterId, kind: "truth", statement, factIds: [factId] });
  const character = artifact.characters.find((candidate) => candidate.id === characterId)!;
  character.knowledge.factIds.push(factId);
  character.knowledge.claimIds.push(claimId);
}

function response(utterance: string, disclosedClaimIds: string[] = []): CharacterResponse {
  return { utterance, disclosedClaimIds, demeanor: "guarded", memorySummary: "", stateDelta: { trust: 0, pressure: 0, alertness: 0 } };
}

class PermissiveProvider implements StructuredModelProvider {
  constructor(
    private readonly candidate: CharacterResponse,
    private readonly groundingChecks?: Array<{ candidateText: string; sourceText: string }>,
  ) {}

  async invokeStructured<T extends Record<string, unknown>>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>> {
    const value = request.schemaName === "character_response"
      ? this.candidate
      : { safe: true, violationCodes: [], feedback: "", groundingChecks: this.groundingChecks };
    return {
      value: request.schema.parse(value), model: "challenge-mock",
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, rawResponse: { mock: true },
    };
  }
}
