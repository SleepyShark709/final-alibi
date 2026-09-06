import { describe, expect, it } from "vitest";
import { z } from "zod";

import { applyCaseArtifactRepairPatch, parseCaseArtifact } from "@/domain/case/case-artifact";
import { solveCase } from "@/domain/case/case-solver";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";

import { buildCaseRepairContract } from "./case-repair-contract";
import { deriveGenerationPlan, validateGeneratedCharacterPlan, validateInitialScenePacing } from "./generation-plan";
import islandCounterexample from "./testing/fixtures/island-acquisition-route-counterexample.json";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";

const original = parseCaseArtifact(islandCounterexample);
const suspectId = "character_suspect_2";
const recordId = "evidence_observation_log";
const leadId = "lead_observation_original_delivery";

function contractForOriginal() {
  return buildCaseRepairContract(original, [
    ...validatePublishableCaseArtifact(original).issues,
    ...validateGeneratedCharacterPlan(original, deriveGenerationPlan(original.seed)),
    ...validateInitialScenePacing(original),
  ]);
}

function existingDelivery() {
  return {
    evidence: [{ id: recordId, critical: true, discovery: {
      method: "interview" as const, characterId: suspectId,
      dialogueAliases: ["你保留的观测记录在哪", "可以交付观测记录吗", "我想核对你提到的记录本"],
      dialogueUtterance: "这是我已经交给你的原始观测记录，可以直接核对其中的记载。",
    } }],
    solution: { requiredEvidenceIds: [...original.solution.requiredEvidenceIds] },
  };
}

function freshDeliveryRoute() {
  const template = original.evidence.find((item) => item.id === "evidence_footstep_testimony")!;
  const lead = {
    ...structuredClone(template), id: leadId, name: "观测记录的交付说明",
    description: "林小梅交付她已提到的原始观测记录，后续记录按此次移交编号归档。",
    supportsFactIds: [], contradictsClaimIds: [], implicatesCharacterIds: [], excludesCharacterIds: [], critical: true,
    discovery: { ...existingDelivery().evidence[0]!.discovery, actionAliases: ["交付观测记录"], prerequisiteEvidenceIds: [] },
  };
  return {
    evidence: [lead, { id: recordId, discovery: { prerequisiteEvidenceIds: [leadId] } }],
    solution: { requiredEvidenceIds: [...original.solution.requiredEvidenceIds, leadId] },
  };
}

