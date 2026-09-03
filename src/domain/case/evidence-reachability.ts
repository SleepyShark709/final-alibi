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

/**
 * 玩家刚开局、不依赖任何已发现线索时，可从已开放场景直接取得的证据。
 * 它与完整可达性不同：不展开解锁规则，也不接受任何前置证据。
 */
export function findInitiallyDiscoverableSceneEvidenceIds(
  caseArtifact: CaseArtifact,
): Set<string> {
  const initiallyUnlockedSceneIds = new Set(
    caseArtifact.scenes
      .filter((scene) => scene.initiallyUnlocked)
      .map((scene) => scene.id),
  );
  const characterUnlockTargets = new Set(
    caseArtifact.unlockRules
      .filter((rule) => rule.targetType === "character")
      .map((rule) => rule.targetId),
  );
  const initiallyUnlockedCharacterIds = new Set(
    caseArtifact.characters
      .filter(
        (character) =>
          (character.roleTier === "suspect" || character.roleTier === "witness") &&
          !characterUnlockTargets.has(character.id),
      )
      .map((character) => character.id),
  );
  const noEvidence = new Set<string>();

  return new Set(
    caseArtifact.evidence
      .filter((evidence) => {
        // interview 必须由玩家主动与角色对话取得；sceneId 只描述访谈发生地，
        // 不能让一份证词在玩家进入场景时就像物件线索一样自动可见。
        if (
          !evidence.discovery.sceneId ||
          evidence.discovery.method === "interview"
        ) {
          return false;
        }
        const evidenceUnlockRules = caseArtifact.unlockRules.filter(
          (rule) => rule.targetType === "evidence" && rule.targetId === evidence.id,
        );
        const evidenceUnlockedAtStart =
          evidenceUnlockRules.length === 0 ||
          evidenceUnlockRules.some((rule) =>
            unlockRuleIsSatisfied(rule, noEvidence),
          );
        return (
          evidenceUnlockedAtStart &&
          evidence.discovery.prerequisiteEvidenceIds.length === 0 &&
          initiallyUnlockedSceneIds.has(evidence.discovery.sceneId) &&
          (!evidence.discovery.characterId ||
            initiallyUnlockedCharacterIds.has(evidence.discovery.characterId))
        );
      })
      .map((evidence) => evidence.id),
  );
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
