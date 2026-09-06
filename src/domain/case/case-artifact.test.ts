import { describe, expect, it } from "vitest";

import {
  applyCaseArtifactRepairPatch,
  caseArtifactRepairPatchSchema,
  parseCaseArtifact,
} from "./case-artifact";

const minimalCaseArtifact = {
  schemaVersion: 1,
  id: "case_minimal",
  seed: "minimal-seed",
  title: "书房里的秘密",
  briefing: "一名收藏家被发现死在上锁的书房里。",
  setting: {
    era: "contemporary",
    place: "临江别墅",
    occurredAt: "2026-08-30T20:00:00+08:00",
  },
  victimId: "character_victim",
  culpritId: "character_suspect",
  characters: [
    {
      id: "character_victim",
      name: "林正德",
      roleTier: "victim",
      occupation: "收藏家",
      publicProfile: "别墅的主人。",
      privateProfile: "准备公开一份伪造账目。",
      portraitTags: {
        gender: "male",
        ageGroup: "senior",
        temperament: ["严肃"],
      },
      knowledge: { factIds: [], evidenceIds: [], claimIds: [] },
      secretFactIds: [],
      lieRules: [],
    },
    {
      id: "character_suspect",
      name: "周启明",
      roleTier: "suspect",
      occupation: "会计",
      publicProfile: "负责管理收藏家的账目。",
      privateProfile: "为掩盖挪用资金而杀害收藏家。",
      portraitTags: {
        gender: "male",
        ageGroup: "middle",
        temperament: ["谨慎"],
      },
      knowledge: {
        factIds: ["fact_motive", "fact_method"],
        evidenceIds: ["evidence_receipt"],
        claimIds: ["claim_alibi"],
      },
      secretFactIds: ["fact_motive", "fact_method"],
      lieRules: [
        {
          factId: "fact_method",
          strategy: "fabricate_cover",
          coverStatement: "案发时我一直在楼下接电话。",
        },
      ],
    },
  ],
  scenes: [
    {
      id: "scene_study",
      name: "书房",
      description: "门窗紧闭，书桌上的文件散落一地。",
      initiallyUnlocked: true,
      objects: [
        {
          id: "object_desk",
          name: "书桌",
          description: "一张宽大的胡桃木书桌。",
          actionAliases: ["检查书桌", "翻找抽屉"],
          evidenceIds: ["evidence_receipt"],
        },
      ],
    },
  ],
  facts: [
    {
      id: "fact_motive",
      type: "motive",
      statement: "周启明挪用了收藏家的资金。",
    },
    {
      id: "fact_method",
      type: "method",
      statement: "周启明用镇纸击中了收藏家。",
    },
  ],
  timeline: [
    {
      id: "event_murder",
      timestamp: "2026-08-30T20:00:00+08:00",
      sceneId: "scene_study",
      characterIds: ["character_victim", "character_suspect"],
      factIds: ["fact_method"],
      description: "周启明在书房杀害了林正德。",
    },
  ],
  claims: [
    {
      id: "claim_alibi",
      speakerId: "character_suspect",
      kind: "lie",
      statement: "案发时我一直在楼下接电话。",
      factIds: ["fact_method"],
    },
  ],
  evidence: [
    {
      id: "evidence_receipt",
      name: "异常转账回执",
      description: "回执证明周启明挪用了资金。",
      kind: "document",
      supportsFactIds: ["fact_motive"],
      contradictsClaimIds: [],
      implicatesCharacterIds: ["character_suspect"],
      excludesCharacterIds: [],
      critical: true,
      discovery: {
        method: "inspect",
        sceneId: "scene_study",
        objectId: "object_desk",
        actionAliases: ["检查书桌", "翻找抽屉"],
        prerequisiteEvidenceIds: [],
      },
    },
  ],
  unlockRules: [],
  hintChains: [
    {
      id: "hint_motive",
      targetFactId: "fact_motive",
      hints: ["留意账目。", "检查书桌。", "翻找书桌抽屉里的回执。"],
    },
  ],
  solution: {
    culpritId: "character_suspect",
    motiveFactId: "fact_motive",
    methodFactId: "fact_method",
    requiredEvidenceIds: ["evidence_receipt"],
    requiredTimelineEventIds: ["event_murder"],
  },
} as const;

