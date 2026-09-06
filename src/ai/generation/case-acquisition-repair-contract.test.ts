import { describe, expect, it } from "vitest";

import { applyCaseArtifactRepairPatch, parseCaseArtifact } from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";
import { solveCase } from "@/domain/case/case-solver";

import { buildCaseRepairContract, findAcquisitionRepairRegressions } from "./case-repair-contract";
import { deriveGenerationPlan, findInterviewContributionGaps, validateGeneratedCharacterPlan, validateInitialScenePacing } from "./generation-plan";
import { buildEvidenceReviewPlan, validateEvidenceReview } from "./evidence-review";
import { buildCaseRepairMessages } from "./generation-prompts";
import originalIsland from "./testing/fixtures/island-acquisition-route-counterexample.json";
import { makeSupportedEvidenceReview } from "./testing/scripted-evidence-review";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";

const island = parseCaseArtifact(originalIsland);
const issuesFor = (artifact = island) => [
  ...validatePublishableCaseArtifact(artifact).issues,
  ...validateGeneratedCharacterPlan(artifact, deriveGenerationPlan(artifact.seed)),
  ...validateInitialScenePacing(artifact),
];
const proof = (artifact = island) => artifact.evidence.map((item) => ({
  id: item.id, supports: item.supportsFactIds, contradicts: item.contradictsClaimIds,
  implicates: item.implicatesCharacterIds, excludes: item.excludesCharacterIds,
}));
const withExistingSuspectInterview = () => {
  const artifact = structuredClone(island);
  const interview = structuredClone(artifact.evidence.find((item) => item.discovery.method === "interview")!);
  interview.id = "evidence_existing_suspect_interview";
  interview.discovery.characterId = "character_suspect_2";
  interview.supportsFactIds = [];
  artifact.evidence.push(interview);
  return artifact;
};

