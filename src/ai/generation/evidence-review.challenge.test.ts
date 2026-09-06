import { describe, expect, it } from "vitest";

import { parseCaseArtifact } from "@/domain/case/case-artifact";
import { claimCanBeDisclosed, performInvestigation, startGame } from "@/domain/game/game-runtime";

import { buildEvidenceReviewPlan } from "./evidence-review";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";

describe("independent evidence review boundaries", () => {
  it.each([
    "evidence_lin_testimony", "evidence_wang_testimony", "evidence_zhao_testimony",
    "evidence_sun_testimony", "evidence_zhou_testimony",
  ])("checks the natural entry of mandatory predecessor interview %s", (evidenceId) => {
    const artifact = parseCaseArtifact(innCounterexample);
    const plan = buildEvidenceReviewPlan(artifact);
    expect(plan.obligations).toContainEqual(expect.objectContaining({
      kind: "interview_lead", evidenceId,
    }));
  });

  it("allows an explicitly sourced public time window in the briefing", () => {
    const artifact = structuredClone(parseCaseArtifact(innCounterexample));
    artifact.briefing += "远程接线员确认18:28还在与老板视频通话，18:33赶到门口的住客已看到老板倒地且没有反应；实施窗口因此限定在18:28至18:33。";
    const plan = buildEvidenceReviewPlan(artifact);
    const briefing = plan.sources.find((source) => source.path === "briefing")!;
    const window = plan.obligations.find((item) => item.kind === "public_window")!;
    expect(briefing.text).toBe(artifact.briefing);
    expect(window.allowedSourceIds).toContain(briefing.id);
  });

  it("does not turn a secret claim unlocked after the target interview into its public entry clue", () => {
    const artifact = structuredClone(parseCaseArtifact(innCounterexample));
    const witness = artifact.characters.find((person) => person.id === "character_witness_1")!;
    const claim = artifact.claims.find((item) => item.id === "claim_wu_saw_lin")!;
    const secretFactId = "fact_after_wu_private_reference";
    artifact.facts.push({ id: secretFactId, type: "context", statement: "编号藏在访谈之后才能取得的文书中。" });
    witness.knowledge.factIds.push(secretFactId);
    witness.secretFactIds.push(secretFactId);
    claim.factIds = [secretFactId];
    claim.statement = "核对蓝色编号后才能说明当晚见闻。";
    artifact.evidence.push({
      id: "evidence_after_wu_private_reference", name: "访谈后的编号文书",
      description: "这份文书记载蓝色编号，但只能在吴的访谈之后调取。",
      kind: "document", supportsFactIds: [secretFactId], contradictsClaimIds: [],
      implicatesCharacterIds: [], excludesCharacterIds: [], critical: false,
      discovery: {
        method: "query", sceneId: "scene_study", actionAliases: ["查询编号文书"],
        prerequisiteEvidenceIds: ["evidence_wu_testimony"],
      },
    });
    const session = performInvestigation(artifact, startGame(artifact, { sessionId: "review_claim_boundary" }), {
      commandId: "inspect_wound", text: "查看伤口", sceneId: "scene_study",
    }).session;
    expect(claimCanBeDisclosed(artifact, session, witness.id, claim.id)).toBe(false);
    const plan = buildEvidenceReviewPlan(artifact);
    const entry = plan.obligations.find((item) => item.kind === "interview_lead" && item.evidenceId === "evidence_wu_testimony")!;
    const allowedTexts = plan.sources.filter((source) => entry.allowedSourceIds.includes(source.id)).map((source) => source.text);
    expect(allowedTexts).not.toContain(claim.statement);
  });
});
