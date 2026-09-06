import type { CaseArtifact } from "@/domain/case/case-artifact";
import { solveCaseWithEvidenceIds } from "@/domain/case/case-solver";
import { findInitiallyDiscoverableSceneEvidenceIds, findReachableEvidenceIds } from "@/domain/case/evidence-reachability";
import type { CaseValidationIssue } from "@/domain/case/case-validator";
import { containsHiddenConflict } from "@/domain/case/public-information";

export interface GenerationPlan {
  suspectCount: 3 | 4 | 5;
  supportingCharacterCount: 1 | 2 | 3;
  minimumWitnessInterviewCharacters: 1 | 2;
  minimumSuspectInterviewCharacters: 0 | 1;
}

export interface InterviewContributionGap {
  roleTier: "suspect" | "witness";
  minimumCharacters: number;
  existingInterviewEvidenceIds: string[];
  bypasses: { retainedCharacterIds: string[]; proofEvidenceIds: string[] }[];
}

/** 返回真实的少人数解题路径，让修复能定位仍可绕过访谈的核验材料。 */
export function findInterviewContributionGaps(caseArtifact: CaseArtifact, plan: GenerationPlan): InterviewContributionGap[] {
  const fullProof = solveCaseWithEvidenceIds(caseArtifact, findReachableEvidenceIds(caseArtifact));
  if (fullProof.status !== "unique" || fullProof.culpritId !== caseArtifact.culpritId) return [];
  return ([
    ["suspect", plan.minimumSuspectInterviewCharacters],
    ["witness", plan.minimumWitnessInterviewCharacters],
  ] as const).flatMap(([roleTier, minimumCharacters]) => {
    if (minimumCharacters === 0) return [];
    const tierIds = new Set(caseArtifact.characters.filter((character) => character.roleTier === roleTier).map((character) => character.id));
    const existingInterviewEvidenceIds = caseArtifact.evidence.filter((evidence) => evidence.discovery.method === "interview" && tierIds.has(evidence.discovery.characterId!)).map((evidence) => evidence.id);
    // min=1禁用整类，min=2逐一只保留一人，允许A/B替代路线。
    const retainedIds = minimumCharacters === 1 ? [undefined] : [...tierIds];
    const bypasses = retainedIds.flatMap((retainedId) => {
      const reduced = { ...caseArtifact, evidence: caseArtifact.evidence.filter((evidence) =>
        evidence.discovery.method !== "interview" || !tierIds.has(evidence.discovery.characterId!) || evidence.discovery.characterId === retainedId,
      ) };
      const proof = solveCaseWithEvidenceIds(reduced, findReachableEvidenceIds(reduced));
      return proof.status === "unique" && proof.culpritId === caseArtifact.culpritId
        ? [{ retainedCharacterIds: retainedId ? [retainedId] : [], proofEvidenceIds: proof.evidenceIds }] : [];
    });
    return bypasses.length > 0 ? [{ roleTier, minimumCharacters, existingInterviewEvidenceIds, bypasses }] : [];
  });
}

/**
 * 人物规模由 seed 决定，而不是让模型每次自由选择最小人数。
 * FNV-1a 只在本地计算，保证相同 seed 在不同进程中得到相同的案件规模。
 */
export function deriveGenerationPlan(seed: string): GenerationPlan {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  const unsignedHash = hash >>> 0;
  const supportingCharacterCount = (1 + (unsignedHash % 3)) as 1 | 2 | 3;
  const mixedInterviews = supportingCharacterCount === 1 || (unsignedHash >>> 8) % 2 === 0;
  return {
    suspectCount: (3 + ((unsignedHash >>> 16) % 3)) as 3 | 4 | 5,
    supportingCharacterCount,
    minimumWitnessInterviewCharacters: mixedInterviews ? 1 : 2,
    minimumSuspectInterviewCharacters: mixedInterviews ? 1 : 0,
  };
}

