import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import type {
  StructuredModelProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { startGame } from "@/domain/game/game-runtime";

import { createDialogueGraph } from "./dialogue-graph";
import { buildCharacterContext } from "./dialogue-prompts";

describe("dialogue graph", () => {
  it("builds a private context containing only the selected character's knowledge", () => {
    const session = startGame(tutorialCase, { sessionId: "game_prompt_isolation" });
    const serialized = JSON.stringify(
      buildCharacterContext({
        caseArtifact: tutorialCase,
        session,
        characterId: "character_luo_fang",
        playerText: "谁送了茶？",
      }),
    );

    expect({
      includesPrivateProfile: serialized.includes("起初不敢指认雇主的财务主管"),
      includesKnownFact: serialized.includes("死亡发生在二十一点十分前后"),
      includesOwnClaim: serialized.includes("claim_luo_tea"),
      leaksCulpritProfile: serialized.includes("挪用资金即将败露"),
      leaksGlobalCulpritId: serialized.includes("culpritId"),
      leaksOtherClaim: serialized.includes("claim_li_alibi"),
    }).toEqual({
      includesPrivateProfile: false,
      includesKnownFact: true,
      includesOwnClaim: true,
      leaksCulpritProfile: false,
      leaksGlobalCulpritId: false,
      leaksOtherClaim: false,
    });
  });

  it("generates and guards a structured in-character response", async () => {
    const provider = new ScriptedProvider([
      safeCharacterResponse(),
      { safe: true, violationCodes: [], feedback: "" },
    ]);
    const graph = createDialogueGraph(provider, { checkpointer: new MemorySaver() });
    const result = await graph.invoke(
      graphInput("command_dialogue_safe"),
      { configurable: { thread_id: "game_dialogue:character_luo_fang" } },
    );

    expect({
      finalResponse: result.finalResponse,
      schemas: provider.requests.map((request) => request.schemaName),
      modelCallCount: result.modelCalls.length,
    }).toEqual({
      finalResponse: safeCharacterResponse(),
      schemas: ["character_response", "dialogue_guard"],
      modelCallCount: 2,
    });
  });

  it("repairs a response that cites another character's claim before guard review", async () => {
    const provider = new ScriptedProvider([
      {
        ...safeCharacterResponse(),
        disclosedClaimIds: ["claim_li_alibi"],
      },
      safeCharacterResponse(),
      { safe: true, violationCodes: [], feedback: "" },
    ]);
    const graph = createDialogueGraph(provider, { maxDraftAttempts: 2 });
    const result = await graph.invoke(graphInput("command_dialogue_repair"));

    expect({
      response: result.finalResponse,
      attempts: result.attempt,
      schemas: provider.requests.map((request) => request.schemaName),
    }).toEqual({
      response: safeCharacterResponse(),
      attempts: 2,
      schemas: [
        "character_response",
        "character_response",
        "dialogue_guard",
      ],
    });
  });

  it("accepts an authorized lie without a semantic guard round trip", async () => {
    const alibi = tutorialCase.claims.find(
      (claim) => claim.id === "claim_li_alibi",
    );
    if (!alibi) throw new Error("Tutorial alibi claim is missing");
    const session = {
      ...startGame(tutorialCase, { sessionId: "game_dialogue_lie" }),
      discoveredEvidenceIds: tutorialCase.evidence.map((evidence) => evidence.id),
    };
    const response = {
      utterance: alibi.statement,
      demeanor: "guarded" as const,
      disclosedClaimIds: [alibi.id],
      memorySummary: "我坚持自己一直在客房打电话。",
      stateDelta: { trust: -1, pressure: 2, alertness: 2 },
    };
    const provider = new ScriptedProvider([response]);
    const graph = createDialogueGraph(provider);
    const result = await graph.invoke({
      ...graphInput("command_dialogue_lie"),
      session,
      characterId: alibi.speakerId,
      playerText: "那天你都在干嘛？",
    });

    expect(result.finalResponse).toEqual(response);
    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "character_response",
    ]);
  });

  it("uses a grounded, state-neutral fallback after repeated semantic guard failures", async () => {
    const rejectedGuard = {
      safe: false,
      violationCodes: ["knowledge_leak"],
      feedback: "泄露了角色不知道的真相",
    };
    const provider = new ScriptedProvider([
      safeCharacterResponse(),
      rejectedGuard,
      safeCharacterResponse(),
      rejectedGuard,
    ]);
    const graph = createDialogueGraph(provider, { maxDraftAttempts: 2 });
    const result = await graph.invoke(graphInput("command_dialogue_fallback"));

    expect(result.finalResponse).toMatchObject({
      demeanor: "cooperative",
      disclosedClaimIds: ["claim_luo_tea"],
      stateDelta: { trust: 0, pressure: 0, alertness: 0 },
    });
    expect(result.finalResponse?.utterance).toContain("李闻舟");
    expect(result.finalResponse?.utterance).not.toContain("不想回答");
  });

  it("answers a direct accusation with an authorized cover story before calling the model", async () => {
    const rejectedGuard = {
      safe: false,
      violationCodes: ["truth_contradiction"],
      feedback: "候选回复需要更符合角色已知信息",
    };
    const provider = new ScriptedProvider([
      guardedNoncommittalResponse(),
      rejectedGuard,
      guardedNoncommittalResponse(),
      rejectedGuard,
    ]);
    const graph = createDialogueGraph(provider, { maxDraftAttempts: 2 });
    const result = await graph.invoke({
      ...graphInput("command_dialogue_accusation_fallback"),
      characterId: "character_li_wenzhou",
      playerText: "茶里验出了镇静剂，是你下的吗？",
    });

    expect(result.finalResponse).toMatchObject({
      utterance: "我没有碰过顾先生的茶，也没有进入书房。",
      demeanor: "guarded",
      disclosedClaimIds: [],
      stateDelta: { trust: 0, pressure: 0, alertness: 0 },
    });
    expect(provider.requests).toEqual([]);
  });

  it("answers a matching interview prompt and skips the model", async () => {
    const caseArtifact = structuredClone(tutorialCase);
    const testimony = caseArtifact.evidence.find(
      (evidence) => evidence.id === "evidence_housekeeper_testimony",
    );
    if (!testimony) throw new Error("Tutorial testimony is missing");
    testimony.discovery.dialogueAliases = [
      "你那天有见到其他人吗",
      "你看到谁了",
      "谁把茶盘拿走了",
    ];
    testimony.discovery.dialogueUtterance =
      "我看到李闻舟主动接过茶盘，说由他送上楼。";

    const provider = new ScriptedProvider([]);
    const graph = createDialogueGraph(provider);
    const result = await graph.invoke({
      ...graphInput("command_dialogue_witness_sighting"),
      caseArtifact,
      session: startGame(caseArtifact, { sessionId: "game_dialogue_witness_sighting" }),
      playerText: "你那天有见到其他人么",
    });

    expect(result.finalResponse).toEqual({
      utterance: "我看到李闻舟主动接过茶盘，说由他送上楼。",
      demeanor: "cooperative",
      disclosedClaimIds: [],
      memorySummary: "侦探问及：你那天有见到其他人么",
      stateDelta: { trust: 0, pressure: 0, alertness: 0 },
    });
    expect(provider.requests).toEqual([]);
  });

  it("repeats an already disclosed alibi for a verification follow-up before calling the model", async () => {
    const rejectedGuard = {
      safe: false,
      violationCodes: ["unsupported_claim"],
      feedback: "候选回复缺少可核验的依据",
    };
    const provider = new ScriptedProvider([
      guardedNoncommittalResponse(),
      rejectedGuard,
      guardedNoncommittalResponse(),
      rejectedGuard,
    ]);
    const graph = createDialogueGraph(provider, { maxDraftAttempts: 2 });
    const session = {
      ...startGame(tutorialCase, { sessionId: "game_dialogue_alibi_followup" }),
      discoveredClaimIds: ["claim_li_alibi"],
      dialogue: [
        {
          commandId: "command_dialogue_initial_alibi",
          at: "2026-08-31T10:00:00+08:00",
          characterId: "character_li_wenzhou",
          playerText: "案发时你在哪里？",
          utterance: "九点前后我一直在客房打电话，从未上过二楼。",
          demeanor: "guarded" as const,
          disclosedClaimIds: ["claim_li_alibi"],
          discoveredEvidenceIds: [],
        },
      ],
    };
    const result = await graph.invoke({
      ...graphInput("command_dialogue_alibi_followup"),
      session,
      characterId: "character_li_wenzhou",
      playerText: "有谁能证明吗？",
    });

    expect(result.finalResponse).toMatchObject({
      utterance: "九点前后我一直在客房打电话，从未上过二楼。",
      demeanor: "guarded",
      disclosedClaimIds: ["claim_li_alibi"],
      stateDelta: { trust: 0, pressure: 0, alertness: 0 },
    });
    expect(provider.requests).toEqual([]);
  });

  it("rejects an exact fact the selected character does not know before model review", async () => {
    const provider = new ScriptedProvider([
      {
        ...safeCharacterResponse(),
        utterance: "李闻舟挪用基金会资金，顾明远准备在次日报警。",
        disclosedClaimIds: [],
      },
    ]);
    const graph = createDialogueGraph(provider, { maxDraftAttempts: 1 });
    const result = await graph.invoke(graphInput("command_dialogue_fact_leak"));

    expect(result.finalResponse).toMatchObject({
      demeanor: "cooperative",
      disclosedClaimIds: ["claim_luo_tea"],
    });
    expect(result.finalResponse?.utterance).not.toContain("挪用基金会资金");
    expect(result.finalResponse?.utterance).toContain("李闻舟");
    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "character_response",
    ]);
  });

  it("rejects a repeated no-progress reply before the semantic guard", async () => {
    const repeatedUtterance = "我……我看到了一些事情，但我现在很害怕，不知道说出来会不会有麻烦。";
    const session = {
      ...startGame(tutorialCase, { sessionId: "game_dialogue_repeat" }),
      dialogue: [
        {
          commandId: "command_dialogue_previous_fear",
          at: "2026-08-31T10:00:00+08:00",
          characterId: "character_luo_fang",
          playerText: "你看到什么了？",
          utterance: repeatedUtterance,
          demeanor: "guarded" as const,
          disclosedClaimIds: [],
          discoveredEvidenceIds: [],
        },
      ],
    };
    const provider = new ScriptedProvider([
      {
        ...guardedNoncommittalResponse(),
        utterance: repeatedUtterance,
      },
    ]);
    const graph = createDialogueGraph(provider, { maxDraftAttempts: 1 });
    const result = await graph.invoke({
      ...graphInput("command_dialogue_repeated_fear"),
      session,
      playerText: "你今天感觉怎么样？",
    });

    expect(result.guard?.violationCodes).toEqual(["repeated_response"]);
    expect(result.finalResponse?.utterance).not.toBe(repeatedUtterance);
    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "character_response",
    ]);
  });
});

