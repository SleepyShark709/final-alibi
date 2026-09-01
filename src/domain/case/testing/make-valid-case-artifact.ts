import { parseCaseArtifact, type CaseArtifact } from "../case-artifact";

export function makeValidCaseArtifact(): CaseArtifact {
  return parseCaseArtifact({
    schemaVersion: 1,
    id: "case_valid",
    seed: "valid-seed",
    title: "可验证案件",
    briefing: "用于验证领域规则的已知正确案件。",
    setting: {
      era: "contemporary",
      place: "测试别墅",
      occurredAt: "2026-08-30T20:00:00+08:00",
    },
    victimId: "character_victim",
    culpritId: "character_suspect_a",
    characters: [
      makeCharacter("character_victim", "受害者", "victim"),
      makeCharacter("character_suspect_a", "嫌疑人甲", "suspect", [
        "fact_motive",
        "fact_method",
      ]),
      makeCharacter("character_suspect_b", "嫌疑人乙", "suspect"),
      makeCharacter("character_suspect_c", "嫌疑人丙", "suspect"),
      makeCharacter("character_suspect_d", "嫌疑人丁", "suspect"),
      makeCharacter("character_witness_a", "证人甲", "witness"),
      makeCharacter("character_witness_b", "证人乙", "witness"),
    ],
    scenes: [
      {
        id: "scene_study",
        name: "书房",
        description: "案件发生的房间。",
        initiallyUnlocked: true,
        objects: [
          {
            id: "object_desk",
            name: "书桌",
            description: "放有关键证据的书桌。",
            actionAliases: ["检查书桌"],
            evidenceIds: ["evidence_key"],
          },
        ],
      },
    ],
    facts: [
      {
        id: "fact_motive",
        type: "motive",
        statement: "嫌疑人甲有明确作案动机。",
      },
      {
        id: "fact_method",
        type: "method",
        statement: "嫌疑人甲使用了案发现场的凶器。",
      },
    ],
    timeline: [
      {
        id: "event_murder",
        timestamp: "2026-08-30T20:00:00+08:00",
        sceneId: "scene_study",
        characterIds: ["character_victim", "character_suspect_a"],
        factIds: ["fact_method"],
        description: "嫌疑人甲在书房实施犯罪。",
      },
    ],
    claims: [],
    evidence: [
      {
        id: "evidence_key",
        name: "关键证据",
        description: "同时指向嫌疑人甲并排除其他嫌疑人。",
        kind: "physical",
        supportsFactIds: ["fact_motive", "fact_method"],
        contradictsClaimIds: [],
        implicatesCharacterIds: ["character_suspect_a"],
        excludesCharacterIds: [
          "character_suspect_b",
          "character_suspect_c",
          "character_suspect_d",
        ],
        critical: true,
        discovery: {
          method: "inspect",
          sceneId: "scene_study",
          objectId: "object_desk",
          actionAliases: ["检查书桌"],
          prerequisiteEvidenceIds: [],
        },
      },
    ],
    unlockRules: [],
    hintChains: [
      {
        id: "hint_method",
        targetFactId: "fact_method",
        hints: ["检查现场。", "留意书桌。", "检查书桌上的关键证据。"],
      },
    ],
    solution: {
      culpritId: "character_suspect_a",
      motiveFactId: "fact_motive",
      methodFactId: "fact_method",
      requiredEvidenceIds: ["evidence_key"],
      requiredTimelineEventIds: ["event_murder"],
    },
  });
}

function makeCharacter(
  id: string,
  name: string,
  roleTier: "victim" | "suspect" | "witness",
  secretFactIds: string[] = [],
) {
  return {
    id,
    name,
    roleTier,
    occupation: "测试角色",
    publicProfile: `${name}的公开资料。`,
    privateProfile: `${name}的私有资料。`,
    portraitTags: {
      gender: "male" as const,
      ageGroup: "middle" as const,
      temperament: ["冷静"],
    },
    knowledge: {
      factIds: secretFactIds,
      evidenceIds: [],
      claimIds: [],
    },
    secretFactIds,
    lieRules: [],
  };
}
