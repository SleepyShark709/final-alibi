import { describe, expect, it } from "vitest";

import { applyCaseArtifactRepairPatch, parseCaseArtifact } from "@/domain/case/case-artifact";
import { solveCase } from "@/domain/case/case-solver";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";

import { buildCaseRepairContract } from "./case-repair-contract";
import { deriveGenerationPlan, validateGeneratedCharacterPlan, validateInitialScenePacing } from "./generation-plan";
import { buildCaseRepairMessages } from "./generation-prompts";
import innCounterexample from "./testing/fixtures/inn-evidence-review-counterexample.json";
import islandCounterexample from "./testing/fixtures/island-acquisition-route-counterexample.json";

const interviewIssue = {
  code: "insufficient_suspect_interview_characters", path: "solution.requiredEvidenceIds",
  message: "expected critical interview evidence from at least 1 suspect in the required solution chain",
};

function makeRouteCase() {
  const artifact = structuredClone(parseCaseArtifact(innCounterexample));
  artifact.seed = "challenge-acquisition-42";
  // 保持完整证明关系，将嫌疑人访谈从核验前置移除，构造确实缺取得路线的状态。
  const suspectInterviews = new Set(artifact.evidence.filter((item) => item.discovery.method === "interview" &&
    artifact.characters.some((person) => person.id === item.discovery.characterId && person.roleTier === "suspect")).map((item) => item.id));
  for (const item of artifact.evidence) {
    item.discovery.prerequisiteEvidenceIds = item.discovery.prerequisiteEvidenceIds.filter((id) => !suspectInterviews.has(id));
  }
  return artifact;
}

function addRealRoute(artifact: ReturnType<typeof makeRouteCase>) {
  const source = artifact.evidence.find((item) => item.id === "evidence_wang_testimony")!;
  const lead = structuredClone(source);
  lead.id = "lead_kitchen_original_record";
  lead.name = "厨房核验记录的调取说明";
  lead.description = "王交代厨房原始记录的保存位置，并当场交付相应调取编号。";
  lead.critical = true;
  lead.discovery.dialogueUtterance = "厨房当班记录保存在后台终端，我把原始记录的调取编号交给你了，可以按编号核验。";
  return {
    evidence: [lead, { id: "evidence_kitchen_log", discovery: { prerequisiteEvidenceIds: [lead.id] } }],
    solution: { requiredEvidenceIds: [...artifact.solution.requiredEvidenceIds, lead.id] },
  };
}

