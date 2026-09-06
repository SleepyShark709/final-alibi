import type { CaseArtifact } from "@/domain/case/case-artifact";
import type { CaseValidationIssue } from "@/domain/case/case-validator";
import { findReachableEvidenceIds } from "@/domain/case/evidence-reachability";
import { claimCanBeDisclosed, startGame } from "@/domain/game/game-runtime";

import { publicWindowSchema, type EvidenceReviewResult, type PublicWindow } from "./generation-schema";

type Aspect = EvidenceReviewResult["results"][number]["citations"][number]["aspects"][number];
type ReviewKind = "supports" | "implicates" | "excludes" | "contradicts" | "interview_lead" | "record_delivery" | "public_window";

export interface EvidenceReviewPlan {
  sources: Array<{ id: string; path: string; text: string; evidenceId?: string }>;
  obligations: Array<{
    id: string;
    kind: ReviewKind;
    evidenceId?: string;
    targetId?: string;
    path: string;
    allowedSourceIds: string[];
    requiredAspects: Aspect[];
  }>;
}

/** 来源编号指向完整原文字段，避免模型裁掉否定、时间或身份限定后引用。 */
export function buildEvidenceReviewPlan(artifact: CaseArtifact): EvidenceReviewPlan {
  const plan: EvidenceReviewPlan = { sources: [], obligations: [] };
  const reachable = findReachableEvidenceIds(artifact);
  const evidenceSources = new Map<string, string[]>();
  const utteranceSources = new Map<string, string>();
  const addSource = (path: string, text: string, evidenceId?: string) => {
    const id = `s${plan.sources.length}`;
    plan.sources.push({ id, path, text, ...(evidenceId ? { evidenceId } : {}) });
    return id;
  };
  const addObligation = (obligation: Omit<EvidenceReviewPlan["obligations"][number], "id">) => {
    plan.obligations.push({ id: `o${plan.obligations.length}`, ...obligation });
  };

  artifact.evidence.forEach((evidence, index) => {
    if (!reachable.has(evidence.id)) return;
    const sources: string[] = [];
    if (evidence.discovery.method === "interview" && evidence.discovery.dialogueUtterance) {
      const source = addSource(`evidence[${index}].discovery.dialogueUtterance`, evidence.discovery.dialogueUtterance, evidence.id);
      sources.push(source);
      utteranceSources.set(evidence.id, source);
    }
    // 访谈交付的实物/原始记录须另通过 record_delivery；普通口供的旁白永不作证明。
    if (evidence.discovery.method !== "interview" || evidence.kind !== "testimony") {
      sources.push(addSource(`evidence[${index}].description`, evidence.description, evidence.id));
    }
    evidenceSources.set(evidence.id, sources);
  });

  const prerequisiteIds = (evidenceId: string, visited = new Set<string>()): Set<string> => {
    if (visited.has(evidenceId)) return visited;
    visited.add(evidenceId);
    for (const id of artifact.evidence.find((item) => item.id === evidenceId)?.discovery.prerequisiteEvidenceIds ?? []) {
      prerequisiteIds(id, visited);
    }
    return visited;
  };
  const sourceIdsFor = (ids: Iterable<string>) => [...ids].flatMap((id) => evidenceSources.get(id) ?? []);
  const requiredClosure = new Set(artifact.solution.requiredEvidenceIds.flatMap((id) => [...prerequisiteIds(id)]));
  const briefingSourceId = addSource("briefing", artifact.briefing);

  addObligation({
    kind: "public_window", path: "timeline", allowedSourceIds: [...sourceIdsFor(reachable), briefingSourceId], requiredAspects: ["window"],
  });

  const publicSources: Array<{ id: string; sceneId?: string; characterId?: string; claimId?: string }> = [
    { id: briefingSourceId },
  ];
  artifact.characters.forEach((character, index) => {
    publicSources.push({ id: addSource(`characters[${index}].publicProfile`, character.publicProfile), characterId: character.id });
    publicSources.push({ id: addSource(`characters[${index}].occupation`, character.occupation), characterId: character.id });
    character.knowledge.claimIds.forEach((claimId) => {
      const claim = artifact.claims.find((item) => item.id === claimId && item.speakerId === character.id && item.kind !== "withheld");
      if (claim) publicSources.push({ id: addSource(`claims[${artifact.claims.indexOf(claim)}].statement`, claim.statement), characterId: character.id, claimId: claim.id });
    });
  });
  artifact.scenes.forEach((scene, index) => {
    publicSources.push({ id: addSource(`scenes[${index}].description`, scene.description), sceneId: scene.id });
    scene.objects.forEach((object, objectIndex) => {
      publicSources.push({ id: addSource(`scenes[${index}].objects[${objectIndex}].description`, object.description), sceneId: scene.id });
    });
  });
  const isUnlocked = (type: "scene" | "character", id: string, ids: Set<string>) => {
    const rules = artifact.unlockRules.filter((rule) => rule.targetType === type && rule.targetId === id);
    return (type === "scene" ? artifact.scenes.some((scene) => scene.id === id && scene.initiallyUnlocked) : rules.length === 0) ||
      rules.some((rule) => rule.allEvidenceIds.every((item) => ids.has(item)) && (rule.anyEvidenceIds.length === 0 || rule.anyEvidenceIds.some((item) => ids.has(item))));
  };

  artifact.evidence.forEach((evidence, index) => {
    if (!reachable.has(evidence.id)) return;
    const path = `evidence[${index}]`;
    const allowedSourceIds = sourceIdsFor(prerequisiteIds(evidence.id));
    const relations = [
      ["supports", evidence.supportsFactIds], ["implicates", evidence.implicatesCharacterIds],
      ["excludes", evidence.excludesCharacterIds], ["contradicts", evidence.contradictsClaimIds],
    ] as const;
    for (const [kind, ids] of relations) {
      ids.forEach((targetId) => addObligation({
        kind, evidenceId: evidence.id, targetId, path, allowedSourceIds,
        requiredAspects: kind === "excludes" ? ["identity", "location", "window"]
          : kind === "supports" && artifact.facts.some((fact) => fact.id === targetId && fact.type === "alibi")
            ? ["basis", "identity", "location", "window"] : ["basis"],
      }));
    }
    if (evidence.discovery.method !== "interview") return;
    if (evidence.kind !== "testimony") {
      addObligation({
        kind: "record_delivery", evidenceId: evidence.id, path,
        allowedSourceIds: [utteranceSources.get(evidence.id), ...sourceIdsFor([...prerequisiteIds(evidence.id)].filter((id) => id !== evidence.id))].filter((id): id is string => id !== undefined),
        requiredAspects: ["basis"],
      });
    }
    if (!requiredClosure.has(evidence.id)) return;
    const leadIds = findReachableEvidenceIds({ ...artifact, evidence: artifact.evidence.filter((item) => item.id !== evidence.id) });
    const leadSession = {
      ...startGame(artifact, { sessionId: "evidence_review", now: artifact.setting.occurredAt }),
      discoveredEvidenceIds: [...leadIds],
      unlockedSceneIds: artifact.scenes.filter((scene) => isUnlocked("scene", scene.id, leadIds)).map((scene) => scene.id),
      unlockedCharacterIds: artifact.characters.filter((character) => isUnlocked("character", character.id, leadIds)).map((character) => character.id),
    };
    addObligation({
      kind: "interview_lead", evidenceId: evidence.id, path: `${path}.discovery.dialogueAliases`,
      allowedSourceIds: [
        ...publicSources.filter((source) =>
          (!source.sceneId || isUnlocked("scene", source.sceneId, leadIds)) &&
          (!source.characterId || isUnlocked("character", source.characterId, leadIds)) &&
          (!source.claimId || claimCanBeDisclosed(artifact, leadSession, source.characterId!, source.claimId)),
        ).map((source) => source.id),
        ...sourceIdsFor(leadIds),
      ],
      requiredAspects: ["basis"],
    });
  });
  return plan;
}

