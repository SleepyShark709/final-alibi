import type { CaseArtifact } from "./case-artifact";
import { findReachableEvidenceIds } from "./evidence-reachability";

export type CaseSolutionStatus =
  | "unique"
  | "ambiguous"
  | "inconsistent"
  | "unsupported";

export interface CaseSolutionResult {
  status: CaseSolutionStatus;
  culpritId: string | null;
  candidateIds: string[];
  evidenceIds: string[];
  supportedFactIds: string[];
}

/**
 * 确定性解题器是案件发布门禁，而不是给玩家展示的“推理 AI”。
 * 它只依据可达证据的结构关系，保证模型文案或随机性不会改变唯一解。
 */
export function solveCase(caseArtifact: CaseArtifact): CaseSolutionResult {
  const reachableEvidenceIds = findReachableEvidenceIds(caseArtifact);
  return solveCaseWithEvidenceIds(caseArtifact, reachableEvidenceIds);
}

export function solveCaseWithEvidenceIds(
  caseArtifact: CaseArtifact,
  evidenceIds: Iterable<string>,
): CaseSolutionResult {
  // 该变体专门验证 solution.requiredEvidenceIds：声明的最小链条本身也必须可定案。
  const suspectIds = caseArtifact.characters
    .filter((character) => character.roleTier === "suspect")
    .map((character) => character.id);
  const selectedEvidenceIds = new Set(evidenceIds);
  const reachableEvidence = caseArtifact.evidence.filter((evidence) =>
    selectedEvidenceIds.has(evidence.id),
  );
  const excludedIds = new Set(
    reachableEvidence.flatMap((evidence) => evidence.excludesCharacterIds),
  );
  const candidateIds = suspectIds.filter((id) => !excludedIds.has(id));
  const implicatedIds = new Set(
    reachableEvidence.flatMap((evidence) => evidence.implicatesCharacterIds),
  );
  const relevantEvidence = reachableEvidence.filter(
    (evidence) =>
      evidence.implicatesCharacterIds.some((id) => candidateIds.includes(id)) ||
      evidence.excludesCharacterIds.some((id) => suspectIds.includes(id)),
  );
  const supportedFactIds = [
    ...new Set(relevantEvidence.flatMap((evidence) => evidence.supportsFactIds)),
  ];

  if (candidateIds.length === 0) {
    return result("inconsistent", null);
  }

  if (candidateIds.length > 1) {
    return result("ambiguous", null);
  }

  const culpritId = candidateIds[0];
  const supportedFactTypes = new Set(
    caseArtifact.facts
      .filter((fact) => supportedFactIds.includes(fact.id))
      .map((fact) => fact.type),
  );
  const hasCompleteCase =
    implicatedIds.has(culpritId) &&
    supportedFactTypes.has("motive") &&
    supportedFactTypes.has("method");

  return result(hasCompleteCase ? "unique" : "unsupported", culpritId);

  function result(
    status: CaseSolutionStatus,
    resolvedCulpritId: string | null,
  ): CaseSolutionResult {
    return {
      status,
      culpritId: resolvedCulpritId,
      candidateIds,
      evidenceIds: relevantEvidence.map((evidence) => evidence.id),
      supportedFactIds,
    };
  }
}