describe("parseCaseArtifact", () => {
  it("parses a structurally valid case artifact", () => {
    const parsed = parseCaseArtifact(minimalCaseArtifact);

    expect({ id: parsed.id, title: parsed.title }).toEqual({
      id: "case_minimal",
      title: "书房里的秘密",
    });
  });

  it("deeply freezes a parsed case artifact", () => {
    const parsed = parseCaseArtifact(minimalCaseArtifact);

    expect([
      Object.isFrozen(parsed),
      Object.isFrozen(parsed.characters),
      Object.isFrozen(parsed.characters[0]),
    ]).toEqual([true, true, true]);
  });

  it("changes a scene's unlock state without replacing its public text or objects", () => {
    const artifact = parseCaseArtifact(minimalCaseArtifact);
    const patch = caseArtifactRepairPatchSchema.parse({ scenes: [{ id: "scene_study", initiallyUnlocked: false }] });
    const repaired = applyCaseArtifactRepairPatch(artifact, patch);
    expect(repaired.scenes[0]).toEqual({ ...artifact.scenes[0], initiallyUnlocked: false });
    expect(repaired.evidence).toEqual(artifact.evidence);
  });

  it("still rejects an incomplete new scene when applying a partial scene patch", () => {
    const artifact = parseCaseArtifact(minimalCaseArtifact);
    const patch = caseArtifactRepairPatchSchema.parse({ scenes: [{ id: "scene_incomplete_new", initiallyUnlocked: false }] });
    expect(() => applyCaseArtifactRepairPatch(artifact, patch)).toThrow();
  });

  it("allows a compact repair to remove an unreferenced supporting character", () => {
    const parsed = parseCaseArtifact({
      ...minimalCaseArtifact,
      characters: [
        ...minimalCaseArtifact.characters,
        {
          id: "character_witness",
          name: "许安",
          roleTier: "witness",
          occupation: "物业管理员",
          publicProfile: "负责别墅的日常巡查。",
          privateProfile: "没有掌握本案的核心信息。",
          portraitTags: {
            gender: "female",
            ageGroup: "young",
            temperament: ["谨慎"],
          },
          knowledge: { factIds: [], evidenceIds: [], claimIds: [] },
          secretFactIds: [],
          lieRules: [],
        },
      ],
    });

    const repaired = applyCaseArtifactRepairPatch(parsed, {
      removeCharacterIds: ["character_witness"],
    });

    expect(repaired.characters.map((character) => character.id)).toEqual([
      "character_victim",
      "character_suspect",
    ]);
    expect(() =>
      applyCaseArtifactRepairPatch(parsed, {
        removeCharacterIds: ["character_suspect"],
      }),
    ).toThrow("repair patches cannot remove missing characters, the victim or the culprit");
  });

  it("allows a compact repair to remove an extra non-culprit suspect", () => {
    const parsed = parseCaseArtifact({
      ...minimalCaseArtifact,
      characters: [...minimalCaseArtifact.characters, { ...minimalCaseArtifact.characters[1], id: "character_extra_suspect", name: "多余嫌疑人" }],
    });
    const repaired = applyCaseArtifactRepairPatch(parsed, { removeCharacterIds: ["character_extra_suspect"] });
    expect(repaired.characters.map((character) => character.id)).toEqual(["character_victim", "character_suspect"]);
  });

  it.each(["character_victim", "character_suspect", "character_missing"])("keeps protected or unknown character %s out of removal patches", (characterId) => {
    expect(() => applyCaseArtifactRepairPatch(parseCaseArtifact(minimalCaseArtifact), { removeCharacterIds: [characterId] })).toThrow("repair patches cannot remove missing characters, the victim or the culprit");
  });

  it("allows nine character updates while rejecting a tenth", () => {
    const characters = Array.from({ length: 9 }, (_, index) => ({ id: `character_update_${index}`, publicProfile: "到场参加晚宴。" }));
    expect(caseArtifactRepairPatchSchema.safeParse({ characters }).success).toBe(true);
    expect(caseArtifactRepairPatchSchema.safeParse({ characters: [...characters, { id: "character_update_ten" }] }).success).toBe(false);
  });

  it("deeply merges a discovery prerequisite patch without replacing its route", () => {
    const parsed = parseCaseArtifact(minimalCaseArtifact);
    const before = parsed.evidence[0]!.discovery;

    const repaired = applyCaseArtifactRepairPatch(parsed, {
      evidence: [{
        id: parsed.evidence[0]!.id,
        discovery: { prerequisiteEvidenceIds: [parsed.evidence[0]!.id] },
      }],
    });

    expect(repaired.evidence[0]!.discovery).toEqual({
      ...before,
      prerequisiteEvidenceIds: [parsed.evidence[0]!.id],
    });
  });

  it("still requires a complete discovery route when a patch adds new evidence", () => {
    const parsed = parseCaseArtifact(minimalCaseArtifact);

    expect(() => applyCaseArtifactRepairPatch(parsed, {
      evidence: [{
        id: "evidence_new",
        discovery: { prerequisiteEvidenceIds: [] },
      }],
    })).toThrow();
  });

});
