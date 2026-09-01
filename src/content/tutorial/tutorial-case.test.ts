import { describe, expect, it } from "vitest";

import { solveCase } from "@/domain/case/case-solver";
import { validateCaseArtifact } from "@/domain/case/case-validator";

import { tutorialCase } from "./tutorial-case";

describe("tutorialCase", () => {
  it("is a valid, uniquely solvable seven-character case", () => {
    const validation = validateCaseArtifact(tutorialCase);
    const solution = solveCase(tutorialCase);

    expect({
      validation,
      solutionStatus: solution.status,
      culpritId: solution.culpritId,
      characterCount: tutorialCase.characters.length,
      suspectCount: tutorialCase.characters.filter(
        (character) => character.roleTier === "suspect",
      ).length,
      sceneCount: tutorialCase.scenes.length,
      evidenceCount: tutorialCase.evidence.length,
    }).toEqual({
      validation: { valid: true, issues: [] },
      solutionStatus: "unique",
      culpritId: "character_li_wenzhou",
      characterCount: 7,
      suspectCount: 4,
      sceneCount: 3,
      evidenceCount: 11,
    });
  });
});
