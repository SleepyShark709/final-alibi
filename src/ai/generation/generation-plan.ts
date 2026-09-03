import type { CaseArtifact } from "@/domain/case/case-artifact";
import { solveCaseWithEvidenceIds } from "@/domain/case/case-solver";
import { findInitiallyDiscoverableSceneEvidenceIds } from "@/domain/case/evidence-reachability";
import type { CaseValidationIssue } from "@/domain/case/case-validator";

export interface GenerationPlan {
  supportingCharacterCount: 2 | 3 | 4;
  minimumWitnessInterviewCharacters: 2;
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

  return {
    supportingCharacterCount: (2 + ((hash >>> 0) % 3)) as 2 | 3 | 4,
    minimumWitnessInterviewCharacters: 2,
  };
}

/** 生成专属的角色规模门禁；教程和导入账本继续使用通用发布校验。 */
export function validateGeneratedCharacterPlan(
  caseArtifact: CaseArtifact,
  plan: GenerationPlan,
): CaseValidationIssue[] {
  const issues: CaseValidationIssue[] = [];
  const supportingCharacters = caseArtifact.characters.filter(
    (character) =>
      character.roleTier === "witness" || character.roleTier === "referenced",
  );
  if (supportingCharacters.length !== plan.supportingCharacterCount) {
    issues.push({
      code: "seed_supporting_character_count_mismatch",
      path: "characters",
      message:
        `seed requires exactly ${plan.supportingCharacterCount} supporting characters ` +
        `but found ${supportingCharacters.length}`,
    });
  }

  const requiredEvidenceIds = new Set(caseArtifact.solution.requiredEvidenceIds);
  const characterById = new Map(
    caseArtifact.characters.map((character) => [character.id, character]),
  );
  const witnessInterviewCharacterIds = new Set(
    caseArtifact.evidence
      .filter(
        (evidence) =>
          requiredEvidenceIds.has(evidence.id) &&
          evidence.critical &&
          evidence.discovery.method === "interview" &&
          Boolean(evidence.discovery.characterId),
      )
      .map((evidence) => evidence.discovery.characterId!)
      .filter(
        (characterId) => characterById.get(characterId)?.roleTier === "witness",
      ),
  );
  if (witnessInterviewCharacterIds.size < plan.minimumWitnessInterviewCharacters) {
    issues.push({
      code: "insufficient_supporting_interview_characters",
      path: "solution.requiredEvidenceIds",
      message:
        `expected critical interview evidence from at least ${plan.minimumWitnessInterviewCharacters} ` +
        "distinct witness characters in the required solution chain",
    });
  }

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
