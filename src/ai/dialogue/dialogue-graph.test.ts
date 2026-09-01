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

  it("uses a non-disclosing fallback after repeated semantic guard failures", async () => {
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
      demeanor: "guarded",
      disclosedClaimIds: [],
    });
    expect(result.finalResponse?.utterance).toContain("不想回答");
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
      demeanor: "guarded",
      disclosedClaimIds: [],
    });
    expect(result.finalResponse?.utterance).not.toContain("挪用基金会资金");
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
    playerText: "到底是谁把茶送进书房的？",
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
