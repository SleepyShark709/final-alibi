import { describe, expect, it } from "vitest";

import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";
import { findInitiallyDiscoverableSceneEvidenceIds } from "@/domain/case/evidence-reachability";

import {
  deriveGenerationPlan,
  validateGeneratedCharacterPlan,
  validateInitialScenePacing,
} from "./generation-plan";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";

const plans = [
  ["supporting-seed-0", 4, 2, 2, 0],
  ["supporting-seed-1", 3, 3, 2, 0],
  ["supporting-seed-2", 3, 3, 1, 1],
  ["supporting-seed-3", 5, 1, 1, 1],
  ["supporting-seed-11", 5, 3, 1, 1],
] as const;

describe("generation plan", () => {
  it.each(plans)("derives a stable cast and interview allocation for %s", (seed, suspects, witnesses, witnessInterviews, suspectInterviews) => {
    expect(deriveGenerationPlan(seed)).toEqual({
      suspectCount: suspects,
      supportingCharacterCount: witnesses,
      minimumWitnessInterviewCharacters: witnessInterviews,
      minimumSuspectInterviewCharacters: suspectInterviews,
    });
    expect(deriveGenerationPlan(seed)).toEqual(deriveGenerationPlan(seed));
  });

  it("always allocates a suspect interview when the cast has only one witness", () => {
    const seededPlans = Array.from({ length: 100 }, (_, index) => deriveGenerationPlan(`single-witness-${index}`));
    const singleWitnessPlans = seededPlans.filter((plan) => plan.supportingCharacterCount === 1);
    expect(singleWitnessPlans.length).toBeGreaterThan(0);
    expect(singleWitnessPlans.every((plan) => plan.minimumWitnessInterviewCharacters === 1 && plan.minimumSuspectInterviewCharacters === 1)).toBe(true);
  });

  it.each(plans)("provides a publishable fixture for %s without compiling its proof", (seed, suspects, witnesses) => {
    const draft = makeGeneratedCaseArtifact("case_valid_fixture", seed);
    expect(validatePublishableCaseArtifact(draft)).toEqual({ valid: true, issues: [] });
    expect(validateGeneratedCharacterPlan(draft, deriveGenerationPlan(seed))).toEqual([]);
    expect(validateInitialScenePacing(draft)).toEqual([]);
    expect(draft.characters.filter((character) => character.roleTier === "suspect")).toHaveLength(suspects);
    expect(draft.characters.filter((character) => character.roleTier === "witness")).toHaveLength(witnesses);
    expect(draft.characters.some((character) => character.roleTier === "referenced")).toBe(false);
    expect(draft.evidence.some((evidence) => evidence.discovery.prerequisiteEvidenceIds.length > 0)).toBe(true);
  });

  it("rejects the wrong seeded cast and referenced placeholders", () => {
    const seed = "supporting-seed-3";
    const draft = structuredClone(makeGeneratedCaseArtifact("case_wrong_cast", seed));
    draft.characters.find((character) => character.id === "character_qin_yu")!.roleTier = "referenced";
    expect(validateGeneratedCharacterPlan(draft, deriveGenerationPlan(seed)).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "seed_suspect_count_mismatch",
      "seed_supporting_character_count_mismatch",
    ]));
  });

  it("requires two distinct witness interview paths in the dual-witness plan", () => {
    const seed = "supporting-seed-0";
    const draft = structuredClone(makeGeneratedCaseArtifact("case_missing_witness_path", seed));
    draft.evidence.find((evidence) => evidence.id === "evidence_elevator_log")!.discovery.characterId = "character_luo_fang";
    expect(validateGeneratedCharacterPlan(draft, deriveGenerationPlan(seed))).toContainEqual(expect.objectContaining({
      code: "insufficient_supporting_interview_characters",
      path: "solution.requiredEvidenceIds",
    }));
  });

  it("requires a suspect interview in the mixed allocation", () => {
    const seed = "supporting-seed-3";
    const draft = structuredClone(makeGeneratedCaseArtifact("case_missing_suspect_path", seed));
    draft.evidence.find((evidence) => evidence.id === "evidence_livestream_record")!.discovery.characterId = "character_luo_fang";
    expect(validateGeneratedCharacterPlan(draft, deriveGenerationPlan(seed))).toContainEqual(expect.objectContaining({
      code: "insufficient_suspect_interview_characters",
      path: "solution.requiredEvidenceIds",
    }));
  });

  it.each(["unknown_claim", "withheld_claim", "empty_fact_claim", "unreachable_interview"])("rejects uninvolved characters with %s", (failure) => {
    const seed = "supporting-seed-2";
    const draft = structuredClone(makeGeneratedCaseArtifact("case_uninvolved_witness", seed));
    const witness = draft.characters.find((character) => character.id === "character_wu_yue")!;
    const claim = draft.claims.find((item) => item.id === "claim_wu_inventory")!;
    if (failure === "unknown_claim") witness.knowledge.claimIds = [];
    if (failure === "withheld_claim") claim.kind = "withheld";
    if (failure === "empty_fact_claim") claim.factIds = [];
    if (failure === "unreachable_interview") {
      witness.knowledge.claimIds = [];
      const interview = structuredClone(draft.evidence.find((evidence) => evidence.discovery.method === "interview")!);
      interview.id = "evidence_unreachable_interview";
      interview.discovery.characterId = witness.id;
      interview.discovery.prerequisiteEvidenceIds = [interview.id];
      draft.evidence.push(interview);
    }
    expect(validateGeneratedCharacterPlan(draft, deriveGenerationPlan(seed))).toContainEqual(expect.objectContaining({
      code: "uninvolved_interview_character",
      path: `characters[${draft.characters.indexOf(witness)}].knowledge`,
    }));
  });

  it("flags an initial scene that names or structurally points to a suspect", () => {
    const invalid = structuredClone(tutorialCase);
    const initial = invalid.evidence.find((item) => item.id === "evidence_broken_watch")!;
    initial.description = "腕表记录直接确认李闻舟进入书房。";
    initial.implicatesCharacterIds = [invalid.culpritId];
    initial.supportsFactIds = [invalid.solution.methodFactId];
    expect(validateInitialScenePacing(invalid).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "premature_initial_scene_suspect_link",
      "premature_initial_scene_sensitive_fact",
      "initial_scene_suspect_name_leak",
    ]));
  });

  it.each([
    "与死者有经济纠纷。",
    "此前向顾明远索讨分红。",
    "最近因顾明远拖欠尾款而反复催收。",
  ])("rejects hidden conflict in the initial public profile: %s", (publicProfile) => {
    const draft = structuredClone(makeGeneratedCaseArtifact("case_profile_leak", "supporting-seed-0"));
    draft.characters[1]!.publicProfile = publicProfile;
    expect(validateInitialScenePacing(draft)).toContainEqual(expect.objectContaining({
      code: "initial_profile_hidden_conflict",
      path: "characters[1].publicProfile",
    }));
  });

  it("does not treat a character interview as a scene clue available at startup", () => {
    const draft = structuredClone(tutorialCase);
    const openingScene = draft.scenes.find((scene) => scene.initiallyUnlocked)!;
    const interviewEvidence = draft.evidence.find((evidence) => evidence.discovery.method === "interview")!;
    interviewEvidence.discovery = { ...interviewEvidence.discovery, sceneId: openingScene.id, prerequisiteEvidenceIds: [] };
    expect(findInitiallyDiscoverableSceneEvidenceIds(draft).has(interviewEvidence.id)).toBe(false);
  });
});
