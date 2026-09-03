import { describe, expect, it } from "vitest";

import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { findInitiallyDiscoverableSceneEvidenceIds } from "@/domain/case/evidence-reachability";

import {
  deriveGenerationPlan,
  validateGeneratedCharacterPlan,
  validateInitialScenePacing,
} from "./generation-plan";

describe("generation plan", () => {
  it("derives a stable supporting-character count from the seed", () => {
    expect(
      [
        "supporting-seed-3",
        "supporting-seed-0",
        "supporting-seed-1",
      ].map((seed) => ({ seed, count: deriveGenerationPlan(seed).supportingCharacterCount })),
    ).toEqual([
      { seed: "supporting-seed-3", count: 2 },
      { seed: "supporting-seed-0", count: 3 },
      { seed: "supporting-seed-1", count: 4 },
    ]);
    expect(deriveGenerationPlan("supporting-seed-0")).toEqual(
      deriveGenerationPlan("supporting-seed-0"),
    );
  });

  it("requires the seeded supporting cast and two distinct witness interview paths", () => {
    const draft = structuredClone(tutorialCase);
    draft.seed = "supporting-seed-3";
    const secondWitnessEvidence = draft.evidence.find(
      (evidence) => evidence.id === "evidence_livestream_record",
    );
    if (!secondWitnessEvidence) {
      throw new Error("Tutorial interview evidence is missing");
    }
    secondWitnessEvidence.discovery = {
      ...secondWitnessEvidence.discovery,
      characterId: "character_han_zhuo",
    };

    expect(
      validateGeneratedCharacterPlan(draft, deriveGenerationPlan(draft.seed)),
    ).toEqual([]);

    const wrongCount = structuredClone(draft);
    wrongCount.seed = "supporting-seed-0";
    expect(
      validateGeneratedCharacterPlan(
        wrongCount,
        deriveGenerationPlan(wrongCount.seed),
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "seed_supporting_character_count_mismatch",
        path: "characters",
      }),
    );

    const repeatedWitness = structuredClone(draft);
    repeatedWitness.evidence = repeatedWitness.evidence.map((evidence) =>
      evidence.id === "evidence_livestream_record"
        ? {
            ...evidence,
            discovery: {
              ...evidence.discovery,
              characterId: "character_luo_fang",
            },
          }
        : evidence,
    );
    expect(
      validateGeneratedCharacterPlan(
        repeatedWitness,
        deriveGenerationPlan(repeatedWitness.seed),
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "insufficient_supporting_interview_characters",
        path: "solution.requiredEvidenceIds",
      }),
    );
  });

  it("flags an initial scene that names or structurally points to a suspect", () => {
    const issues = validateInitialScenePacing(tutorialCase);

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "premature_initial_scene_suspect_link",
        "premature_initial_scene_sensitive_fact",
        "initial_scene_suspect_name_leak",
      ]),
    );
  });

  it("does not treat a character interview as a scene clue available at startup", () => {
    const draft = structuredClone(tutorialCase);
    const openingScene = draft.scenes.find((scene) => scene.initiallyUnlocked);
    const interviewEvidence = draft.evidence.find(
      (evidence) => evidence.discovery.method === "interview",
    );
    if (!openingScene || !interviewEvidence) {
      throw new Error("Tutorial case needs an opening scene and interview evidence");
    }
    interviewEvidence.discovery = {
      ...interviewEvidence.discovery,
      sceneId: openingScene.id,
      prerequisiteEvidenceIds: [],
    };

    expect(
      findInitiallyDiscoverableSceneEvidenceIds(draft).has(interviewEvidence.id),
    ).toBe(false);
  });
});
