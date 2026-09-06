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

  it("combines independent method evidence with identity and exclusion evidence", () => {
    const artifact = structuredClone(makeValidCaseArtifact());
    const identityEvidence = artifact.evidence[0]!;
    identityEvidence.supportsFactIds = ["fact_motive"];
    artifact.evidence.push({
      ...structuredClone(identityEvidence),
      id: "evidence_method",
      name: "凶器检验",
      description: "检验确定手法，但不能单独确定使用者。",
      supportsFactIds: ["fact_method"],
      implicatesCharacterIds: [],
      excludesCharacterIds: [],
    });
    expect(solveCase(artifact)).toMatchObject({
      status: "unique", evidenceIds: ["evidence_key", "evidence_method"],
    });
    expect(solveCaseWithEvidenceIds(artifact, ["evidence_key"]).status).toBe("unsupported");
  });

  it("cannot substitute an unrelated motive for the declared motive", () => {
    const artifact = structuredClone(makeValidCaseArtifact());
    artifact.facts.push({ id: "fact_other_motive", type: "motive", statement: "另一人的经济纠纷。" });
    artifact.evidence[0]!.supportsFactIds = ["fact_other_motive", "fact_method"];
    expect(solveCase(artifact).status).toBe("unsupported");
  });

  it("cannot use a supported context fact as both motive and method", () => {
    const artifact = structuredClone(makeValidCaseArtifact());
    artifact.facts.push({ id: "fact_time", type: "context", statement: "案发在晚上。" });
    artifact.solution.motiveFactId = "fact_time";
    artifact.solution.methodFactId = "fact_time";
    artifact.evidence[0]!.supportsFactIds = ["fact_time"];
    expect(solveCase(artifact).status).toBe("unsupported");
  });
});
