import { z } from "zod";

import { caseArtifactRepairPatchSchema, caseArtifactSchema, type CaseArtifact, type CaseArtifactRepairPatch } from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact, type CaseValidationIssue } from "@/domain/case/case-validator";
import { solveCase, solveCaseWithEvidenceIds } from "@/domain/case/case-solver";
import { deriveGenerationPlan, findInterviewContributionGaps, validateGeneratedCharacterPlan, validateInitialScenePacing, type InterviewContributionGap } from "./generation-plan";
import type { PublicWindowReview } from "./generation-schema";

const proofIssueCodes = new Set([
  "evidence_narrative_mismatch", "missing_interview_lead", "unnecessary_interview_evidence",
  "insufficient_required_evidence_chain", "incomplete_solution", "non_unique_solution",
  "premature_direct_evidence_lock", "premature_direct_evidence_reveal",
  "premature_initial_scene_sensitive_fact", "premature_initial_scene_suspect_link",
  "premature_initial_scene_solution", "initial_scene_suspect_name_leak",
]);

export interface CaseRepairScope {
  mode?: "acquisition";
  deferEvidenceIds?: string[];
  existingEvidenceIds: string[];
  existingFactIds: string[];
  characterIds: string[];
  writableFields: string[];
  newEvidence: "complete_object_with_new_id";
  interviewRequirements?: {
    suspectIds: string[];
    witnessIds: string[];
    minimumSuspectCharacters: number;
    minimumWitnessCharacters: number;
  };
  requiredInterviewPrefix?: {
    roleTier: "suspect" | "witness";
    candidates: { characterId: string; candidateEvidenceIds: string[] }[];
  }[];
  deferEvidenceAnchors?: {
    evidenceId: string;
    characters: { characterId: string; basisPaths: string[] }[];
  }[];
  interviewContributionGaps?: InterviewContributionGap[];
}

function stableIssueKey(artifact: CaseArtifact, issue: CaseValidationIssue) {
  let value: unknown = artifact;
  const path = (issue.path.match(/[^.[\]]+/g) ?? []).map((part) => {
    if (Array.isArray(value) && /^\d+$/.test(part)) {
      value = value[Number(part)];
      return value && typeof value === "object" && "id" in value
        ? `@${value.id}` : `@${typeof value === "string" ? value : part}`;
    }
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    return part;
  }).join(".");
  return `${issue.code}:${path}`;
}

/** 只拒绝取得补丁新增的阻断，允许原有问题逐轮减少；实体重排不会冒充新增问题。 */
export function findAcquisitionRepairRegressions(before: CaseArtifact, after: CaseArtifact, seed = before.seed): CaseValidationIssue[] {
  const plan = deriveGenerationPlan(seed);
  const issuesFor = (artifact: CaseArtifact) => [
    ...validatePublishableCaseArtifact(artifact).issues,
    ...validateGeneratedCharacterPlan(artifact, plan),
    ...validateInitialScenePacing(artifact),
  ];
  const existing = new Set(issuesFor(before).map((issue) => stableIssueKey(before, issue)));
  return issuesFor(after).filter((issue) => !existing.has(stableIssueKey(after, issue)));
}

const acquisitionIssueCodes = new Set([
  "insufficient_required_interview_evidence", "unnecessary_interview_evidence",
  "insufficient_supporting_interview_characters", "insufficient_suspect_interview_characters",
  "premature_initial_scene_suspect_link", "premature_initial_scene_sensitive_fact",
  "premature_initial_scene_solution", "initial_scene_suspect_name_leak",
]);

const newEntityId = (ids: string[]) => z.string().regex(new RegExp(`^(?!(?:${ids.join("|")})$)[a-z][a-z0-9_]*$`), "must be a new entity id");

