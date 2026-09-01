import { describe, expect, it } from "vitest";

import { solveCase, solveCaseWithEvidenceIds } from "./case-solver";
import { makeValidCaseArtifact } from "./testing/make-valid-case-artifact";

describe("solveCase", () => {
  it("derives a unique culprit from discoverable evidence", () => {
    const result = solveCase(makeValidCaseArtifact());

    expect(result).toEqual({
      status: "unique",
      culpritId: "character_suspect_a",
      candidateIds: ["character_suspect_a"],
      evidenceIds: ["evidence_key"],
      supportedFactIds: ["fact_motive", "fact_method"],
    });
  });

  it("can audit the declared evidence chain independently of all reachable evidence", () => {
    const result = solveCaseWithEvidenceIds(makeValidCaseArtifact(), []);

    expect(result).toMatchObject({
      status: "ambiguous",
      culpritId: null,
      candidateIds: [
        "character_suspect_a",
        "character_suspect_b",
        "character_suspect_c",
        "character_suspect_d",
      ],
    });
  });
});