describe("independent required-interview binding challenge", () => {
  it("binds an absent required tier to per-character existing knowledge instead of two independent id enums", () => {
    const { scope } = contractForOriginal();
    expect(scope!.requiredInterviewPrefix).toHaveLength(1);
    expect(scope!.requiredInterviewPrefix![0]!.roleTier).toBe("suspect");
    const candidates = scope!.requiredInterviewPrefix![0]!.candidates;
    expect(candidates.find((item) => item.characterId === suspectId)?.candidateEvidenceIds).toEqual([recordId]);
    expect(candidates.find((item) => item.characterId === "character_suspect_1")?.candidateEvidenceIds).not.toContain(recordId);
  });

  it("expresses an existing known record as actual suspect delivery without changing its body or proof", () => {
    const patch = contractForOriginal().schema.parse(existingDelivery());
    const repaired = applyCaseArtifactRepairPatch(original, patch);
    const before = original.evidence.find((item) => item.id === recordId)!;
    const after = repaired.evidence.find((item) => item.id === recordId)!;
    expect(after.description).toBe(before.description);
    expect(after.supportsFactIds).toEqual(before.supportsFactIds);
    expect(after.excludesCharacterIds).toEqual(before.excludesCharacterIds);
    expect(repaired.facts).toEqual(original.facts);
    expect(solveCase(repaired).status).toBe("unique");
    expect(validateGeneratedCharacterPlan(repaired, deriveGenerationPlan(repaired.seed)).map((issue) => issue.code))
      .not.toContain("insufficient_suspect_interview_characters");
  });

  it("expresses a fresh empty-relation delivery lead followed by the unchanged original record", () => {
    const repaired = applyCaseArtifactRepairPatch(original, contractForOriginal().schema.parse(freshDeliveryRoute()));
    const source = repaired.evidence.find((item) => item.id === recordId)!;
    expect(source.description).toBe(original.evidence.find((item) => item.id === recordId)!.description);
    expect(source.discovery.prerequisiteEvidenceIds).toEqual([leadId]);
    expect(solveCase(repaired).status).toBe("unique");
    expect(validateGeneratedCharacterPlan(repaired, deriveGenerationPlan(repaired.seed)).map((issue) => issue.code))
      .not.toContain("insufficient_suspect_interview_characters");
  });

  it.each(["character_suspect_1", "character_witness_3", "character_unknown"])("rejects assigning Lin's existing record to %s", (characterId) => {
    const patch = existingDelivery();
    patch.evidence[0]!.discovery.characterId = characterId;
    expect(contractForOriginal().schema.safeParse(patch).success).toBe(false);
  });

  it.each(["evidence_toolbox", "evidence_unregistered_record"])("rejects an unrelated or undeclared existing-record update: %s", (id) => {
    const patch = existingDelivery();
    patch.evidence[0]!.id = id;
    expect(contractForOriginal().schema.safeParse(patch).success).toBe(false);
  });

  it("requires the missing-tier task, three question aliases, a critical label and inclusion in required evidence", () => {
    const contract = contractForOriginal();
    expect(contract.schema.safeParse({ evidence: [{ id: recordId, discovery: { prerequisiteEvidenceIds: ["evidence_footstep_testimony"] } }] }).success).toBe(false);
    const twoAliases = existingDelivery();
    twoAliases.evidence[0]!.discovery.dialogueAliases.pop();
    expect(contract.schema.safeParse(twoAliases).success).toBe(false);
    const optional = existingDelivery();
    optional.evidence[0]!.critical = false;
    expect(contract.schema.safeParse(optional).success).toBe(false);
    const unlisted = existingDelivery();
    unlisted.solution.requiredEvidenceIds = unlisted.solution.requiredEvidenceIds.filter((id) => id !== recordId);
    expect(contract.schema.safeParse(unlisted).success).toBe(false);
  });

  it("exposes the compulsory prefix and coupled character-record alternatives in the JSON schema sent to the provider", () => {
    const schema = z.toJSONSchema(contractForOriginal().schema);
    expect(schema.required).toEqual(expect.arrayContaining(["evidence", "solution"]));
    const evidence = schema.properties!.evidence as {
      minItems: number;
      prefixItems: Array<{ anyOf: Array<{ properties: {
        id: { enum?: string[] };
        critical: { const: boolean };
        discovery: { properties: { characterId: { const: string }; method: { const: string }; dialogueAliases: { minItems: number } } };
      } }> }>;
    };
    expect(evidence.minItems).toBe(1);
    expect(evidence.prefixItems).toHaveLength(1);
    const branches = evidence.prefixItems[0]!.anyOf;
    const originalRecordBranch = branches.find((branch) => branch.properties.id.enum?.includes(recordId))!;
    expect(originalRecordBranch.properties.discovery.properties.characterId.const).toBe(suspectId);
    expect(originalRecordBranch.properties.discovery.properties.method.const).toBe("interview");
    expect(originalRecordBranch.properties.discovery.properties.dialogueAliases.minItems).toBe(3);
    expect(originalRecordBranch.properties.critical.const).toBe(true);
    expect(branches.filter((branch) => branch.properties.id.enum?.includes(recordId))).toHaveLength(1);
  });

  it("does not allow a later duplicate id to undo the compulsory contribution", () => {
    const patch = existingDelivery();
    expect(contractForOriginal().schema.safeParse({
      ...patch, evidence: [...patch.evidence, { id: recordId, critical: false }],
    }).success).toBe(false);
  });

  it("still rejects a required-label side branch through the shared actual-contribution gate", () => {
    const patch = freshDeliveryRoute();
    patch.evidence = patch.evidence.slice(0, 1);
    const repaired = applyCaseArtifactRepairPatch(original, contractForOriginal().schema.parse(patch));
    expect(validateGeneratedCharacterPlan(repaired, deriveGenerationPlan(repaired.seed)).map((issue) => issue.code))
      .toContain("insufficient_suspect_interview_characters");
  });

  it("allows all five related existing scenes, while rejecting excess entries and unrelated ids", () => {
    const contract = contractForOriginal();
    const patch = { ...existingDelivery(), scenes: original.scenes.map((scene) => ({ id: scene.id, initiallyUnlocked: scene.initiallyUnlocked })) };
    expect(patch.scenes).toHaveLength(5);
    expect(contract.schema.safeParse(patch).success).toBe(true);
    expect(contract.schema.safeParse({ ...patch, scenes: [...patch.scenes, patch.scenes[0]] }).success).toBe(false);
    expect(contract.schema.safeParse({ ...patch, scenes: [{ id: "scene_unrelated", initiallyUnlocked: true }] }).success).toBe(false);
  });

  it("does not demand a fresh prefix when the tier already has interviews whose routes need repair", () => {
    const draft = structuredClone(parseCaseArtifact(innCounterexample));
    draft.seed = "challenge-acquisition-42";
    const { scope } = buildCaseRepairContract(draft, [{
      code: "insufficient_suspect_interview_characters", path: "solution.requiredEvidenceIds", message: "已有嫌疑人访谈需要成为真实取得路线。",
    }]);
    expect(scope?.mode).toBe("acquisition");
    expect(scope!.requiredInterviewPrefix ?? []).toEqual([]);
  });
});