function buildAcquisitionRepairContract(artifact: CaseArtifact, issues: CaseValidationIssue[]) {
  const recordDeliveryIssue = (issue: CaseValidationIssue) => {
    const match = /^evidence\[(\d+)\]$/.exec(issue.path);
    const evidence = match && artifact.evidence[Number(match[1])];
    return issue.code === "evidence_narrative_mismatch" && evidence && evidence.discovery.method === "interview" && evidence.kind !== "testimony" && issue.message.startsWith(`${evidence.id}: record_delivery;`);
  };
  const hasAcquisitionIssue = issues.some((issue) => acquisitionIssueCodes.has(issue.code) || recordDeliveryIssue(issue));
  if (!hasAcquisitionIssue || issues.some((issue) => !acquisitionIssueCodes.has(issue.code) && !recordDeliveryIssue(issue) && issue.code !== "missing_interview_lead")) return null;
  const deliveryEvidenceIds = new Set(issues.filter(recordDeliveryIssue).map((issue) => artifact.evidence[Number(/^evidence\[(\d+)\]$/.exec(issue.path)![1])]!.id));
  const plan = deriveGenerationPlan(artifact.seed);
  const suspectIds = artifact.characters.filter((item) => item.roleTier === "suspect").map((item) => item.id);
  const witnessIds = artifact.characters.filter((item) => item.roleTier === "witness").map((item) => item.id);
  if (suspectIds.length !== plan.suspectCount || witnessIds.length !== plan.supportingCharacterCount ||
    artifact.characters.length !== suspectIds.length + witnessIds.length + 1 ||
    !artifact.characters.some((item) => item.id === artifact.victimId && item.roleTier === "victim") ||
    !suspectIds.includes(artifact.culpritId)) return null;
  const full = solveCase(artifact);
  if (full.status !== "unique" || full.culpritId !== artifact.culpritId) return null;

  const targetIds = new Set(artifact.solution.requiredEvidenceIds);
  const interviewContributionGaps = findInterviewContributionGaps(artifact, plan);
  interviewContributionGaps.forEach((gap) => gap.bypasses.forEach((bypass) => bypass.proofEvidenceIds.forEach((id) => targetIds.add(id))));
  const deferEvidenceIds = new Set<string>();
  if (issues.some((issue) => issue.code === "unnecessary_interview_evidence")) {
    solveCase({ ...artifact, evidence: artifact.evidence.filter((item) => item.discovery.method !== "interview") })
      .evidenceIds.forEach((id) => targetIds.add(id));
  }
  for (const issue of issues) {
    const match = /^evidence\[(\d+)\]/.exec(issue.path);
    if (match && artifact.evidence[Number(match[1])]) {
      const id = artifact.evidence[Number(match[1])]!.id;
      targetIds.add(id);
      if (issue.code.startsWith("premature_initial_scene_") || issue.code === "initial_scene_suspect_name_leak") deferEvidenceIds.add(id);
    }
  }
  artifact.evidence.filter((item) => item.discovery.method === "interview").forEach((item) => targetIds.add(item.id));
  for (let previousSize = -1; previousSize !== targetIds.size;) {
    previousSize = targetIds.size;
    artifact.evidence.filter((item) => targetIds.has(item.id)).forEach((item) =>
      item.discovery.prerequisiteEvidenceIds.forEach((id) => targetIds.add(id)),
    );
  }
  const sceneIds = artifact.scenes.filter((scene) => scene.objects.some((object) => object.evidenceIds.some((id) => targetIds.has(id))) ||
    artifact.evidence.some((item) => targetIds.has(item.id) && item.discovery.sceneId === scene.id)).map((scene) => scene.id);
  const objectIds = artifact.scenes.filter((scene) => sceneIds.includes(scene.id)).flatMap((scene) => scene.objects.map((object) => object.id));
  const characterIds = [...suspectIds, ...witnessIds];
  const recordAnchors = artifact.evidence.filter((item) => targetIds.has(item.id) && item.discovery.method !== "interview").map((item) => ({
    evidenceId: item.id,
    characters: artifact.characters.flatMap((person, personIndex) => {
      if (!characterIds.includes(person.id)) return [];
      const basisPaths: string[] = [];
      if (person.knowledge.evidenceIds.includes(item.id)) basisPaths.push(`characters[${personIndex}].knowledge.evidenceIds`);
      if (person.knowledge.factIds.some((id) => item.supportsFactIds.includes(id))) basisPaths.push(`characters[${personIndex}].knowledge.factIds`);
      artifact.claims.forEach((claim, claimIndex) => {
        if (claim.speakerId === person.id && person.knowledge.claimIds.includes(claim.id) && claim.factIds.some((id) => item.supportsFactIds.includes(id))) basisPaths.push(`claims[${claimIndex}].factIds`);
      });
      return basisPaths.length > 0 ? [{ characterId: person.id, basisPaths }] : [];
    }),
  }));
  const requiredInterviewPrefix: NonNullable<CaseRepairScope["requiredInterviewPrefix"]> = [];
  for (const [roleTier, ids, minimum] of [
    ["suspect", suspectIds, plan.minimumSuspectInterviewCharacters],
    ["witness", witnessIds, plan.minimumWitnessInterviewCharacters],
  ] as const) {
    if (minimum === 0 || artifact.evidence.some((item) => item.discovery.method === "interview" && ids.includes(item.discovery.characterId!))) continue;
    const candidates = ids.map((characterId) => ({ characterId, candidateEvidenceIds: recordAnchors.filter((record) => record.characters.some((person) => person.characterId === characterId)).map((record) => record.evidenceId) }));
    for (let index = 0; index < minimum; index++) requiredInterviewPrefix.push({ roleTier, candidates });
  }
  const known = caseArtifactRepairPatchSchema.shape;
  const evidencePatch = known.evidence.unwrap().element.pick({ id: true, description: true, discovery: true, critical: true }).extend({ id: z.enum([...targetIds]) });
  const leadAddition = caseArtifactSchema.shape.evidence.element.extend({
    id: newEntityId(artifact.evidence.map((item) => item.id)),
    supportsFactIds: z.array(z.string()).length(0), contradictsClaimIds: z.array(z.string()).length(0),
    implicatesCharacterIds: z.array(z.string()).length(0), excludesCharacterIds: z.array(z.string()).length(0),
  });
  const repairEvidence = z.union([evidencePatch, leadAddition]);
  const prefixSchemas = requiredInterviewPrefix.map((entry) => z.union(entry.candidates.flatMap(({ characterId, candidateEvidenceIds }) => {
    const discovery = caseArtifactSchema.shape.evidence.element.shape.discovery.extend({
      method: z.literal("interview"), characterId: z.literal(characterId),
      dialogueAliases: caseArtifactSchema.shape.evidence.element.shape.discovery.shape.dialogueAliases.unwrap().min(3),
      dialogueUtterance: caseArtifactSchema.shape.evidence.element.shape.discovery.shape.dialogueUtterance.unwrap(),
    });
    const contribution = { critical: z.literal(true), discovery };
    return [leadAddition.extend(contribution), ...(candidateEvidenceIds.length > 0
      ? [evidencePatch.extend({ ...contribution, id: z.enum(candidateEvidenceIds), discovery: discovery.partial().required({ method: true, characterId: true, dialogueAliases: true, dialogueUtterance: true }) })] : [])];
  })).describe(`必填${entry.roleTier}访谈贡献；按该人物的既有记录候选交付材料，或新增无证明关系的取得线索`));
  const [firstPrefixSchema, ...restPrefixSchemas] = prefixSchemas;
  const solutionPatch = known.solution.unwrap().pick({ requiredEvidenceIds: true });
  const unlockTargetIds = [...sceneIds, ...characterIds, ...targetIds];
  const unlockIds = artifact.unlockRules.filter((item) => unlockTargetIds.includes(item.targetId)).map((item) => item.id);
  const unlockAddition = caseArtifactSchema.shape.unlockRules.element.extend({ id: newEntityId(artifact.unlockRules.map((item) => item.id)) });
  const unlockPatch = unlockIds.length > 0 ? z.union([
    known.unlockRules.unwrap().element.extend({ id: z.enum(unlockIds) }), unlockAddition,
  ]) : unlockAddition;
  const shape = {
    evidence: firstPrefixSchema ? z.tuple([firstPrefixSchema, ...restPrefixSchemas]).rest(repairEvidence)
      .refine((items) => items.length <= 24, { message: "evidence repair must contain at most 24 items" }) : z.array(repairEvidence).max(24).optional(),
    characters: z.array(known.characters.unwrap().element.pick({ id: true, knowledge: true }).extend({ id: z.enum(characterIds) })).max(9).optional(),
    solution: firstPrefixSchema ? solutionPatch.required() : solutionPatch.optional(),
    scenes: z.array(known.scenes.unwrap().element.pick({ id: true, initiallyUnlocked: true }).extend({ id: z.enum(sceneIds) })).max(sceneIds.length).optional(),
    sceneObjects: z.array(known.sceneObjects.unwrap().element.pick({ id: true, sceneId: true, description: true, actionAliases: true, evidenceIds: true }).extend({ id: z.enum(objectIds), sceneId: z.enum(sceneIds) })
      .refine((item) => artifact.scenes.find((scene) => scene.id === item.sceneId)?.objects.some((object) => object.id === item.id), { message: "object must belong to its existing scene" })).max(8).optional(),
    unlockRules: z.array(unlockPatch).max(8).optional(),
  };
  const schema = z.object(shape).strict().superRefine((patch, context) => {
    requiredInterviewPrefix.forEach((entry, index) => {
      const contribution = patch.evidence?.[index];
      if (!contribution) return;
      if (!patch.solution?.requiredEvidenceIds?.includes(contribution.id)) context.addIssue({ code: "custom", path: ["solution", "requiredEvidenceIds"], message: `must include required ${entry.roleTier} interview ${contribution.id}` });
      if (patch.evidence?.some((item, otherIndex) => otherIndex !== index && item.id === contribution.id)) context.addIssue({ code: "custom", path: ["evidence", index, "id"], message: "required interview contribution cannot be overwritten by another patch entry" });
      if (requiredInterviewPrefix.some((previous, previousIndex) => previousIndex < index && previous.roleTier === entry.roleTier && patch.evidence?.[previousIndex]?.discovery?.characterId === contribution.discovery?.characterId)) context.addIssue({ code: "custom", path: ["evidence", index, "discovery", "characterId"], message: "required interview contributions must use distinct characters" });
    });
    const addedLeadIds = new Set(patch.evidence?.filter((item) => !artifact.evidence.some((existing) => existing.id === item.id)).map((item) => item.id));
    patch.unlockRules?.forEach((item, index) => {
      const previous = artifact.unlockRules.find((existing) => existing.id === item.id);
      const targetId = item.targetId ?? previous?.targetId;
      const targetType = item.targetType ?? previous?.targetType;
      if (!targetId || !unlockTargetIds.includes(targetId) && !(targetType === "evidence" && addedLeadIds.has(targetId))) {
        context.addIssue({ code: "custom", path: ["unlockRules", index, "targetId"], message: "unlock target must be related existing content or a complete new lead in this patch" });
      }
    });
  }).refine((patch) => {
    const changed = (before: unknown, after: unknown) => JSON.stringify(before) !== JSON.stringify(after);
    return patch.evidence?.some((item) => {
      const previous = artifact.evidence.find((entry) => entry.id === item.id);
      return !previous || item.discovery && (["method", "sceneId", "objectId", "characterId", "prerequisiteEvidenceIds"] as const)
        .some((key) => item.discovery![key] !== undefined && changed(previous.discovery[key], item.discovery![key])) ||
        deliveryEvidenceIds.has(item.id) && item.discovery && (["dialogueUtterance", "dialogueAliases"] as const)
          .some((key) => item.discovery![key] !== undefined && changed(previous!.discovery[key], item.discovery![key]));
    }) || patch.scenes?.some((item) => item.initiallyUnlocked !== undefined && artifact.scenes.find((scene) => scene.id === item.id)?.initiallyUnlocked !== item.initiallyUnlocked) ||
      patch.sceneObjects?.some((item) => item.evidenceIds && changed(artifact.scenes.find((scene) => scene.id === item.sceneId)?.objects.find((object) => object.id === item.id)?.evidenceIds, item.evidenceIds)) ||
      patch.unlockRules?.some((item) => {
        const previous = artifact.unlockRules.find((entry) => entry.id === item.id);
        return !previous || Object.entries(item).some(([key, value]) => changed(previous[key as keyof typeof previous], value));
      }) || artifact.evidence.some((interview) => {
        if (interview.discovery.method !== "interview") return false;
        const required = patch.solution?.requiredEvidenceIds ?? artifact.solution.requiredEvidenceIds;
        const critical = patch.evidence?.find((item) => item.id === interview.id)?.critical ?? interview.critical;
        if (!required.includes(interview.id) || !critical || artifact.solution.requiredEvidenceIds.includes(interview.id) && interview.critical) return false;
        if (!artifact.evidence.some((item) => item.discovery.prerequisiteEvidenceIds.includes(interview.id))) return false;
        // 既有访谈本就不可绕过，只漏记在必要链中时，允许修正元数据。
        const withoutInterview = solveCase({ ...artifact, evidence: artifact.evidence.filter((item) => item.id !== interview.id) });
        return withoutInterview.status !== "unique" || withoutInterview.culpritId !== artifact.culpritId;
      });
  }, { message: "acquisition repair must change an actual discovery route or register an existing indispensable prerequisite interview; critical or required-list changes alone are insufficient" });
  return {
    schema,
    scope: {
      mode: "acquisition" as const, deferEvidenceIds: [...deferEvidenceIds], existingEvidenceIds: [...targetIds], existingFactIds: [], characterIds,
      requiredInterviewPrefix, deferEvidenceAnchors: recordAnchors.filter((record) => deferEvidenceIds.has(record.evidenceId)), interviewContributionGaps,
      writableFields: Object.keys(shape), newEvidence: "complete_object_with_new_id" as const,
      interviewRequirements: { suspectIds, witnessIds, minimumSuspectCharacters: plan.minimumSuspectInterviewCharacters, minimumWitnessCharacters: plan.minimumWitnessInterviewCharacters },
    },
  };
}

