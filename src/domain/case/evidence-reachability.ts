import type { CaseArtifact } from "./case-artifact";

/**
 * 以不依赖玩家操作顺序的固定点计算所有理论上可发现的证据。
 * 发布校验用它排除循环解锁或“只有知道答案才拿得到”的证据链。
 */
export function findReachableEvidenceIds(
  caseArtifact: CaseArtifact,
): Set<string> {
  const reachableEvidenceIds = new Set<string>();
  const unlockedSceneIds = new Set(
    caseArtifact.scenes
      .filter((scene) => scene.initiallyUnlocked)
      .map((scene) => scene.id),
  );
  const characterUnlockRules = caseArtifact.unlockRules.filter(
    (rule) => rule.targetType === "character",
  );
  const unlockedCharacterIds = new Set(
    caseArtifact.characters
      .filter(
        (character) =>
          (character.roleTier === "suspect" || character.roleTier === "witness") &&
          !characterUnlockRules.some((rule) => rule.targetId === character.id),
      )
      .map((character) => character.id),
  );
  let changed = true;

  while (changed) {
    changed = false;

    for (const rule of caseArtifact.unlockRules) {
      if (!unlockRuleIsSatisfied(rule, reachableEvidenceIds)) {
        continue;
      }

      if (rule.targetType === "scene" && !unlockedSceneIds.has(rule.targetId)) {
        unlockedSceneIds.add(rule.targetId);
        changed = true;
      }
      if (
        rule.targetType === "character" &&
        !unlockedCharacterIds.has(rule.targetId)
      ) {
        unlockedCharacterIds.add(rule.targetId);
        changed = true;
      }
    }

    for (const evidence of caseArtifact.evidence) {
      if (reachableEvidenceIds.has(evidence.id)) {
        continue;
      }

      const evidenceUnlockRules = caseArtifact.unlockRules.filter(
        (rule) => rule.targetType === "evidence" && rule.targetId === evidence.id,
      );
      const isUnlocked =
        evidenceUnlockRules.length === 0 ||
        evidenceUnlockRules.some((rule) =>
          unlockRuleIsSatisfied(rule, reachableEvidenceIds),
        );
      const prerequisitesMet = evidence.discovery.prerequisiteEvidenceIds.every(
        (id) => reachableEvidenceIds.has(id),
      );
      const sceneIsReachable =
        !evidence.discovery.sceneId ||
        unlockedSceneIds.has(evidence.discovery.sceneId);
      const characterIsReachable =
        !evidence.discovery.characterId ||
        unlockedCharacterIds.has(evidence.discovery.characterId);

      if (
        isUnlocked &&
        prerequisitesMet &&
        sceneIsReachable &&
        characterIsReachable
      ) {
        reachableEvidenceIds.add(evidence.id);
        changed = true;
      }
    }
  }

  return reachableEvidenceIds;
}

function unlockRuleIsSatisfied(
  rule: CaseArtifact["unlockRules"][number],
  discoveredEvidenceIds: ReadonlySet<string>,
): boolean {
  return (
    rule.allEvidenceIds.every((id) => discoveredEvidenceIds.has(id)) &&
    (rule.anyEvidenceIds.length === 0 ||
      rule.anyEvidenceIds.some((id) => discoveredEvidenceIds.has(id)))
  );
}