describe("bounded acquisition route repair", () => {
  it("selects the mode for the actual island first draft and gives explicit immutable cast roles", () => {
    expect(solveCase(island).status).toBe("unique");
    const contract = buildCaseRepairContract(island, issuesFor());
    expect(contract.scope?.mode).toBe("acquisition");
    expect(contract.scope?.interviewRequirements).toEqual({
      suspectIds: ["character_suspect_1", "character_suspect_2", "character_suspect_3"],
      witnessIds: ["character_witness_1", "character_witness_2", "character_witness_3"],
      minimumSuspectCharacters: 1, minimumWitnessCharacters: 1,
    });
    expect(contract.scope?.requiredInterviewPrefix).toEqual([{
      roleTier: "suspect", candidates: expect.arrayContaining([{ characterId: "character_suspect_2", candidateEvidenceIds: ["evidence_observation_log"] }]),
    }]);
    const messages = buildCaseRepairMessages({ request: { seed: island.seed, theme: "气象站取得路线修复", difficulty: "standard" }, draft: island, issues: issuesFor(), repairScope: contract.scope });
    expect(JSON.parse(messages[1]!.content).repairScope.mode).toBe("acquisition");
    expect(messages[0]!.content).toContain("四种证明数组为空");
  });

  it("does not protect relations during semantic, cast or unresolved proof repairs", () => {
    const semantic = [...issuesFor(), { code: "evidence_narrative_mismatch", path: "evidence[4]", message: "本人未被核验。" }];
    expect(buildCaseRepairContract(island, semantic).scope?.mode).not.toBe("acquisition");
    const wrongCast = structuredClone(island);
    wrongCast.characters[2]!.roleTier = "witness";
    expect(buildCaseRepairContract(wrongCast, issuesFor()).scope?.mode).not.toBe("acquisition");
    const incomplete = structuredClone(island);
    incomplete.evidence.forEach((item) => { item.excludesCharacterIds = []; });
    expect(buildCaseRepairContract(incomplete, issuesFor()).scope?.mode).not.toBe("acquisition");
  });

  it("rejects deleting or copying proof arrays and changing truth or character identity", () => {
    const { schema } = buildCaseRepairContract(island, issuesFor());
    for (const key of ["supportsFactIds", "contradictsClaimIds", "implicatesCharacterIds", "excludesCharacterIds"]) {
      expect(schema.safeParse({ evidence: [{ id: "evidence_observation_log", [key]: [] }] }).success).toBe(false);
    }
    for (const patch of [
      { facts: [{ id: island.solution.methodFactId, statement: "重写手法" }] },
      { solution: { methodFactId: "fact_other" } },
      { characters: [{ id: "character_suspect_2", roleTier: "witness" }] },
      { removeCharacterIds: ["character_suspect_2"] },
    ]) expect(schema.safeParse(patch).success).toBe(false);
  });

  it("rejects no-op discovery copies and cosmetic or bookkeeping changes without an existing necessary route", () => {
    const { schema } = buildCaseRepairContract(island, issuesFor());
    const record = island.evidence.find((item) => item.id === "evidence_observation_log")!;
    for (const patch of [
      { evidence: [{ id: record.id, discovery: record.discovery }] },
      { evidence: [{ id: record.id, critical: true }] },
      { solution: { requiredEvidenceIds: island.solution.requiredEvidenceIds } },
      { evidence: [{ id: record.id, discovery: { actionAliases: ["新名称"], dialogueUtterance: "我可以提供证明。" } }] },
    ]) expect(schema.safeParse(patch).success).toBe(false);
  });

  it("can express a new suspect lead and real prerequisites while preserving the complete proof", () => {
    const contract = buildCaseRepairContract(island, issuesFor());
    const lead = structuredClone(island.evidence.find((item) => item.discovery.method === "interview")!);
    lead.id = "evidence_record_access_lead";
    lead.name = "观测员交付的记录索引";
    lead.description = "林小梅交付了观测和监控归档索引，可依编号调阅原始记录。";
    lead.supportsFactIds = []; lead.contradictsClaimIds = []; lead.implicatesCharacterIds = []; lead.excludesCharacterIds = [];
    lead.critical = true;
    lead.discovery = { method: "interview", characterId: "character_suspect_2", actionAliases: ["询问归档记录"], dialogueAliases: ["记录在哪里", "如何调阅原片", "你负责哪些记录"], dialogueUtterance: "这是我负责保管的归档索引，请按编号调阅原始记录。", prerequisiteEvidenceIds: [] };
    const pacedIds = new Set(issuesFor().flatMap((issue) => {
      const match = /^evidence\[(\d+)\]/.exec(issue.path);
      return match ? [island.evidence[Number(match[1])]!.id] : [];
    }));
    const witness = island.evidence.find((item) => item.id === "evidence_sighting_testimony")!;
    const motiveRecord = island.evidence.find((item) => item.id === "evidence_motive_document")!;
    const patch = contract.schema.parse({
      evidence: [lead, { id: witness.id, critical: true }, { id: motiveRecord.id, discovery: { prerequisiteEvidenceIds: [...motiveRecord.discovery.prerequisiteEvidenceIds, witness.id] } }, ...island.evidence.filter((item) => pacedIds.has(item.id)).map((item) => ({ id: item.id, discovery: { prerequisiteEvidenceIds: [...item.discovery.prerequisiteEvidenceIds, lead.id] } }))],
      solution: { requiredEvidenceIds: [...new Set([...island.solution.requiredEvidenceIds, lead.id, witness.id])] },
    });
    const repaired = applyCaseArtifactRepairPatch(island, patch);
    expect(proof(repaired).slice(0, island.evidence.length)).toEqual(proof());
    expect(repaired.facts).toEqual(island.facts);
    expect(repaired.culpritId).toBe(island.culpritId);
    expect(solveCase(repaired).status).toBe("unique");
    expect(issuesFor(repaired)).toEqual([]);
  });

  it("allows an unlock for a complete lead in the same patch but rejects unbound or unrelated targets", () => {
    const artifact = withExistingSuspectInterview();
    const unrelated = { ...structuredClone(artifact.evidence[0]!), id: "evidence_unrelated_record", supportsFactIds: [] };
    artifact.evidence.push(unrelated);
    const { schema } = buildCaseRepairContract(artifact, issuesFor(artifact));
    const lead = { ...structuredClone(artifact.evidence.find((item) => item.discovery.method === "interview")!), id: "evidence_new_delivery_lead", supportsFactIds: [], contradictsClaimIds: [], implicatesCharacterIds: [], excludesCharacterIds: [] };
    const rule = { id: "unlock_new_delivery_lead", targetType: "evidence", targetId: lead.id, allEvidenceIds: ["evidence_body_wound"], anyEvidenceIds: [] };
    expect(schema.safeParse({ evidence: [lead], unlockRules: [rule] }).success).toBe(true);
    expect(schema.safeParse({ unlockRules: [rule] }).success).toBe(false);
    expect(schema.safeParse({ evidence: [{ id: lead.id, description: "未完整定义的lead" }], unlockRules: [rule] }).success).toBe(false);
    expect(schema.safeParse({ evidence: [lead], unlockRules: [{ ...rule, targetId: unrelated.id }] }).success).toBe(false);
    expect(schema.safeParse({ evidence: [lead], unlockRules: [{ ...rule, targetType: "scene" }] }).success).toBe(false);
  });

  it("allows one update per related existing scene instead of a fixed four-scene cap", () => {
    const artifact = withExistingSuspectInterview();
    const { schema } = buildCaseRepairContract(artifact, issuesFor(artifact));
    const scenes = island.scenes.map((scene) => ({ id: scene.id, initiallyUnlocked: scene.id === "scene_machine_room" }));
    expect(scenes).toHaveLength(5);
    expect(schema.safeParse({ scenes }).success).toBe(true);
    expect(schema.safeParse({ scenes: [...scenes, scenes[0]] }).success).toBe(false);
    expect(schema.safeParse({ scenes: [...scenes.slice(0, 4), { id: "scene_unrelated", initiallyUnlocked: false }] }).success).toBe(false);
  });

  it("requires a missing tier's concrete contribution and allows its own record to be handed over", () => {
    const { schema } = buildCaseRepairContract(island, issuesFor());
    const record = island.evidence.find((item) => item.id === "evidence_observation_log")!;
    const contribution = {
      id: record.id, critical: true,
      discovery: { method: "interview", characterId: "character_suspect_2", dialogueAliases: ["观测记录在哪里", "你记录了什么", "可以给我原记录吗"], dialogueUtterance: `我交付原始观测记录。${record.description}` },
    };
    const solution = { requiredEvidenceIds: island.solution.requiredEvidenceIds };
    const patched = applyCaseArtifactRepairPatch(island, schema.parse({ evidence: [contribution], solution }));
    expect(proof(patched)).toEqual(proof());
    expect(validateGeneratedCharacterPlan(patched, deriveGenerationPlan(patched.seed)).map((issue) => issue.code)).not.toContain("insufficient_suspect_interview_characters");
    for (const change of [
      { critical: false },
      { discovery: { ...contribution.discovery, characterId: "character_witness_1" } },
      { discovery: { ...contribution.discovery, characterId: "character_suspect_1" } },
      { discovery: { ...contribution.discovery, dialogueAliases: ["问法一", "问法二"] } },
    ]) expect(schema.safeParse({ evidence: [{ ...contribution, ...change }], solution }).success).toBe(false);
    expect(schema.safeParse({ evidence: [contribution] }).success).toBe(false);
    expect(schema.safeParse({ evidence: [contribution], solution: { requiredEvidenceIds: [] } }).success).toBe(false);
    expect(schema.safeParse({ evidence: [contribution, { id: contribution.id, critical: false }], solution }).success).toBe(false);
  });

  it("does not force another interview when an existing one only needs its route repaired", () => {
    const artifact = withExistingSuspectInterview();
    const contract = buildCaseRepairContract(artifact, issuesFor(artifact));
    expect(contract.scope?.requiredInterviewPrefix).toEqual([]);
    expect(contract.schema.safeParse({ evidence: [{ id: "evidence_observation_log", discovery: { prerequisiteEvidenceIds: ["evidence_existing_suspect_interview"] } }] }).success).toBe(true);
  });

  it("exposes the actual bypass proof and existing interviews without inferring custody", () => {
    const gaps = findInterviewContributionGaps(island, deriveGenerationPlan(island.seed));
    const witnesses = gaps.find((gap) => gap.roleTier === "witness")!;
    expect(witnesses.existingInterviewEvidenceIds).toEqual(["evidence_footstep_testimony", "evidence_sighting_testimony", "evidence_argument_testimony"]);
    expect(witnesses.bypasses).toHaveLength(1);
    expect(witnesses.bypasses[0]!.retainedCharacterIds).toEqual([]);
    expect(witnesses.bypasses[0]!.proofEvidenceIds).toContain("evidence_corridor_camera");
    expect(witnesses.bypasses[0]!.proofEvidenceIds).not.toContain("evidence_sighting_testimony");
    expect(buildCaseRepairContract(island, issuesFor()).scope?.interviewContributionGaps).toEqual(gaps);
  });

  it("keeps real record-delivery review issues in route repair while excluding proof failures", () => {
    const artifact = withExistingSuspectInterview();
    const record = artifact.evidence.find((item) => item.id === "evidence_observation_log")!;
    record.discovery = { ...record.discovery, method: "interview", characterId: "character_suspect_2", dialogueAliases: ["记录本在哪里", "能给我记录本吗", "你保存哪些记录"], dialogueUtterance: "记录本可以调取。" };
    const plan = buildEvidenceReviewPlan(artifact);
    const obligation = plan.obligations.find((item) => item.kind === "record_delivery" && item.evidenceId === record.id)!;
    const review = makeSupportedEvidenceReview(plan);
    Object.assign(review.results.find((item) => item.obligationId === obligation.id)!, { verdict: "unsupported", reason: "只说可以调取，没有实际交付。" });
    const delivery = validateEvidenceReview(plan, review).find((issue) => issue.message.startsWith(`${record.id}: record_delivery;`))!;
    expect(delivery).toMatchObject({ code: "evidence_narrative_mismatch", path: "evidence[4]" });
    const contract = buildCaseRepairContract(artifact, [...issuesFor(artifact), delivery]);
    expect(contract.scope?.mode).toBe("acquisition");
    expect(contract.schema.safeParse({ evidence: [{ id: record.id, discovery: { dialogueUtterance: "我已经把此前的原始记录本交给你，现在可以核对其中记载。" } }] }).success).toBe(true);
    expect(contract.schema.safeParse({ evidence: [{ id: record.id, discovery: { dialogueUtterance: record.discovery.dialogueUtterance } }] }).success).toBe(false);
    expect(contract.schema.safeParse({ evidence: [{ id: "evidence_existing_suspect_interview", discovery: { dialogueUtterance: "只是重写无关旁支。" } }] }).success).toBe(false);
    for (const message of [
      `${record.id}: unsupported facts fact_alibi_2; 单点签名不等于本人全程在场；不是record_delivery问题。`,
      "evidence_dock_camera: record_delivery; 原文与交付不一致。",
    ]) expect(buildCaseRepairContract(artifact, [...issuesFor(artifact), { ...delivery, message }]).scope?.mode).not.toBe("acquisition");
  });

  it("rejects losing a previously established suspect contribution", () => {
    const before = makeGeneratedCaseArtifact("case_route_guard", "supporting-seed-2");
    const after = structuredClone(before);
    after.evidence.filter((item) => item.discovery.method === "interview" && after.characters.some((person) => person.id === item.discovery.characterId && person.roleTier === "suspect"))
      .forEach((item) => { item.discovery.method = "query"; });
    expect(findAcquisitionRepairRegressions(before, after).map((issue) => issue.code)).toContain("insufficient_suspect_interview_characters");
  });

  it("allows partial progress and compares existing blockers by entity identity across reordering", () => {
    const after = structuredClone(island);
    const record = after.evidence.find((item) => item.id === "evidence_observation_log")!;
    record.discovery = { ...record.discovery, method: "interview", characterId: "character_suspect_2", dialogueAliases: ["记录本在哪里", "能交给我记录本吗", "你保存哪些记录"], dialogueUtterance: `这是我交付的原始记录本。${record.description}` };
    expect(issuesFor(after).length).toBeGreaterThan(0);
    expect(issuesFor(after).length).toBeLessThan(issuesFor().length);
    expect(findAcquisitionRepairRegressions(island, after)).toEqual([]);
    after.evidence.reverse();
    after.characters.reverse();
    expect(findAcquisitionRepairRegressions(island, after)).toEqual([]);
  });
});
