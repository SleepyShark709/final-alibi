import { describe, expect, it } from "vitest";

import type {
  StructuredModelProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { parseCaseArtifact } from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";
import {
  getPlayerCaseView,
  performInvestigation,
  recordDialogueTurn,
  startGame,
  submitCaseReport,
  type GameSession,
} from "@/domain/game/game-runtime";

import { createCaseGenerationGraph } from "./case-generation-graph";

describe("generated case release gate stress", () => {
  it("publishes and completes ten consecutive constrained cases", async () => {
    const results: Array<{ index: number; score: number; revisions: number }> = [];

    for (let index = 1; index <= 10; index += 1) {
      const seed = `stress-seed-${index}`;
      const artifact = parseCaseArtifact({
        ...tutorialCase,
        id: `case_stress_${index}`,
        seed,
        title: `雨夜书房 · 压测卷 ${index}`,
      });
      const graph = createCaseGenerationGraph(
        new StressProvider([
          artifact,
          {
            culpritId: artifact.culpritId,
            evidenceIds: [
              "evidence_transfer_ledger",
              "evidence_smart_lock_log",
              "evidence_brass_bookend",
            ],
            reasoning:
              "账目建立动机，门禁与目击建立机会，书挡纤维及茶中成分共同还原作案手法。",
          },
        ]),
      );
      const generated = await graph.invoke({
        request: { seed, theme: "现代封闭空间案件", difficulty: "standard" },
        attempt: 0,
        draft: null,
        validationIssues: [],
        blindSolve: null,
        finalArtifact: null,
        rejectionReason: null,
        modelCalls: [],
      });
      expect(generated.finalArtifact).not.toBeNull();
      const released = generated.finalArtifact!;
      expect(validatePublishableCaseArtifact(released).valid).toBe(true);
      expect(JSON.stringify(getPlayerCaseView(released, startGame(released)))).not.toMatch(
        /privateProfile|lieRules|culpritId/,
      );

      const investigated = discoverRequiredEvidence(
        released,
        startGame(released, { sessionId: `game_stress_${index}` }),
      );
      const submitted = submitCaseReport(released, investigated, {
        commandId: `report_stress_${index}`,
        culpritId: released.solution.culpritId,
        motiveFactId: released.solution.motiveFactId,
        methodFactId: released.solution.methodFactId,
        evidenceIds: released.solution.requiredEvidenceIds,
        timelineEventIds: released.solution.requiredTimelineEventIds,
        reasoning: "动机、手法、机会、排除证据与时间线相互印证。",
      });
      results.push({
        index,
        score: submitted.outcome.report.score,
        revisions: submitted.session.revision,
      });
    }

    expect(results).toHaveLength(10);
    expect(results.every((result) => result.score === 100)).toBe(true);
    expect(new Set(results.map((result) => result.index)).size).toBe(10);
  });
});

class StressProvider implements StructuredModelProvider {
  constructor(private readonly responses: unknown[]) {}

  async invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error("stress response exhausted");
    return {
      value: request.schema.parse(response),
      model: request.tier === "pro" ? "mock-v4-pro" : "mock-v4-flash",
      usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 400 },
      rawResponse: { schema: request.schemaName },
    };
  }
}

function discoverRequiredEvidence(
  caseArtifact: typeof tutorialCase,
  initial: GameSession,
) {
  const actions = [
    ["tea", "化验茶水", "scene_study"],
    ["bookend", "检查黄铜书挡", "scene_study"],
    ["ledger", "翻找书桌抽屉", "scene_study"],
    ["paint", "核实沈岚的不在场证明", undefined],
    ["memo", "检查碎纸篓", "scene_study"],
    ["elevator", "查询货梯日志", "scene_security_room"],
    ["lock", "恢复门禁日志", "scene_security_room"],
  ] as const;
  const investigated = actions.reduce(
    (session, [suffix, text, sceneId]) =>
      performInvestigation(caseArtifact, session, {
        commandId: `stress_${initial.id}_${suffix}`,
        text,
        sceneId,
      }).session,
    initial,
  );
  const afterHousekeeper = recordDialogueTurn(caseArtifact, investigated, {
    commandId: `stress_${initial.id}_ask_housekeeper`,
    characterId: "character_luo_fang",
    playerText: "询问罗芳谁送了茶",
    response: {
      utterance: "李闻舟主动接过茶盘，说要替我送上二楼。",
      demeanor: "cooperative",
      disclosedClaimIds: ["claim_luo_tea"],
      memorySummary: "罗芳确认了茶盘被李闻舟接走的经过。",
      stateDelta: { trust: 4, pressure: 1, alertness: 0 },
    },
  });
  return recordDialogueTurn(caseArtifact, afterHousekeeper.session, {
    commandId: `stress_${initial.id}_ask_chen`,
    characterId: "character_chen_mo",
    playerText: "询问陈默案发时在哪里",
    response: {
      utterance: "我在诊所做医学直播，后台回放和观众互动记录都在。",
      demeanor: "guarded",
      disclosedClaimIds: ["claim_chen_alibi"],
      memorySummary: "陈默提供了案发时医学直播的回放链接。",
      stateDelta: { trust: 1, pressure: 2, alertness: 1 },
    },
  }).session;
}
