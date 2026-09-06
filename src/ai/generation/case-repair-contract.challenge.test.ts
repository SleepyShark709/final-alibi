import { describe, expect, it } from "vitest";

import { applyCaseArtifactRepairPatch, parseCaseArtifact, type CaseArtifactRepairPatch } from "@/domain/case/case-artifact";
import { validateCaseArtifact } from "@/domain/case/case-validator";

import { buildCaseRepairContract } from "./case-repair-contract";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";

describe("independent repair scope challenge", () => {
  it("allows a new solution fact and verification to update the culprit's knowledge and secrecy together", () => {
    const artifact = parseCaseArtifact(innCounterexample);
    const target = "evidence_zheng_testimony";
    const index = artifact.evidence.findIndex((evidence) => evidence.id === target);
    const culprit = artifact.characters.find((person) => person.id === artifact.culpritId)!;
    const factId = "fact_verified_weapon";
    const evidenceId = "evidence_verified_weapon";
    const patch: CaseArtifactRepairPatch = {
      evidence: [
        { id: target, supportsFactIds: [], critical: false },
        {
          id: evidenceId, name: "伤口与铜镇纸比对报告", kind: "document", critical: true,
          description: "检验人员比对已经取得的伤口记录和铜镇纸，确认三处创口与该镇纸撞击面吻合，反复打击造成致命损伤。",
          supportsFactIds: [factId], contradictsClaimIds: [], implicatesCharacterIds: [], excludesCharacterIds: [],
          discovery: { method: "analyze", actionAliases: ["比对伤口与镇纸"], prerequisiteEvidenceIds: ["evidence_body_wound", "evidence_paperweight"] },
        },
      ],
      facts: [{ id: factId, type: "method", statement: "受害者遭铜镇纸反复钝击致死。" }],
      solution: { methodFactId: factId, requiredEvidenceIds: [...artifact.solution.requiredEvidenceIds.filter((id) => id !== target), evidenceId] },
      characters: [{
        id: culprit.id,
        knowledge: { ...culprit.knowledge, factIds: [...culprit.knowledge.factIds, factId] },
        secretFactIds: [...culprit.secretFactIds, factId],
      }],
    };
    const repaired = applyCaseArtifactRepairPatch(artifact, patch);
    // 这是完整一致的修复路径，不能仅因为知识属于真凶而非原目标证人被窄协议封死。
    expect(validateCaseArtifact(repaired).issues).toEqual([]);
    const contract = buildCaseRepairContract(artifact, [{
      code: "evidence_narrative_mismatch", path: `evidence[${index}]`, message: "声响不能支持完整铜镇纸手法，须由实际核验材料承载。",
    }]);
    expect(contract.schema.safeParse(patch).success).toBe(true);
    expect(repaired.characters.find((person) => person.id === culprit.id)!.secretFactIds).toContain(factId);
  });
});