class ScriptedProvider implements StructuredModelProvider {
  readonly requests: Array<{ schemaName: string }> = [];

  constructor(private readonly responses: unknown[]) {}

  async invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    this.requests.push({ schemaName: request.schemaName });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted model response remains");

    return {
      value: request.schema.parse(response),
      model: "mock-deepseek",
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 40 },
      rawResponse: { scripted: true },
    };
  }
}

function graphInput(commandId: string) {
  return {
    caseArtifact: tutorialCase,
    session: startGame(tutorialCase, { sessionId: "game_dialogue" }),
    commandId,
    characterId: "character_luo_fang",
    playerText: "你和李闻舟平时来往多吗？",
    attempt: 0,
    draft: null,
    guard: null,
    finalResponse: null,
    modelCalls: [],
  };
}

function safeCharacterResponse() {
  return {
    utterance: "李闻舟主动接过茶盘，说由他送上楼。",
    demeanor: "cooperative" as const,
    disclosedClaimIds: ["claim_luo_tea"],
    memorySummary: "我告诉侦探，是李闻舟接走了茶盘。",
    stateDelta: { trust: 4, pressure: 1, alertness: 0 },
  };
}

function guardedNoncommittalResponse() {
  return {
    utterance: "我不知道你在说什么。",
    demeanor: "guarded" as const,
    disclosedClaimIds: [],
    memorySummary: "我没有正面回应这项指控。",
    stateDelta: { trust: 0, pressure: 0, alertness: 0 },
  };
}
