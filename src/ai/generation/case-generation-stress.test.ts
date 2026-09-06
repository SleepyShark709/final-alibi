import { describe, expect, it } from "vitest";

import type {
  StructuredModelProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "@/ai/model-provider";
import type { CaseArtifact } from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";
import {
  buildDeterministicDialogueShortcut,
  evidenceIsAvailable,
  getPlayerCaseView,
  performInvestigation,
  recordDialogueTurn,
  startGame,
  submitCaseReport,
  type GameSession,
} from "@/domain/game/game-runtime";

import { createCaseGenerationGraph } from "./case-generation-graph";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";
import { ScriptedBlindProtocol } from "./testing/scripted-blind-protocol";
import { scriptEvidenceReview } from "./testing/scripted-evidence-review";
import { buildEvidenceReviewBatches } from "./evidence-review-batches";
import { buildEvidenceReviewPlan } from "./evidence-review";

describe("generated case release gate stress", () => {
  it("publishes and completes ten consecutive constrained cases", async () => {
    const results: Array<{ index: number; score: number; revisions: number }> = [];

    for (let index = 1; index <= 10; index += 1) {
      const seed = `stress-seed-${index}`;
      const artifact = makeGeneratedCaseArtifact(
        `case_stress_${index}`,
        seed,
        `雨夜书房 · 压测卷 ${index}`,
      );
      const graph = createCaseGenerationGraph(
        new StressProvider([
          artifact,
          {
            culpritId: artifact.culpritId,
            evidenceIds: artifact.evidence.map((evidence) => evidence.id),
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
      expect(generated.modelCalls.map((call) => call.task)).toEqual(["case_draft", "opening_review", ...buildEvidenceReviewBatches(buildEvidenceReviewPlan(generated.finalArtifact!)).map(() => "evidence_review"), "blind_solve"]);
      const released = generated.finalArtifact!;
      expect(validatePublishableCaseArtifact(released).valid).toBe(true);
      expect(JSON.stringify(getPlayerCaseView(released, startGame(released)))).not.toMatch(
        /privateProfile|lieRules|culpritId/,
      );

      const investigated = discoverRequiredEvidence(
        released,
        startGame(released, { sessionId: `game_stress_${index}` }),
      );
      expect(investigated.discoveredEvidenceIds).toEqual(expect.arrayContaining(released.solution.requiredEvidenceIds));
      const requiredInterviewIds = released.evidence.filter((evidence) => released.solution.requiredEvidenceIds.includes(evidence.id) && evidence.discovery.method === "interview").map((evidence) => evidence.id);
      expect(investigated.dialogue.flatMap((exchange) => exchange.discoveredEvidenceIds)).toEqual(expect.arrayContaining(requiredInterviewIds));
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
  private readonly blindProtocol = new ScriptedBlindProtocol();
  constructor(private readonly responses: unknown[]) {}

  async invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    const scripted = request.schemaName === "case_opening_review" || request.schemaName === "case_evidence_review"
      ? { issues: [] }
      : this.responses.shift();
    const response = this.blindProtocol.reply(request, scriptEvidenceReview(request, scripted));
    if (response === undefined) throw new Error("stress response exhausted");
    return {
      value: request.schema.parse(response),
      model: request.tier === "pro" ? "mock-v4-pro" : "mock-v4-flash",
      usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 400 },
      rawResponse: { schema: request.schemaName },
    };
  }
}

function discoverRequiredEvidence(caseArtifact: CaseArtifact, initial: GameSession) {
  let session = initial;
  const pending = new Set(caseArtifact.evidence.map((evidence) => evidence.id));
  // 逆序尝试声明的路径，避免 fixture 的排列顺序掩盖真实前置关系。
  while (pending.size > 0) {
    let progress = false;
    for (const evidence of [...caseArtifact.evidence].reverse()) {
      if (!pending.has(evidence.id) || !evidenceIsAvailable(caseArtifact, session, evidence.id)) continue;
      const { discovery } = evidence;
      const commandId = `stress_${initial.id}_${evidence.id}`;
      if (discovery.method === "interview") {
        const playerText = discovery.dialogueAliases![0]!;
        const characterId = discovery.characterId!;
        const response = buildDeterministicDialogueShortcut(caseArtifact, session, characterId, playerText);
        expect(response, `declared interview ${evidence.id} must produce its testimony`).not.toBeNull();
        session = recordDialogueTurn(caseArtifact, session, { commandId, characterId, playerText, response: response! }).session;
      } else {
        session = performInvestigation(caseArtifact, session, {
          commandId,
          text: discovery.actionAliases[0]!,
          sceneId: discovery.sceneId,
          characterId: discovery.characterId,
        }).session;
      }
      expect(session.discoveredEvidenceIds, `declared path failed for ${evidence.id}`).toContain(evidence.id);
      pending.delete(evidence.id);
      progress = true;
    }
    expect(progress, `unreachable declared paths: ${[...pending].join(", ")}`).toBe(true);
  }
  return session;
}