function hasOrderedBounds(window: PublicWindow): boolean {
  return publicWindowSchema.safeParse(window).success && Date.parse(window.startAt) < Date.parse(window.endAt);
}

function requiresPublicWindow(obligation: EvidenceReviewPlan["obligations"][number]): boolean {
  return obligation.kind === "excludes" || obligation.kind === "supports" && obligation.requiredAspects.includes("window");
}

function intervalContractIssue(
  plan: EvidenceReviewPlan,
  obligation: EvidenceReviewPlan["obligations"][number],
  result: EvidenceReviewResult["results"][number],
): string | null {
  if (obligation.kind !== "public_window" && result.publicWindow) return "只有 public_window 义务可以返回公开窗口，其他结果不得替换上游窗口。";
  if (!requiresPublicWindow(obligation) && result.coverage) return "只有 excludes 或不在场 supports 可以返回 coverage，其他义务不得夹带覆盖区间。";
  if (result.verdict !== "supported") return null;
  if (obligation.kind !== "public_window" && !requiresPublicWindow(obligation)) return null;
  const window = obligation.kind === "public_window" ? result.publicWindow : result.coverage;
  const name = obligation.kind === "public_window" ? "公开窗口 publicWindow" : "不在场覆盖区间 coverage";
  if (!window || !hasOrderedBounds(window)) return `${name} 必须提供有效 startAt/endAt 双界且 startAt < endAt；不能缺界、倒序或缩为单点。`;
  const boundIds = [...window.startSourceIds, ...window.endSourceIds];
  if (boundIds.some((id) => !obligation.allowedSourceIds.includes(id) || !plan.sources.some((source) => source.id === id) ||
    !result.citations.some((citation) => citation.sourceId === id && citation.aspects.includes("window")))) {
    return `${name} 上下界的来源必须分别属于本义务获准原文，并在 citations 中以 window 方面引用。`;
  }
  return null;
}