describe("independent acquisition repair challenge", () => {
  it("selects route repair only after cast and the complete existing proof are established", () => {
    const artifact = makeRouteCase();
    expect(deriveGenerationPlan(artifact.seed)).toMatchObject({ suspectCount: 5, supportingCharacterCount: 2, minimumSuspectInterviewCharacters: 1 });
    expect(solveCase(artifact).status).toBe("unique");
    const { scope } = buildCaseRepairContract(artifact, [interviewIssue]);
    expect(scope?.mode).toBe("acquisition");
    expect(scope?.interviewRequirements?.suspectIds).toContain("character_suspect_2");
    expect(scope?.interviewRequirements?.minimumSuspectCharacters).toBe(1);
  });

  it("gives the actual failed island draft its exact defer list without inheriting conflicting proof repair instructions", () => {
    const artifact = parseCaseArtifact(islandCounterexample);
    const issues = [
      ...validatePublishableCaseArtifact(artifact).issues,
      ...validateGeneratedCharacterPlan(artifact, deriveGenerationPlan(artifact.seed)),
      ...validateInitialScenePacing(artifact),
    ];
    const contract = buildCaseRepairContract(artifact, issues);
    expect(contract.scope!.deferEvidenceIds).toEqual([
      "evidence_phone_lock", "evidence_work_log", "evidence_observation_log", "evidence_corridor_camera", "evidence_dock_camera",
    ]);
    const messages = buildCaseRepairMessages({
      request: { seed: artifact.seed, theme: artifact.title, difficulty: "standard" },
      draft: artifact, issues, repairScope: contract.scope,
    });
    expect(JSON.parse(messages[1]!.content).repairScope).toEqual(contract.scope);
    expect(messages[0]!.content).toContain("deferEvidenceIds");
    expect(messages[0]!.content).not.toContain("你是案件局部修复器");
    expect(messages[0]!.content).not.toContain("公开窗口过宽时");
    expect(messages[0]!.content).not.toContain("将所需排除关系放在");
  });

  it("admits a new delivered lead and a real prerequisite while preserving all original proof relations", () => {
    const artifact = makeRouteCase();
    const contract = buildCaseRepairContract(artifact, [interviewIssue]);
    const patch = contract.schema.parse(addRealRoute(artifact));
    const repaired = applyCaseArtifactRepairPatch(artifact, patch);
    expect(repaired.facts).toEqual(artifact.facts);
    for (const original of artifact.evidence) {
      const item = repaired.evidence.find((evidence) => evidence.id === original.id)!;
      expect([item.supportsFactIds, item.excludesCharacterIds, item.implicatesCharacterIds, item.contradictsClaimIds])
        .toEqual([original.supportsFactIds, original.excludesCharacterIds, original.implicatesCharacterIds, original.contradictsClaimIds]);
    }
    expect(solveCase(repaired).status).toBe("unique");
    expect(validateGeneratedCharacterPlan(repaired, deriveGenerationPlan(repaired.seed)).map((issue) => issue.code))
      .not.toContain("insufficient_suspect_interview_characters");
  });

  it("can change a related scene's initial accessibility without overwriting the scene or its objects", () => {
    const artifact = makeRouteCase();
    const contract = buildCaseRepairContract(artifact, [interviewIssue]);
    const scene = artifact.scenes.find((candidate) => candidate.initiallyUnlocked &&
      candidate.objects.some((object) => object.evidenceIds.some((id) => contract.scope!.existingEvidenceIds.includes(id))))!;
    const patch = contract.schema.parse({ scenes: [{ id: scene.id, initiallyUnlocked: false }] });
    const updated = applyCaseArtifactRepairPatch(artifact, patch).scenes.find((candidate) => candidate.id === scene.id)!;
    expect(updated).toEqual({ ...scene, initiallyUnlocked: false });
    expect(contract.schema.safeParse({ scenes: [{ id: scene.id, initiallyUnlocked: false, description: "任意重写整个场景。" }] }).success).toBe(false);
  });

  it.each(["supportsFactIds", "excludesCharacterIds", "implicatesCharacterIds", "contradictsClaimIds"] as const)("rejects changing existing %s even alongside a legitimate route change", (field) => {
    const artifact = makeRouteCase();
    const patch = addRealRoute(artifact);
    patch.evidence[1] = { ...patch.evidence[1]!, [field]: [] };
    expect(buildCaseRepairContract(artifact, [interviewIssue]).schema.safeParse(patch).success).toBe(false);
  });

  it("keeps truth facts, culprit identity and method targets outside route repair", () => {
    const artifact = makeRouteCase();
    const contract = buildCaseRepairContract(artifact, [interviewIssue]);
    const route = addRealRoute(artifact);
    expect(contract.schema.safeParse({ ...route, facts: [{ id: artifact.solution.methodFactId, statement: "篡改真相方法。" }] }).success).toBe(false);
    expect(contract.schema.safeParse({ ...route, solution: { ...route.solution, methodFactId: artifact.solution.motiveFactId } }).success).toBe(false);
    expect(contract.schema.safeParse({ ...route, characters: [{ id: artifact.culpritId, name: "任意替换身份" }] }).success).toBe(false);
    const strengthenedLead = structuredClone(route);
    strengthenedLead.evidence[0] = { ...strengthenedLead.evidence[0]!, supportsFactIds: [artifact.solution.methodFactId] };
    expect(contract.schema.safeParse(strengthenedLead).success).toBe(false);
  });

  it("accepts an unlock for a complete lead created in the same patch", () => {
    const artifact = makeRouteCase();
    const route = addRealRoute(artifact);
    const contract = buildCaseRepairContract(artifact, [interviewIssue]);
    expect(contract.schema.safeParse({ ...route, unlockRules: [{
      id: "unlock_added_lead", targetType: "evidence", targetId: route.evidence[0]!.id,
      allEvidenceIds: ["evidence_body_wound"], anyEvidenceIds: [],
    }] }).success).toBe(true);
  });

  it("rejects undefined and unrelated existing unlock targets even when a valid new lead is present", () => {
    const artifact = makeRouteCase();
    const unrelated = { ...structuredClone(artifact.evidence[0]!), id: "record_unrelated_unlock_target" };
    artifact.evidence.push(unrelated);
    const route = addRealRoute(artifact);
    const contract = buildCaseRepairContract(artifact, [interviewIssue]);
    expect(contract.scope!.existingEvidenceIds).not.toContain(unrelated.id);
    for (const targetId of [unrelated.id, "lead_never_created"]) {
      expect(contract.schema.safeParse({ ...route, unlockRules: [{
        id: "unlock_invalid_target", targetType: "evidence", targetId,
        allEvidenceIds: ["evidence_body_wound"], anyEvidenceIds: [],
      }] }).success, targetId).toBe(false);
    }
  });

  it.each(["scene", "character"] as const)("does not let a same-patch lead impersonate a %s unlock target", (targetType) => {
    const artifact = makeRouteCase();
    const route = addRealRoute(artifact);
    expect(buildCaseRepairContract(artifact, [interviewIssue]).schema.safeParse({ ...route, unlockRules: [{
      id: "unlock_wrong_entity_type", targetType, targetId: route.evidence[0]!.id,
      allEvidenceIds: ["evidence_body_wound"], anyEvidenceIds: [],
    }] }).success).toBe(false);
  });

  it("does not accept critical flags, required ids, or an unchanged discovery object as new acquisition work", () => {
    const artifact = makeRouteCase();
    const contract = buildCaseRepairContract(artifact, [interviewIssue]);
    const interview = artifact.evidence.find((item) => item.id === "evidence_wang_testimony")!;
    expect(contract.schema.safeParse({
      evidence: [{ id: interview.id, critical: true }],
      solution: { requiredEvidenceIds: [...artifact.solution.requiredEvidenceIds, interview.id] },
    }).success).toBe(false);
    expect(contract.schema.safeParse({ evidence: [{ id: interview.id, discovery: interview.discovery }] }).success).toBe(false);
  });

  it("permits recording an already indispensable suspect interview that was only omitted from required metadata", () => {
    const artifact = structuredClone(parseCaseArtifact(innCounterexample));
    artifact.seed = "challenge-acquisition-42";
    const interview = artifact.evidence.find((item) => item.id === "evidence_wang_testimony")!;
    expect(artifact.solution.requiredEvidenceIds).not.toContain(interview.id);
    expect(solveCase(artifact).status).toBe("unique");
    expect(solveCase({ ...artifact, evidence: artifact.evidence.filter((item) => item.id !== interview.id) }).status).not.toBe("unique");
    const contract = buildCaseRepairContract(artifact, [interviewIssue]);
    const patch = contract.schema.parse({
      evidence: [{ id: interview.id, critical: true }],
      solution: { requiredEvidenceIds: [...artifact.solution.requiredEvidenceIds, interview.id] },
    });
    const repaired = applyCaseArtifactRepairPatch(artifact, patch);
    expect(repaired.evidence.find((item) => item.id === "evidence_kitchen_log")!.discovery)
      .toEqual(artifact.evidence.find((item) => item.id === "evidence_kitchen_log")!.discovery);
    expect(validateGeneratedCharacterPlan(repaired, deriveGenerationPlan(repaired.seed)).map((issue) => issue.code))
      .not.toContain("insufficient_suspect_interview_characters");
  });

  it.each(["dialogueUtterance", "dialogueAliases"] as const)("does not count a %s-only rewrite as a changed acquisition route", (field) => {
    const artifact = makeRouteCase();
    const discovery = field === "dialogueUtterance" ? { dialogueUtterance: "换一种说法，仍然没有交付或调取路线。" } : { dialogueAliases: ["换一个询问用词"] };
    expect(buildCaseRepairContract(artifact, [interviewIssue]).schema.safeParse({
      evidence: [{ id: "evidence_wang_testimony", discovery }],
    }).success).toBe(false);
  });

  it("does not freeze relations when a real semantic failure also needs repair", () => {
    const artifact = makeRouteCase();
    const contract = buildCaseRepairContract(artifact, [interviewIssue, {
      code: "evidence_narrative_mismatch", path: "evidence[9]", message: "原文没有完整证明本人和连续在场。",
    }]);
    expect(contract.scope?.mode).not.toBe("acquisition");
    expect(contract.schema.safeParse({ evidence: [{ id: "evidence_kitchen_log", excludesCharacterIds: [] }] }).success).toBe(true);
  });

  it.each(["cast", "proof"])("does not enter route-only repair with an invalid %s foundation", (failure) => {
    const artifact = makeRouteCase();
    if (failure === "cast") artifact.characters = artifact.characters.filter((person) => person.id !== "character_witness_2");
    else artifact.evidence.find((item) => item.id === "evidence_kitchen_log")!.excludesCharacterIds = [];
    expect(buildCaseRepairContract(artifact, [interviewIssue]).scope?.mode).not.toBe("acquisition");
  });
});
