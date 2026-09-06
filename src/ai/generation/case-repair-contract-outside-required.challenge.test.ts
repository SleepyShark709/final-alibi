import { describe, expect, it } from "vitest";

import { applyCaseArtifactRepairPatch, parseCaseArtifact } from "@/domain/case/case-artifact";
import { solveCaseWithEvidenceIds } from "@/domain/case/case-solver";

import { buildCaseRepairContract } from "./case-repair-contract";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";

const chainIssue = {
  code: "insufficient_required_evidence_chain", path: "solution.requiredEvidenceIds",
  message: "必需证据仍无法排除一名嫌疑人，完整账本已有排除关系但未纳入必需链。",
};

function makeOutsideRequiredCase() {
  const artifact = structuredClone(parseCaseArtifact(innCounterexample));
  const original = artifact.evidence.find((item) => item.id === "evidence_kitchen_log")!;
  const verification = structuredClone(original);
  verification.id = "record_existing_identity_verification";
  verification.discovery.prerequisiteEvidenceIds = [original.id];
  original.supportsFactIds = [];
  original.excludesCharacterIds = [];
  const unrelated = structuredClone(artifact.evidence.find((item) => item.id === "evidence_locked_phone")!);
  unrelated.id = "record_unrelated_inventory";
  artifact.evidence.push(verification, unrelated);
  return { artifact, original, verification, unrelated };
}

describe("independent outside-required repair scope challenge", () => {
  it("admits an already existing omitted verification, its fact, person and genuine prerequisite for one repair", () => {
    const { artifact, original, verification } = makeOutsideRequiredCase();
    const person = artifact.characters.find((item) => item.id === "character_suspect_2")!;
    const fact = artifact.facts.find((item) => item.id === "fact_alibi_wang")!;
    expect(solveCaseWithEvidenceIds(artifact, artifact.solution.requiredEvidenceIds).candidateIds)
      .toEqual([artifact.culpritId, person.id]);
    const contract = buildCaseRepairContract(artifact, [chainIssue]);
    expect(contract.scope!.existingEvidenceIds).toEqual(expect.arrayContaining([
      verification.id, original.id, "evidence_wang_testimony",
    ]));
    expect(contract.scope!.existingFactIds).toContain(fact.id);
    expect(contract.scope!.characterIds).toContain(person.id);
    const patch = contract.schema.parse({
      evidence: [{ id: verification.id, description: verification.description }],
      facts: [{ id: fact.id, statement: fact.statement }],
      characters: [{ id: person.id, knowledge: person.knowledge }],
      solution: { requiredEvidenceIds: [...artifact.solution.requiredEvidenceIds, verification.id] },
    });
    const result = applyCaseArtifactRepairPatch(artifact, patch);
    // 此处只证明账本修复通道可用；原文的本人/连续在场仍须独立语义审核。
    expect(solveCaseWithEvidenceIds(result, result.solution.requiredEvidenceIds).status).toBe("unique");
  });

  it("keeps unrelated known ids forbidden even when disguised as complete new evidence", () => {
    const { artifact, unrelated } = makeOutsideRequiredCase();
    const contract = buildCaseRepairContract(artifact, [chainIssue]);
    expect(contract.scope!.existingEvidenceIds).not.toContain(unrelated.id);
    expect(contract.schema.safeParse({ evidence: [{ id: unrelated.id, description: "无关材料被重写。" }] }).success).toBe(false);
    expect(contract.schema.safeParse({ evidence: [unrelated] }).success).toBe(false);
  });

  it("allows a complete verification with an arbitrary fresh legal id while rejecting incomplete additions", () => {
    const { artifact, verification } = makeOutsideRequiredCase();
    const contract = buildCaseRepairContract(artifact, [chainIssue]);
    const addition = { ...verification, id: "record_independent_comparison" };
    expect(contract.schema.safeParse({
      evidence: [addition],
      solution: { requiredEvidenceIds: [...artifact.solution.requiredEvidenceIds, addition.id] },
    }).success).toBe(true);
    expect(contract.schema.safeParse({ evidence: [{ id: addition.id, description: addition.description }] }).success).toBe(false);
  });

  it("does not expand an unrelated local evidence issue into all omitted exclusions", () => {
    const { artifact, verification } = makeOutsideRequiredCase();
    const index = artifact.evidence.findIndex((item) => item.id === "evidence_body_wound");
    const contract = buildCaseRepairContract(artifact, [{
      code: "evidence_narrative_mismatch", path: `evidence[${index}]`, message: "原检查文字不够明确。",
    }]);
    expect(contract.scope!.existingEvidenceIds).not.toContain(verification.id);
    expect(contract.schema.safeParse({ evidence: [{ id: verification.id, description: verification.description }] }).success).toBe(false);
  });
});