/** 只有完整公开来源审核通过的双界窗口，才可交给后续不在场审核。 */
export function extractPublicWindow(plan: EvidenceReviewPlan, review: EvidenceReviewResult): PublicWindow | null {
  const obligations = plan.obligations.filter((item) => item.kind === "public_window");
  if (obligations.length !== 1) return null;
  const obligation = obligations[0]!;
  const results = review.results.filter((item) => item.obligationId === obligation.id);
  const result = results[0];
  if (results.length !== 1 || !result || result.verdict !== "supported" || intervalContractIssue(plan, obligation, result) ||
    result.citations.some((citation) => !obligation.allowedSourceIds.includes(citation.sourceId))) return null;
  return result.publicWindow!;
}

/** 完整覆盖与原文来源是代码门禁；关系是否蕴含命题仍由独立模型核验。 */
export function validateEvidenceReview(
  plan: EvidenceReviewPlan,
  review: EvidenceReviewResult,
  publicWindow?: PublicWindow | null,
): CaseValidationIssue[] {
  const issues: CaseValidationIssue[] = [];
  const window = plan.obligations.some((item) => item.kind === "public_window")
    ? extractPublicWindow(plan, review) : publicWindow && hasOrderedBounds(publicWindow) ? publicWindow : null;
  const expected = new Set(plan.obligations.map((item) => item.id));
  const returned = review.results.map((item) => item.obligationId);
  if (returned.length !== expected.size || new Set(returned).size !== returned.length || returned.some((id) => !expected.has(id))) {
    issues.push({ code: "evidence_review_incomplete", path: "evidence", message: "证据审核必须逐项且仅一次回答给定义务；缺少、重复或未知 obligationId 均不能放行。" });
  }
  for (const obligation of plan.obligations) {
    const result = review.results.find((item) => item.obligationId === obligation.id);
    if (!result) continue;
    const invalidSources = result.citations.filter((citation) => !obligation.allowedSourceIds.includes(citation.sourceId));
    const missingAspects = obligation.requiredAspects.filter((aspect) => !result.citations.some((citation) => citation.aspects.includes(aspect)));
    const windowIssue = intervalContractIssue(plan, obligation, result);
    const requiresWindow = requiresPublicWindow(obligation);
    const missingWindow = requiresWindow && !window;
    const insufficientCoverage = result.verdict === "supported" && requiresWindow && window && !windowIssue && result.coverage &&
      (Date.parse(result.coverage.startAt) > Date.parse(window.startAt) || Date.parse(result.coverage.endAt) < Date.parse(window.endAt));
    if (result.verdict === "supported" && invalidSources.length === 0 && missingAspects.length === 0 && !windowIssue && !missingWindow && !insufficientCoverage) continue;
    const reason = [
      result.reason,
      ...(invalidSources.length ? [`引用了本义务不能使用的来源：${invalidSources.map((item) => item.sourceId).join(", ")}。`] : []),
      ...(result.verdict === "supported" && missingAspects.length ? [`缺少原文依据：${missingAspects.join(", ")}。`] : []),
      ...(windowIssue ? [windowIssue] : []),
      ...(missingWindow ? ["尚无审核通过的完整公开作案窗口，不能确认不在场事实或排除关系；不得用内幕时刻或待验证命题代替。"] : []),
      ...(insufficientCoverage ? [`coverage ${result.coverage!.startAt} 至 ${result.coverage!.endAt} 未完整覆盖公开作案窗口 ${window!.startAt} 至 ${window!.endAt}；覆盖起点须不晚于窗口起点，覆盖终点须不早于窗口终点。`] : []),
    ].join(" ");
    const relation = { supports: "facts", implicates: "implications", excludes: "exclusions", contradicts: "contradictions" };
    issues.push({
      code: obligation.kind === "interview_lead" ? "missing_interview_lead" : "evidence_narrative_mismatch",
      path: obligation.path,
      message: `${obligation.evidenceId ?? "public_window"}: ${obligation.kind in relation ? `unsupported ${relation[obligation.kind as keyof typeof relation]} ${obligation.targetId}` : obligation.kind}; ${reason}`,
    });
  }
  return issues;
}

/** 完整的拒绝结论可以参与汇总；缺项、越域引用等协议损坏必须停止审核。 */
export function evidenceReviewHasProtocolViolation(plan: EvidenceReviewPlan, review: EvidenceReviewResult): boolean {
  const ids = review.results.map((result) => result.obligationId);
  if (ids.length !== plan.obligations.length || new Set(ids).size !== ids.length) return true;
  return review.results.some((result) => {
    const obligation = plan.obligations.find((item) => item.id === result.obligationId);
    return !obligation || intervalContractIssue(plan, obligation, result) !== null ||
      result.citations.some((citation) => !obligation.allowedSourceIds.includes(citation.sourceId)) ||
      (result.verdict === "supported" && obligation.requiredAspects.some((aspect) => !result.citations.some((citation) => citation.aspects.includes(aspect))));
  });
}
