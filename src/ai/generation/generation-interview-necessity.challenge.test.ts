import { describe, expect, it } from "vitest";

import { parseCaseArtifact } from "@/domain/case/case-artifact";
import { solveCase, solveCaseWithEvidenceIds } from "@/domain/case/case-solver";

import { deriveGenerationPlan, findInterviewContributionGaps, validateGeneratedCharacterPlan } from "./generation-plan";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";

function makeCase() {
  const artifact = structuredClone(parseCaseArtifact(innCounterexample));
  artifact.seed = "challenge-acquisition-42";
  return artifact;
}

function withoutRoleInterviews(artifact: ReturnType<typeof makeCase>, role: "suspect" | "witness", keepCharacterId?: string) {
  const ids = new Set(artifact.characters.filter((person) => person.roleTier === role && person.id !== keepCharacterId).map((person) => person.id));
  return { ...artifact, evidence: artifact.evidence.filter((item) => item.discovery.method !== "interview" || !ids.has(item.discovery.characterId!)) };
}

function removeSuspectPrerequisites(artifact: ReturnType<typeof makeCase>) {
  const ids = new Set(artifact.evidence.filter((item) => item.discovery.method === "interview" &&
    artifact.characters.some((person) => person.id === item.discovery.characterId && person.roleTier === "suspect")).map((item) => item.id));
  for (const evidence of artifact.evidence) evidence.discovery.prerequisiteEvidenceIds = evidence.discovery.prerequisiteEvidenceIds.filter((id) => !ids.has(id));
}

function codes(artifact: ReturnType<typeof makeCase>, minimumWitnessCharacters: 1 | 2 = 1) {
  return validateGeneratedCharacterPlan(artifact, {
    ...deriveGenerationPlan(artifact.seed), minimumWitnessInterviewCharacters: minimumWitnessCharacters,
  }).map((issue) => issue.code);
}