/** 生成专属的角色规模门禁；教程和导入账本继续使用通用发布校验。 */
export function validateGeneratedCharacterPlan(
  caseArtifact: CaseArtifact,
  plan: GenerationPlan,
): CaseValidationIssue[] {
  const issues: CaseValidationIssue[] = [];
  const suspects = caseArtifact.characters.filter((character) => character.roleTier === "suspect");
  if (suspects.length !== plan.suspectCount) {
    issues.push({
      code: "seed_suspect_count_mismatch",
      path: "characters",
      message: `seed requires exactly ${plan.suspectCount} suspects but found ${suspects.length}`,
    });
  }
  const supportingCharacters = caseArtifact.characters.filter(
    (character) =>
      character.roleTier === "witness" || character.roleTier === "referenced",
  );
  if (
    supportingCharacters.length !== plan.supportingCharacterCount ||
    supportingCharacters.some((character) => character.roleTier !== "witness")
  ) {
    issues.push({
      code: "seed_supporting_character_count_mismatch",
      path: "characters",
      message:
        `seed requires exactly ${plan.supportingCharacterCount} supporting characters, all witnesses, ` +
        `but found ${supportingCharacters.length}`,
    });
  }

  const requiredEvidenceIds = new Set(caseArtifact.solution.requiredEvidenceIds);
  const characterById = new Map(
    caseArtifact.characters.map((character) => [character.id, character]),
  );
  const interviewCharacterIds = new Set(
    caseArtifact.evidence
      .filter(
        (evidence) =>
          requiredEvidenceIds.has(evidence.id) &&
          evidence.critical &&
          evidence.discovery.method === "interview" &&
          Boolean(evidence.discovery.characterId),
      )
      .map((evidence) => evidence.discovery.characterId!),
  );
  const contributionGaps = findInterviewContributionGaps(caseArtifact, plan);
  const witnessInterviewCharacterIds = [...interviewCharacterIds].filter(
    (id) => characterById.get(id)?.roleTier === "witness",
  );
  const insufficientWitnessContribution = contributionGaps.some((gap) => gap.roleTier === "witness");
  if (witnessInterviewCharacterIds.length < plan.minimumWitnessInterviewCharacters || insufficientWitnessContribution) {
    issues.push({
      code: "insufficient_supporting_interview_characters",
      path: "solution.requiredEvidenceIds",
      message:
        `expected critical interview evidence from at least ${plan.minimumWitnessInterviewCharacters} ` +
        "distinct witness characters in the required solution chain" +
        (insufficientWitnessContribution ? "; evidence can still solve with fewer witness interviews, so the required labels do not establish their actual contribution" : ""),
    });
  }

  const suspectInterviewCount = [...interviewCharacterIds].filter(
    (id) => characterById.get(id)?.roleTier === "suspect",
  ).length;
  const insufficientSuspectContribution = contributionGaps.some((gap) => gap.roleTier === "suspect");
  if (suspectInterviewCount < plan.minimumSuspectInterviewCharacters || insufficientSuspectContribution) {
    issues.push({
      code: "insufficient_suspect_interview_characters",
      path: "solution.requiredEvidenceIds",
      message: `expected critical interview evidence from at least ${plan.minimumSuspectInterviewCharacters} suspect in the required solution chain` +
        (insufficientSuspectContribution ? "; evidence can still solve without suspect interviews, so the required labels do not establish their actual contribution" : ""),
    });
  }

  const reachableEvidenceIds = findReachableEvidenceIds(caseArtifact);
  caseArtifact.characters.forEach((character, index) => {
    if (character.roleTier !== "suspect" && character.roleTier !== "witness") return;
    const hasInterview = caseArtifact.evidence.some((evidence) =>
      evidence.discovery.method === "interview" &&
      evidence.discovery.characterId === character.id &&
      reachableEvidenceIds.has(evidence.id),
    );
    const hasClaim = caseArtifact.claims.some((claim) =>
      claim.speakerId === character.id && claim.kind !== "withheld" &&
      character.knowledge.claimIds.includes(claim.id) && claim.factIds.length > 0,
    );
    if (!hasInterview && !hasClaim) {
      issues.push({
        code: "uninvolved_interview_character",
        path: `characters[${index}].knowledge`,
        message: `interviewable character "${character.id}" must provide reachable interview evidence or a known, non-withheld case-related claim`,
      });
    }
  });

  return issues;
}

