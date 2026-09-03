import type { CaseArtifact } from "./case-artifact";
import { solveCase, solveCaseWithEvidenceIds } from "./case-solver";
import { findReachableEvidenceIds } from "./evidence-reachability";

export interface CaseValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface CaseValidationReport {
  valid: boolean;
  issues: CaseValidationIssue[];
}

/**
 * 校验账本内部引用、角色知识边界、可达性和确定性唯一解。
 * 这是基础一致性校验；准备发布时还必须调用 validatePublishableCaseArtifact。
 */
export function validateCaseArtifact(
  caseArtifact: CaseArtifact,
): CaseValidationReport {
  const issues: CaseValidationIssue[] = [];
  const firstPathById = new Map<string, string>();

  for (const entity of listEntityIds(caseArtifact)) {
    const firstPath = firstPathById.get(entity.id);
    if (firstPath) {
      issues.push({
        code: "duplicate_entity_id",
        path: entity.path,
        message: `duplicates id "${entity.id}" first declared at "${firstPath}"`,
      });
    } else {
      firstPathById.set(entity.id, entity.path);
    }
  }

  for (const reference of listReferences(caseArtifact)) {
    if (!reference.validIds.has(reference.id)) {
      issues.push({
        code: "dangling_reference",
        path: reference.path,
        message: `references unknown ${reference.kind} "${reference.id}"`,
      });
    }
  }

  const characterIds = idSet(caseArtifact.characters);
  // requiredEvidenceIds 不是展示字段：玩家收集这组证据时必须已能独立得出唯一解。
  if (
    characterIds.has(caseArtifact.solution.culpritId) &&
    caseArtifact.solution.culpritId !== caseArtifact.culpritId
  ) {
    issues.push({
      code: "solution_mismatch",
      path: "solution.culpritId",
      message: `must match truth-ledger culprit "${caseArtifact.culpritId}"`,
    });
  }

  const culprit = caseArtifact.characters.find(
    (character) => character.id === caseArtifact.culpritId,
  );
  if (culprit && culprit.roleTier !== "suspect") {
    issues.push({
      code: "invalid_character_role",
      path: "culpritId",
      message: `culprit "${culprit.id}" must have roleTier "suspect"`,
    });
  }
  if (culprit) {
    const missingCulpritFactIds = [
      caseArtifact.solution.motiveFactId,
      caseArtifact.solution.methodFactId,
    ].filter((factId) => !culprit.knowledge.factIds.includes(factId));
    if (missingCulpritFactIds.length > 0) {
      issues.push({
        code: "culprit_missing_self_knowledge",
        path: "characters",
        message: `culprit knowledge is missing ${missingCulpritFactIds
          .map((id) => `"${id}"`)
          .join(", ")}`,
      });
    }
  }

  caseArtifact.characters.forEach((character, characterIndex) => {
    const missingSecretFactId = character.secretFactIds.find(
      (factId) => !character.knowledge.factIds.includes(factId),
    );
    if (missingSecretFactId) {
      issues.push({
        code: "secret_outside_character_knowledge",
        path: `characters[${characterIndex}].secretFactIds`,
        message: `secret fact "${missingSecretFactId}" must also be in character knowledge`,
      });
    }
    const unknownLieFactId = character.lieRules.find(
      (rule) => !character.knowledge.factIds.includes(rule.factId),
    )?.factId;
    if (unknownLieFactId) {
      issues.push({
        code: "lie_outside_character_knowledge",
        path: `characters[${characterIndex}].lieRules`,
        message: `lie rule fact "${unknownLieFactId}" must also be in character knowledge`,
      });
    }
  });

  const suspectCount = caseArtifact.characters.filter(
    (character) => character.roleTier === "suspect",
  ).length;
  if (suspectCount !== 4) {
    issues.push({
      code: "invalid_suspect_count",
      path: "characters",
      message: `expected exactly 4 suspects but found ${suspectCount}`,
    });
  }

  const supportingCharacterCount = caseArtifact.characters.filter(
    (character) =>
      character.roleTier === "witness" || character.roleTier === "referenced",
  ).length;
  if (supportingCharacterCount < 2 || supportingCharacterCount > 4) {
    issues.push({
      code: "invalid_supporting_character_count",
      path: "characters",
      message: `expected 2 to 4 supporting characters but found ${supportingCharacterCount}`,
    });
  }

  const victimCount = caseArtifact.characters.filter(
    (character) => character.roleTier === "victim",
  ).length;
  if (victimCount !== 1) {
    issues.push({
      code: "invalid_victim_count",
      path: "characters",
      message: `expected exactly 1 victim but found ${victimCount}`,
    });
  }

  const objectSceneById = new Map(
    caseArtifact.scenes.flatMap((scene) =>
      scene.objects.map((object) => [object.id, scene.id] as const),
    ),
  );
  caseArtifact.evidence.forEach((evidence, evidenceIndex) => {
    const { objectId, sceneId } = evidence.discovery;
    const objectSceneId = objectId ? objectSceneById.get(objectId) : undefined;
    if (objectId && sceneId && objectSceneId && objectSceneId !== sceneId) {
      issues.push({
        code: "discovery_location_mismatch",
        path: `evidence[${evidenceIndex}].discovery.objectId`,
        message: `object "${objectId}" does not belong to scene "${sceneId}"`,
      });
    }
  });

  const evidenceIds = idSet(caseArtifact.evidence);
  const reachableEvidenceIds = findReachableEvidenceIds(caseArtifact);
  caseArtifact.solution.requiredEvidenceIds.forEach((evidenceId, index) => {
    if (evidenceIds.has(evidenceId) && !reachableEvidenceIds.has(evidenceId)) {
      issues.push({
        code: "unreachable_required_evidence",
        path: `solution.requiredEvidenceIds[${index}]`,
        message: `required evidence "${evidenceId}" cannot be discovered`,
      });
    }
  });

  const solutionResult = solveCase(caseArtifact);
  if (solutionResult.status === "ambiguous") {
    issues.push({
      code: "non_unique_solution",
      path: "evidence",
      message: `discoverable evidence leaves candidates ${solutionResult.candidateIds
        .map((id) => `"${id}"`)
        .join(", ")}`,
    });
  } else if (solutionResult.status === "inconsistent") {
    issues.push({
      code: "inconsistent_solution",
      path: "evidence",
      message: "discoverable evidence excludes every suspect",
    });
  } else if (solutionResult.status === "unsupported") {
    issues.push({
      code: "incomplete_solution",
      path: "evidence",
      message: "discoverable evidence lacks a complete motive and method chain",
    });
  } else if (solutionResult.culpritId !== caseArtifact.culpritId) {
    issues.push({
      code: "solver_truth_mismatch",
      path: "culpritId",
      message: `evidence identifies "${solutionResult.culpritId}" instead of "${caseArtifact.culpritId}"`,
    });
  }

  if (
    caseArtifact.solution.requiredEvidenceIds.every((id) => evidenceIds.has(id))
  ) {
    const requiredChainResult = solveCaseWithEvidenceIds(
      caseArtifact,
      caseArtifact.solution.requiredEvidenceIds,
    );
    if (
      requiredChainResult.status !== "unique" ||
      requiredChainResult.culpritId !== caseArtifact.culpritId
    ) {
      issues.push({
        code: "insufficient_required_evidence_chain",
        path: "solution.requiredEvidenceIds",
        message:
          "the declared required evidence chain must independently identify the culprit, motive, and method",
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * 发布门禁：在基础一致性之上强制产品规模、内容边界和提示词安全要求。
 * 只有通过此函数的 artifact 才能被仓储标记为 ready。
 */
export function validatePublishableCaseArtifact(
  caseArtifact: CaseArtifact,
): CaseValidationReport {
  const report = validateCaseArtifact(caseArtifact);
  const issues = [...report.issues];

  if (caseArtifact.scenes.length < 3) {
    issues.push({
      code: "invalid_scene_count",
      path: "scenes",
      message: `expected at least 3 scenes but found ${caseArtifact.scenes.length}`,
    });
  }
  if (caseArtifact.solution.requiredEvidenceIds.length < 4) {
    issues.push({
      code: "insufficient_solution_evidence",
      path: "solution.requiredEvidenceIds",
      message: "expected at least 4 independent evidence items in the solution chain",
    });
  }
  if (caseArtifact.evidence.filter((evidence) => evidence.critical).length < 3) {
    issues.push({
      code: "insufficient_critical_evidence",
      path: "evidence",
      message: "expected at least 3 critical evidence items",
    });
  }
  if (
    !caseArtifact.evidence.some(
      (evidence) =>
        evidence.discovery.method === "interview" &&
        evidence.discovery.characterId,
    )
  ) {
    issues.push({
      code: "missing_interview_evidence",
      path: "evidence",
      message: "expected at least one testimony discoverable through character dialogue",
    });
  }
  caseArtifact.evidence.forEach((evidence, evidenceIndex) => {
    if (evidence.discovery.method !== "interview") return;
    if ((evidence.discovery.dialogueAliases?.length ?? 0) < 3) {
      issues.push({
        code: "insufficient_interview_dialogue_aliases",
        path: `evidence[${evidenceIndex}].discovery.dialogueAliases`,
        message:
          "expected at least three natural-language dialogue aliases for interview evidence",
      });
    }
    if (!evidence.discovery.dialogueUtterance) {
      issues.push({
        code: "missing_interview_dialogue_utterance",
        path: `evidence[${evidenceIndex}].discovery.dialogueUtterance`,
        message:
          "expected a first-person dialogue utterance for interview evidence",
      });
    }
  });
  const requiredEvidenceIds = new Set(caseArtifact.solution.requiredEvidenceIds);
  const requiredInterviewEvidence = caseArtifact.evidence.filter(
    (evidence) =>
      requiredEvidenceIds.has(evidence.id) &&
      evidence.critical &&
      evidence.discovery.method === "interview" &&
      Boolean(evidence.discovery.characterId),
  );
  if (requiredInterviewEvidence.length < 2) {
    issues.push({
      code: "insufficient_required_interview_evidence",
      path: "solution.requiredEvidenceIds",
      message:
        "expected at least two critical interview evidence items in the required solution chain",
    });
  }

  const graphicPattern = /(肢解|开膛|内脏|血肉模糊|断肢|虐杀)/u;
  const playerFacingText = [
    caseArtifact.title,
    caseArtifact.briefing,
    ...caseArtifact.scenes.flatMap((scene) => [
      scene.name,
      scene.description,
      ...scene.objects.flatMap((object) => [object.name, object.description]),
    ]),
    ...caseArtifact.evidence.flatMap((evidence) => [
      evidence.name,
      evidence.description,
    ]),
  ].join("\n");
  if (graphicPattern.test(playerFacingText)) {
    issues.push({
      code: "graphic_content",
      path: "briefing",
      message: "graphic violence is outside the game's content boundary",
    });
  }

  const culprit = caseArtifact.characters.find(
    (character) => character.id === caseArtifact.culpritId,
  );
  if (culprit && caseArtifact.scenes.length >= 3) {
    const reachableEvidenceIds = findReachableEvidenceIds(caseArtifact);
    const directSceneEvidence = caseArtifact.evidence.filter(
      (evidence) =>
        reachableEvidenceIds.has(evidence.id) &&
        Boolean(evidence.discovery.sceneId) &&
        (evidence.kind === "physical" || evidence.kind === "forensic"),
    );
    const directCulpritMentions = directSceneEvidence.filter((evidence) =>
      `${evidence.name}\n${evidence.description}`.includes(culprit.name),
    );
    if (directCulpritMentions.length >= 2) {
      issues.push({
        code: "premature_direct_evidence_reveal",
        path: "evidence",
        message:
          "multiple direct scene physical or forensic clues explicitly name the culprit",
      });
    }
    const lockingEvidenceIds = findDirectEvidenceLockingChain(
      caseArtifact,
      directSceneEvidence,
      culprit.id,
    );
    if (lockingEvidenceIds) {
      const firstEvidenceId = lockingEvidenceIds[0];
      const firstEvidenceIndex = caseArtifact.evidence.findIndex(
        (evidence) => evidence.id === firstEvidenceId,
      );
      issues.push({
        code: "premature_direct_evidence_lock",
        path:
          firstEvidenceIndex < 0
            ? "evidence"
            : `evidence[${firstEvidenceIndex}].excludesCharacterIds`,
        message:
          `direct scene evidence ${lockingEvidenceIds
            .map((evidenceId) => `"${evidenceId}"`)
            .join(", ")} independently excludes every other suspect; ` +
          "move suspect exclusions to non-direct evidence",
      });
    }
  }
  const initiallyPublicText = [
    caseArtifact.title,
    caseArtifact.briefing,
    caseArtifact.setting.place,
    ...caseArtifact.characters.flatMap((character) => [
      character.occupation,
      character.publicProfile,
    ]),
    ...caseArtifact.scenes.flatMap((scene) => [
      scene.name,
      scene.description,
      ...scene.objects.flatMap((object) => [object.name, object.description]),
    ]),
  ].join("\n");
  if (culprit) {
    const culpritName = escapeRegExp(culprit.name);
    const explicitCulpritPattern = new RegExp(
      `(?:真凶|凶手|杀人者|作案者).{0,8}${culpritName}|${culpritName}.{0,8}(?:是真凶|是凶手|杀害|杀死|行凶|作案)`,
      "u",
    );
    if (explicitCulpritPattern.test(initiallyPublicText)) {
      issues.push({
        code: "premature_culprit_leak",
        path: "briefing",
        message: "initially public text explicitly identifies the culprit",
      });
    }
  }
  if (
    /(?:culpritId|privateProfile|lieRules|secretFactIds|solution|requiredEvidenceIds|fact_|evidence_|claim_)/u.test(
      initiallyPublicText,
    )
  ) {
    issues.push({
      code: "internal_marker_leak",
      path: "briefing",
      message: "initially public text exposes internal case markers",
    });
  }
  const leakedPrivateProfile = caseArtifact.characters.find(
    (character) =>
      character.privateProfile.length >= 6 &&
      initiallyPublicText.includes(character.privateProfile),
  );
  if (leakedPrivateProfile) {
    issues.push({
      code: "private_profile_leak",
      path: "characters",
      message: `private profile for "${leakedPrivateProfile.id}" appears in public text`,
    });
  }


  // 案件文本会进入模型上下文，因此把像指令/越权请求的内容挡在发布前，而非寄望模型忽略它。
  const promptInjectionPattern =
    /(?:(?:忽略|无视|绕过|覆盖|放弃).{0,24}(?:此前|之前|以上|系统|开发者|规则|指令|提示词)|(?:显示|输出|泄露|透露).{0,20}(?:系统提示|开发者消息|提示词|api\s*key)|(?:ignore|disregard|override|bypass).{0,36}(?:previous|prior|above|system|developer|instructions?|prompts?)|(?:system|developer)\s*(?:message|prompt)|jailbreak)/iu;
  if (promptInjectionPattern.test(collectTextValues(caseArtifact).join("\n"))) {
    issues.push({
      code: "prompt_instruction_content",
      path: "caseArtifact",
      message: "case content contains instruction-like text unsafe for model context",
    });
  }

  return { valid: issues.length === 0, issues };
}

function collectTextValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectTextValues);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectTextValues);
  }
  return [];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDirectEvidenceLockingChain(
  caseArtifact: CaseArtifact,
  evidence: CaseArtifact["evidence"],
  culpritId: string,
): string[] | null {
  const otherSuspectIds = caseArtifact.characters
    .filter(
      (character) =>
        character.roleTier === "suspect" && character.id !== culpritId,
    )
    .map((character) => character.id);
  if (otherSuspectIds.length === 0) return null;

  const suspectBitById = new Map(
    otherSuspectIds.map((suspectId, index) => [suspectId, 1 << index]),
  );
  const fullMask = (1 << otherSuspectIds.length) - 1;
  const shortestChainByMask = new Map<number, string[]>([[0, []]]);

  for (const item of evidence) {
    if (item.excludesCharacterIds.includes(culpritId)) continue;
    const mask = item.excludesCharacterIds.reduce(
      (result, suspectId) => result | (suspectBitById.get(suspectId) ?? 0),
      0,
    );
    if (mask === 0) continue;

    for (const [coveredMask, evidenceIds] of [...shortestChainByMask]) {
      if (evidenceIds.length >= 3) continue;
      const nextEvidenceIds = [...evidenceIds, item.id];
      const nextMask = coveredMask | mask;
      if (nextMask === fullMask) {
        const result = solveCaseWithEvidenceIds(caseArtifact, nextEvidenceIds);
        if (
          result.candidateIds.length === 1 &&
          result.candidateIds[0] === culpritId
        ) {
          return nextEvidenceIds;
        }
      }
      const prior = shortestChainByMask.get(nextMask);
      if (!prior || nextEvidenceIds.length < prior.length) {
        shortestChainByMask.set(nextMask, nextEvidenceIds);
      }
    }
  }

  return null;
}

interface EntityReference {
  id: string;
  path: string;
  kind: string;
  validIds: ReadonlySet<string>;
}

function listReferences(caseArtifact: CaseArtifact): EntityReference[] {
  const characterIds = idSet(caseArtifact.characters);
  const sceneIds = idSet(caseArtifact.scenes);
  const objectIds = new Set(
    caseArtifact.scenes.flatMap((scene) =>
      scene.objects.map((object) => object.id),
    ),
  );
  const factIds = idSet(caseArtifact.facts);
  const timelineEventIds = idSet(caseArtifact.timeline);
  const claimIds = idSet(caseArtifact.claims);
  const evidenceIds = idSet(caseArtifact.evidence);
  const references: EntityReference[] = [];

  const add = (
    id: string,
    path: string,
    kind: string,
    validIds: ReadonlySet<string>,
  ) => references.push({ id, path, kind, validIds });

  const addList = (
    ids: readonly string[],
    path: string,
    kind: string,
    validIds: ReadonlySet<string>,
  ) => ids.forEach((id, index) => add(id, `${path}[${index}]`, kind, validIds));

  add(caseArtifact.victimId, "victimId", "character", characterIds);
  add(caseArtifact.culpritId, "culpritId", "character", characterIds);

  caseArtifact.characters.forEach((character, characterIndex) => {
    const path = `characters[${characterIndex}]`;
    addList(character.knowledge.factIds, `${path}.knowledge.factIds`, "fact", factIds);
    addList(
      character.knowledge.evidenceIds,
      `${path}.knowledge.evidenceIds`,
      "evidence",
      evidenceIds,
    );
    addList(
      character.knowledge.claimIds,
      `${path}.knowledge.claimIds`,
      "claim",
      claimIds,
    );
    addList(character.secretFactIds, `${path}.secretFactIds`, "fact", factIds);
    character.lieRules.forEach((rule, ruleIndex) =>
      add(rule.factId, `${path}.lieRules[${ruleIndex}].factId`, "fact", factIds),
    );
  });

  caseArtifact.scenes.forEach((scene, sceneIndex) =>
    scene.objects.forEach((object, objectIndex) =>
      addList(
        object.evidenceIds,
        `scenes[${sceneIndex}].objects[${objectIndex}].evidenceIds`,
        "evidence",
        evidenceIds,
      ),
    ),
  );

  caseArtifact.timeline.forEach((event, eventIndex) => {
    const path = `timeline[${eventIndex}]`;
    add(event.sceneId, `${path}.sceneId`, "scene", sceneIds);
    addList(event.characterIds, `${path}.characterIds`, "character", characterIds);
    addList(event.factIds, `${path}.factIds`, "fact", factIds);
  });

  caseArtifact.claims.forEach((claim, claimIndex) => {
    const path = `claims[${claimIndex}]`;
    add(claim.speakerId, `${path}.speakerId`, "character", characterIds);
    addList(claim.factIds, `${path}.factIds`, "fact", factIds);
  });

  caseArtifact.evidence.forEach((evidence, evidenceIndex) => {
    const path = `evidence[${evidenceIndex}]`;
    addList(evidence.supportsFactIds, `${path}.supportsFactIds`, "fact", factIds);
    addList(
      evidence.contradictsClaimIds,
      `${path}.contradictsClaimIds`,
      "claim",
      claimIds,
    );
    addList(
      evidence.implicatesCharacterIds,
      `${path}.implicatesCharacterIds`,
      "character",
      characterIds,
    );
    addList(
      evidence.excludesCharacterIds,
      `${path}.excludesCharacterIds`,
      "character",
      characterIds,
    );
    if (evidence.discovery.sceneId) {
      add(evidence.discovery.sceneId, `${path}.discovery.sceneId`, "scene", sceneIds);
    }
    if (evidence.discovery.objectId) {
      add(evidence.discovery.objectId, `${path}.discovery.objectId`, "object", objectIds);
    }
    if (evidence.discovery.characterId) {
      add(
        evidence.discovery.characterId,
        `${path}.discovery.characterId`,
        "character",
        characterIds,
      );
    }
    addList(
      evidence.discovery.prerequisiteEvidenceIds,
      `${path}.discovery.prerequisiteEvidenceIds`,
      "evidence",
      evidenceIds,
    );
  });

  caseArtifact.unlockRules.forEach((rule, ruleIndex) => {
    const path = `unlockRules[${ruleIndex}]`;
    const targetIds =
      rule.targetType === "scene"
        ? sceneIds
        : rule.targetType === "character"
          ? characterIds
          : evidenceIds;
    const targetKind = rule.targetType === "analysis" ? "evidence" : rule.targetType;
    add(rule.targetId, `${path}.targetId`, targetKind, targetIds);
    addList(rule.allEvidenceIds, `${path}.allEvidenceIds`, "evidence", evidenceIds);
    addList(rule.anyEvidenceIds, `${path}.anyEvidenceIds`, "evidence", evidenceIds);
  });

  caseArtifact.hintChains.forEach((hint, hintIndex) =>
    add(hint.targetFactId, `hintChains[${hintIndex}].targetFactId`, "fact", factIds),
  );

  add(caseArtifact.solution.culpritId, "solution.culpritId", "character", characterIds);
  add(caseArtifact.solution.motiveFactId, "solution.motiveFactId", "fact", factIds);
  add(caseArtifact.solution.methodFactId, "solution.methodFactId", "fact", factIds);
  addList(
    caseArtifact.solution.requiredEvidenceIds,
    "solution.requiredEvidenceIds",
    "evidence",
    evidenceIds,
  );
  addList(
    caseArtifact.solution.requiredTimelineEventIds,
    "solution.requiredTimelineEventIds",
    "timeline event",
    timelineEventIds,
  );

  return references;
}

function idSet(entities: ReadonlyArray<{ id: string }>): Set<string> {
  return new Set(entities.map((entity) => entity.id));
}

function listEntityIds(
  caseArtifact: CaseArtifact,
): Array<{ id: string; path: string }> {
  return [
    { id: caseArtifact.id, path: "id" },
    ...caseArtifact.characters.map((character, index) => ({
      id: character.id,
      path: `characters[${index}].id`,
    })),
    ...caseArtifact.scenes.flatMap((scene, sceneIndex) => [
      { id: scene.id, path: `scenes[${sceneIndex}].id` },
      ...scene.objects.map((object, objectIndex) => ({
        id: object.id,
        path: `scenes[${sceneIndex}].objects[${objectIndex}].id`,
      })),
    ]),
    ...caseArtifact.facts.map((fact, index) => ({
      id: fact.id,
      path: `facts[${index}].id`,
    })),
    ...caseArtifact.timeline.map((event, index) => ({
      id: event.id,
      path: `timeline[${index}].id`,
    })),
    ...caseArtifact.claims.map((claim, index) => ({
      id: claim.id,
      path: `claims[${index}].id`,
    })),
    ...caseArtifact.evidence.map((evidence, index) => ({
      id: evidence.id,
      path: `evidence[${index}].id`,
    })),
    ...caseArtifact.unlockRules.map((rule, index) => ({
      id: rule.id,
      path: `unlockRules[${index}].id`,
    })),
    ...caseArtifact.hintChains.map((hint, index) => ({
      id: hint.id,
      path: `hintChains[${index}].id`,
    })),
  ];
}