describe("independent necessary interview tiers challenge", () => {
  it("does not count a critical required suspect side branch when all suspect interviews can be skipped", () => {
    const artifact = makeCase();
    removeSuspectPrerequisites(artifact);
    const interview = artifact.evidence.find((item) => item.id === "evidence_wang_testimony")!;
    interview.critical = true;
    artifact.solution.requiredEvidenceIds.push(interview.id);
    expect(solveCase(artifact).status).toBe("unique");
    expect(solveCase(withoutRoleInterviews(artifact, "suspect")).status).toBe("unique");
    expect(codes(artifact)).toContain("insufficient_suspect_interview_characters");
    const gap = findInterviewContributionGaps(artifact, deriveGenerationPlan(artifact.seed)).find((item) => item.roleTier === "suspect")!;
    expect(gap.minimumCharacters).toBe(1);
    expect(gap.existingInterviewEvidenceIds).toContain(interview.id);
    expect(gap.bypasses).toHaveLength(1);
    expect(gap.bypasses[0]!.retainedCharacterIds).toEqual([]);
    expect(solveCaseWithEvidenceIds(withoutRoleInterviews(artifact, "suspect"), gap.bypasses[0]!.proofEvidenceIds).status).toBe("unique");
  });

  it("allows two interchangeable suspect sources when one suspect interview is genuinely necessary", () => {
    const artifact = makeCase();
    removeSuspectPrerequisites(artifact);
    const alternatives = ["evidence_wang_testimony", "evidence_zhao_testimony"];
    for (const id of alternatives) artifact.evidence.find((item) => item.id === id)!.critical = true;
    artifact.solution.requiredEvidenceIds.push(...alternatives);
    artifact.unlockRules.push({
      id: "unlock_record_from_either_suspect", targetType: "evidence", targetId: "evidence_kitchen_log",
      allEvidenceIds: [], anyEvidenceIds: alternatives,
    });
    expect(solveCase(artifact).status).toBe("unique");
    expect(solveCase(withoutRoleInterviews(artifact, "suspect")).status).not.toBe("unique");
    for (const characterId of ["character_suspect_2", "character_suspect_3"]) {
      expect(solveCase(withoutRoleInterviews(artifact, "suspect", characterId)).status).toBe("unique");
    }
    expect(codes(artifact)).not.toContain("insufficient_suspect_interview_characters");
    expect(findInterviewContributionGaps(artifact, deriveGenerationPlan(artifact.seed)).some((item) => item.roleTier === "suspect")).toBe(false);
  });

  it("allows alternative witness testimony for a one-witness requirement", () => {
    const artifact = makeCase();
    artifact.evidence.find((item) => item.id === "evidence_wu_testimony")!.supportsFactIds = [artifact.solution.methodFactId];
    expect(solveCase(withoutRoleInterviews(artifact, "witness")).status).not.toBe("unique");
    for (const characterId of ["character_witness_1", "character_witness_2"]) {
      expect(solveCase(withoutRoleInterviews(artifact, "witness", characterId)).status).toBe("unique");
    }
    expect(codes(artifact)).not.toContain("insufficient_supporting_interview_characters");
    expect(findInterviewContributionGaps(artifact, deriveGenerationPlan(artifact.seed)).some((item) => item.roleTier === "witness")).toBe(false);
  });

  it("does not claim two necessary witnesses when either witness alone already yields the full proof", () => {
    const artifact = makeCase();
    artifact.evidence.find((item) => item.id === "evidence_wu_testimony")!.supportsFactIds = [artifact.solution.methodFactId];
    expect(solveCase(artifact).status).toBe("unique");
    expect(codes(artifact, 2)).toContain("insufficient_supporting_interview_characters");
    const gap = findInterviewContributionGaps(artifact, { ...deriveGenerationPlan(artifact.seed), minimumWitnessInterviewCharacters: 2 })
      .find((item) => item.roleTier === "witness")!;
    expect(gap.bypasses).toHaveLength(2);
    for (const bypass of gap.bypasses) {
      expect(bypass.retainedCharacterIds).toHaveLength(1);
      expect(solveCaseWithEvidenceIds(withoutRoleInterviews(artifact, "witness", bypass.retainedCharacterIds[0]), bypass.proofEvidenceIds).status).toBe("unique");
    }
  });

  it("accepts two complementary witnesses when every one-witness route loses a required part of the proof", () => {
    const artifact = makeCase();
    artifact.evidence.find((item) => item.id === "evidence_lin_contract")!.supportsFactIds = [];
    artifact.evidence.find((item) => item.id === "evidence_wu_testimony")!.supportsFactIds = [artifact.solution.motiveFactId];
    expect(solveCase(artifact).status).toBe("unique");
    for (const characterId of ["character_witness_1", "character_witness_2"]) {
      expect(solveCase(withoutRoleInterviews(artifact, "witness", characterId)).status).not.toBe("unique");
    }
    expect(codes(artifact, 2)).not.toContain("insufficient_supporting_interview_characters");
    expect(findInterviewContributionGaps(artifact, { ...deriveGenerationPlan(artifact.seed), minimumWitnessInterviewCharacters: 2 }).some((item) => item.roleTier === "witness")).toBe(false);
  });

  it("does not mislabel an already broken complete proof as an interview-necessity defect", () => {
    const artifact = makeCase();
    removeSuspectPrerequisites(artifact);
    const interview = artifact.evidence.find((item) => item.id === "evidence_wang_testimony")!;
    interview.critical = true;
    artifact.solution.requiredEvidenceIds.push(interview.id);
    artifact.evidence.find((item) => item.id === "evidence_kitchen_log")!.excludesCharacterIds = [];
    expect(solveCase(artifact).status).not.toBe("unique");
    expect(codes(artifact)).not.toContain("insufficient_suspect_interview_characters");
    expect(findInterviewContributionGaps(artifact, deriveGenerationPlan(artifact.seed))).toEqual([]);
  });

  it("reports solver bypasses without turning knowledge of a record into custody or a new acquisition edge", () => {
    const artifact = makeCase();
    removeSuspectPrerequisites(artifact);
    const plan = deriveGenerationPlan(artifact.seed);
    const gaps = findInterviewContributionGaps(artifact, plan);
    const originalDiscovery = artifact.evidence.map((item) => item.discovery);
    for (const character of artifact.characters) character.knowledge.evidenceIds = artifact.evidence.map((item) => item.id);
    expect(findInterviewContributionGaps(artifact, plan)).toEqual(gaps);
    expect(artifact.evidence.map((item) => item.discovery)).toEqual(originalDiscovery);
    expect(Object.keys(gaps[0]!).sort()).toEqual(["bypasses", "existingInterviewEvidenceIds", "minimumCharacters", "roleTier"]);
  });
});