/**
 * 首发场景只负责建立问题与方向，不能把嫌疑人、动机、手法或机会直接交给玩家。
 * 这项规则只用于模型生成账本；历史教程可由玩家投影层安全降级后继续游玩。
 */
export function validateInitialScenePacing(
  caseArtifact: CaseArtifact,
): CaseValidationIssue[] {
  const issues: CaseValidationIssue[] = [];
  caseArtifact.characters.forEach((character, index) => {
    if (containsHiddenConflict(character.publicProfile)) {
      issues.push({
        code: "initial_profile_hidden_conflict",
        path: `characters[${index}].publicProfile`,
        message: "public profile must describe identity, ordinary duties or attendance; reveal specific conflicts through investigation instead",
      });
    }
  });
  const initialEvidenceIds = findInitiallyDiscoverableSceneEvidenceIds(caseArtifact);
  if (initialEvidenceIds.size === 0) return issues;

  const suspectIds = new Set(
    caseArtifact.characters
      .filter((character) => character.roleTier === "suspect")
      .map((character) => character.id),
  );
  const suspectNames = caseArtifact.characters
    .filter((character) => character.roleTier === "suspect")
    .map((character) => character.name);
  const factById = new Map(caseArtifact.facts.map((fact) => [fact.id, fact]));
  const sensitiveFactTypes = new Set([
    "identity",
    "motive",
    "method",
    "opportunity",
    "alibi",
  ]);
  const initialEvidence = caseArtifact.evidence.filter((evidence) =>
    initialEvidenceIds.has(evidence.id),
  );

  for (const evidence of initialEvidence) {
    const evidenceIndex = caseArtifact.evidence.findIndex(
      (candidate) => candidate.id === evidence.id,
    );
    const linkedSuspectIds = [
      ...evidence.implicatesCharacterIds,
      ...evidence.excludesCharacterIds,
    ].filter((characterId) => suspectIds.has(characterId));
    if (linkedSuspectIds.length > 0) {
      issues.push({
        code: "premature_initial_scene_suspect_link",
        path: `evidence[${evidenceIndex}].implicatesCharacterIds`,
        message:
          `initial scene evidence \"${evidence.id}\" cannot implicate or exclude a suspect; ` +
          "keep suspect links for later scenes or interviews",
      });
    }

    const sensitiveFactIds = evidence.supportsFactIds.filter((factId) =>
      sensitiveFactTypes.has(factById.get(factId)?.type ?? ""),
    );
    if (sensitiveFactIds.length > 0) {
      issues.push({
        code: "premature_initial_scene_sensitive_fact",
        path: `evidence[${evidenceIndex}].supportsFactIds`,
        message:
          `initial scene evidence \"${evidence.id}\" cannot directly establish ` +
          "identity, motive, method, opportunity, or alibi facts",
      });
    }

    const visibleText = [
      evidence.name,
      evidence.description,
      ...evidence.supportsFactIds.map((factId) => factById.get(factId)?.statement ?? ""),
    ].join("\n");
    const leakedSuspectName = suspectNames.find((name) => visibleText.includes(name));
    if (leakedSuspectName) {
      issues.push({
        code: "initial_scene_suspect_name_leak",
        path: `evidence[${evidenceIndex}]`,
        message:
          `initial scene evidence \"${evidence.id}\" or its directly supported fact ` +
          `names suspect \"${leakedSuspectName}\"`,
      });
    }
  }

  const initialSolution = solveCaseWithEvidenceIds(
    caseArtifact,
    initialEvidenceIds,
  );
  if (initialSolution.status === "unique") {
    issues.push({
      code: "premature_initial_scene_solution",
      path: "evidence",
      message:
        "evidence available from initially unlocked scenes independently identifies the culprit",
    });
  }

  return issues;
}