/** 只缩小已知证明/取得关系修复；解析、人数等结构问题保留完整修复协议。 */
export function buildCaseRepairContract(artifact: CaseArtifact, issues: CaseValidationIssue[], publicWindowReview?: PublicWindowReview | null): {
  schema: z.ZodType<CaseArtifactRepairPatch>;
  scope: CaseRepairScope | null;
} {
  issues = issues.filter((issue) => issue.code !== "invalid_repair_patch");
  const acquisition = buildAcquisitionRepairContract(artifact, issues);
  if (acquisition) return acquisition;
  if (issues.length === 0 || issues.some((issue) => !proofIssueCodes.has(issue.code))) {
    return { schema: caseArtifactRepairPatchSchema, scope: null };
  }
  const targetIds = new Set(issues.flatMap((issue) => {
    const match = /^evidence\[(\d+)\]/.exec(issue.path);
    const target = match && artifact.evidence[Number(match[1])];
    return target ? [target.id] : [];
  }));
  const wholeChainIssue = issues.some((issue) => !/^evidence\[\d+\]/.test(issue.path));
  if (wholeChainIssue) artifact.solution.requiredEvidenceIds.forEach((id) => targetIds.add(id));
  if (issues.some((issue) => issue.code === "insufficient_required_evidence_chain")) {
    const missingExclusions = new Set(solveCaseWithEvidenceIds(artifact, artifact.solution.requiredEvidenceIds)
      .candidateIds.filter((id) => id !== artifact.culpritId));
    artifact.evidence.filter((item) => item.excludesCharacterIds.some((id) => missingExclusions.has(id)))
      .forEach((item) => targetIds.add(item.id));
  }

  const timeIssue = [...targetIds].some((id) => publicWindowReview?.temporalEvidenceIds.includes(id)) ||
    issues.some((issue) => issue.path === "timeline" || /(?:公开|公共|作案|实施|案发)(?:时间)?窗口|coverage|public_window|时间不一致|time window/iu.test(issue.message));
  const boundarySourceIds = new Set(publicWindowReview?.window
    ? [...publicWindowReview.window.startSourceIds, ...publicWindowReview.window.endSourceIds] : []);
  if (timeIssue) publicWindowReview?.sources.forEach((source) => {
    if (boundarySourceIds.has(source.id) && source.evidenceId && artifact.evidence.some((item) => item.id === source.evidenceId)) targetIds.add(source.evidenceId);
  });

  const targets = artifact.evidence.filter((item) => targetIds.has(item.id));
  const factIds = new Set(targets.flatMap((item) => item.supportsFactIds));
  if (wholeChainIssue) {
    factIds.add(artifact.solution.motiveFactId);
    factIds.add(artifact.solution.methodFactId);
  }
  const claimIds = new Set(targets.flatMap((item) => item.contradictsClaimIds));
  const characterIds = new Set(targets.flatMap((item) => [
    ...item.implicatesCharacterIds, ...item.excludesCharacterIds,
    ...(item.discovery.characterId ? [item.discovery.characterId] : []),
  ]));
  // 保留能承接修复的既有同事实/反证/排除材料，以及实际获取它们的强制前置。
  artifact.evidence.filter((item) => item.supportsFactIds.some((id) => factIds.has(id)) ||
    item.contradictsClaimIds.some((id) => claimIds.has(id)) ||
    item.excludesCharacterIds.some((id) => characterIds.has(id)),
  ).forEach((item) => targetIds.add(item.id));
  for (let previousSize = -1; previousSize !== targetIds.size;) {
    previousSize = targetIds.size;
    artifact.evidence.filter((item) => targetIds.has(item.id)).forEach((item) => {
      item.discovery.prerequisiteEvidenceIds.forEach((id) => targetIds.add(id));
      item.supportsFactIds.forEach((id) => factIds.add(id));
      item.contradictsClaimIds.forEach((id) => claimIds.add(id));
      if (item.discovery.characterId) characterIds.add(item.discovery.characterId);
    });
  }
  const affectsSolutionFacts = factIds.has(artifact.solution.motiveFactId) || factIds.has(artifact.solution.methodFactId);
  if (affectsSolutionFacts) characterIds.add(artifact.culpritId);
  const known = caseArtifactRepairPatchSchema.shape;
  const evidenceAddition = caseArtifactSchema.shape.evidence.element.extend({ id: newEntityId(artifact.evidence.map((item) => item.id)) });
  const factAddition = caseArtifactSchema.shape.facts.element.extend({ id: newEntityId(artifact.facts.map((item) => item.id)) });
  const evidencePatch = targetIds.size > 0
    ? z.union([known.evidence.unwrap().element.extend({ id: z.enum([...targetIds]) }), evidenceAddition])
    : evidenceAddition;
  const factPatch = factIds.size > 0
    ? z.union([known.facts.unwrap().element.extend({ id: z.enum([...factIds]) }), factAddition])
    : factAddition;
  const characterKnowledgePatch = known.characters.unwrap().element.pick({ id: true, knowledge: true }).extend({ id: z.enum([...characterIds]) });
  const characterPatch = affectsSolutionFacts
    ? z.union([characterKnowledgePatch, known.characters.unwrap().element.pick({ id: true, knowledge: true, secretFactIds: true }).extend({ id: z.literal(artifact.culpritId) })])
    : characterKnowledgePatch;
  const timestampIssue = issues.some((issue) => /时间不一致|时间冲突|(?:timestamp|time)\s+(?:mismatch|conflict)/iu.test(issue.message));
  const shape = {
    evidence: z.array(evidencePatch).max(24).optional(),
    facts: z.array(factPatch).max(24).optional(),
    solution: known.solution.unwrap().omit({ culpritId: true }).optional(),
    characters: characterIds.size > 0
      ? z.array(characterPatch).max(9).optional()
      : z.never().optional(),
    claims: claimIds.size > 0
      ? z.array(known.claims.unwrap().element.extend({ id: z.enum([...claimIds]) })).max(8).optional()
      : z.never().optional(),
    // 新核验材料仍可落在现有场景、更新调查入口和解锁依赖；不复制整个场景。
    sceneObjects: known.sceneObjects,
    unlockRules: known.unlockRules,
    setting: known.setting, timeline: known.timeline, briefing: known.briefing,
  };
  const schema = z.object(shape).strict();
  const publicSchema = timeIssue ? schema : schema.omit({ briefing: true });
  const scopedSchema = timestampIssue ? publicSchema : publicSchema.omit({ setting: true, timeline: true });
  return {
    schema: scopedSchema.refine((patch) => Object.keys(patch).length > 0, { message: "must include at least one repair field" }),
    scope: {
      existingEvidenceIds: [...targetIds], existingFactIds: [...factIds], characterIds: [...characterIds],
      writableFields: Object.keys(scopedSchema.shape).filter((key) => (key !== "characters" || characterIds.size > 0) && (key !== "claims" || claimIds.size > 0)),
      newEvidence: "complete_object_with_new_id",
    },
  };
}
