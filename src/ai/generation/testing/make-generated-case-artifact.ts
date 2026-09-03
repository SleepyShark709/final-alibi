import { tutorialCase } from "@/content/tutorial/tutorial-case";
import {
  parseCaseArtifact,
  type CaseArtifact,
} from "@/domain/case/case-artifact";
import { findInitiallyDiscoverableSceneEvidenceIds } from "@/domain/case/evidence-reachability";

import { deriveGenerationPlan } from "../generation-plan";

/**
 * 生成链路测试用的有效账本：保留教程的可解结构，同时满足生成案件特有的
 * seed 人物规模、双 witness 访谈和首发场景节奏约束。
 */
export function makeGeneratedCaseArtifact(
  id: string,
  seed: string,
  title = tutorialCase.title,
): CaseArtifact {
  const draft = structuredClone(tutorialCase);
  draft.id = id;
  draft.seed = seed;
  draft.title = title;

  const elevatorInterview = draft.evidence.find(
    (evidence) => evidence.id === "evidence_elevator_log",
  );
  if (!elevatorInterview) {
    throw new Error("Tutorial elevator evidence is missing");
  }
  elevatorInterview.discovery = {
    method: "interview",
    sceneId: "scene_security_room",
    characterId: "character_han_zhuo",
    actionAliases: ["询问韩卓货梯记录", "核实赵衡的不在场证明"],
    dialogueAliases: [
      "货梯记录显示了什么",
      "赵衡案发时在哪里",
      "你能核实货梯行程吗",
    ],
    dialogueUtterance:
      "货梯日志显示赵衡在案发时只往返一楼和地下仓库，没有到过二楼。",
    prerequisiteEvidenceIds: ["evidence_torn_audit_memo"],
  };

  const targetSupportingCharacterCount = deriveGenerationPlan(
    seed,
  ).supportingCharacterCount;
  const supportingCharacters = draft.characters.filter(
    (character) =>
      character.roleTier === "witness" || character.roleTier === "referenced",
  );
  const witnessTemplate = draft.characters.find(
    (character) => character.roleTier === "witness",
  );
  if (!witnessTemplate) throw new Error("Tutorial witness is missing");
  for (
    let index = supportingCharacters.length;
    index < targetSupportingCharacterCount;
    index += 1
  ) {
    draft.characters.push({
      ...structuredClone(witnessTemplate),
      id: `character_referenced_${index + 1}`,
      name: `关联人员${index + 1}`,
      roleTier: "referenced",
      publicProfile: "与案件存在外围关联，暂时不参与直接问询。",
      privateProfile: "掌握的背景信息尚未进入本案核心证据链。",
      knowledge: { factIds: [], evidenceIds: [], claimIds: [] },
      secretFactIds: [],
      lieRules: [],
    });
  }

  const initialSceneEvidenceIds = findInitiallyDiscoverableSceneEvidenceIds(draft);
  const redactSuspectNames = (text: string) =>
    draft.characters
      .filter((character) => character.roleTier === "suspect")
      .map((character) => character.name)
      .reduce(
        (redacted, suspectName) => redacted.replaceAll(suspectName, "某位嫌疑人"),
        text,
      )
      .replace(/真凶|凶手|作案者|杀人者/gu, "相关人员");
  draft.evidence = draft.evidence.map((evidence) =>
    initialSceneEvidenceIds.has(evidence.id)
      ? {
          ...evidence,
          name: redactSuspectNames(evidence.name),
          description: redactSuspectNames(evidence.description),
        }
      : evidence,
  );
  draft.facts = draft.facts.map((fact) => ({
    ...fact,
    statement: redactSuspectNames(fact.statement),
  }));

  return parseCaseArtifact(draft);
}
