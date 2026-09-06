import { describe, expect, it } from "vitest";

import { solveCase } from "@/domain/case/case-solver";
import { validateCaseArtifact } from "@/domain/case/case-validator";
import { publicCharacterProfile } from "@/domain/case/public-information";
import {
  buildDeterministicDialogueShortcut,
  getPlayerCaseView,
  performInvestigation,
  recordDialogueTurn,
  startGame,
  submitCaseReport,
} from "@/domain/game/game-runtime";

import { tutorialCase } from "./tutorial-case";

describe("tutorialCase", () => {
  it("preserves family relationships and attendance reasons without revealing private disputes", () => {
    const daughter = tutorialCase.characters.find((character) => character.id === "character_shen_lan")!;
    const formerAssistant = tutorialCase.characters.find((character) => character.id === "character_zhao_heng")!;

    expect(publicCharacterProfile(daughter)).toBe(daughter.publicProfile);
    expect(publicCharacterProfile(daughter)).toContain("顾明远的女儿");
    expect(publicCharacterProfile(daughter)).toContain("参加晚宴");
    expect(publicCharacterProfile(formerAssistant)).toBe(formerAssistant.publicProfile);
    expect(publicCharacterProfile(formerAssistant)).toContain("管理日程");
    expect(publicCharacterProfile(formerAssistant)).toContain("整理寄存物品");
    expect(`${daughter.publicProfile}${formerAssistant.publicProfile}`).not.toMatch(/遗产|争执|辞退/);
    expect(tutorialCase.facts.find((fact) => fact.id === "fact_relationship_shen")?.statement).toContain("遗产");
    expect(tutorialCase.facts.find((fact) => fact.id === "fact_context_zhao_fired")?.statement).toContain("辞退");
  });

  it("is a valid, uniquely solvable seven-character case", () => {
    const validation = validateCaseArtifact(tutorialCase);
    const solution = solveCase(tutorialCase);

    expect({
      validation,
      solutionStatus: solution.status,
      culpritId: solution.culpritId,
      characterCount: tutorialCase.characters.length,
      suspectCount: tutorialCase.characters.filter(
        (character) => character.roleTier === "suspect",
      ).length,
      sceneCount: tutorialCase.scenes.length,
      evidenceCount: tutorialCase.evidence.length,
    }).toEqual({
      validation: { valid: true, issues: [] },
      solutionStatus: "unique",
      culpritId: "character_li_wenzhou",
      characterCount: 7,
      suspectCount: 4,
      sceneCount: 3,
      evidenceCount: 11,
    });
  });

  it("does not grant complete conclusions from partial laboratory, account, or card records", () => {
    const evidence = (id: string) => tutorialCase.evidence.find((item) => item.id === id)!;

    expect(evidence("evidence_teacup_residue").supportsFactIds).not.toContain(tutorialCase.solution.methodFactId);
    expect(evidence("evidence_transfer_ledger").supportsFactIds).not.toContain(tutorialCase.solution.motiveFactId);
    expect(evidence("evidence_smart_lock_log").supportsFactIds).not.toContain("fact_opportunity_stolen_card");
    expect(evidence("evidence_smart_lock_log").implicatesCharacterIds).toEqual([]);
    expect(evidence("evidence_smart_lock_log").contradictsClaimIds).toEqual([]);
    expect(evidence("evidence_brass_bookend").contradictsClaimIds).toEqual([]);
  });

  it("requires the missing source before granting each combined conclusion or exclusion", () => {
    const pairs = [
      ["evidence_teacup_residue", "evidence_housekeeper_testimony"],
      ["evidence_brass_bookend", "evidence_teacup_residue"],
      ["evidence_torn_audit_memo", "evidence_transfer_ledger"],
      ["evidence_camera_reflection", "evidence_smart_lock_log"],
      ["evidence_paint_curing_record", "evidence_broken_watch"],
      ["evidence_paint_curing_record", "evidence_teacup_residue"],
      ["evidence_elevator_log", "evidence_broken_watch"],
      ["evidence_elevator_log", "evidence_teacup_residue"],
    ] as const;

    for (const [targetId, missingSourceId] of pairs) {
      const target = tutorialCase.evidence.find((item) => item.id === targetId)!;
      const session = {
        ...startGame(tutorialCase),
        unlockedSceneIds: tutorialCase.scenes.map((scene) => scene.id),
        discoveredEvidenceIds: tutorialCase.evidence
          .filter((item) => item.id !== targetId && item.id !== missingSourceId)
          .map((item) => item.id),
      };
      const result = performInvestigation(tutorialCase, session, {
        commandId: `blocked_${targetId}_${missingSourceId}`,
        text: target.discovery.actionAliases[0]!,
        sceneId: target.discovery.sceneId,
        objectId: target.discovery.objectId,
      });

      expect(result.outcome.discoveredEvidenceIds, `${targetId} needs ${missingSourceId}`).not.toContain(targetId);
    }
  });

  it("can obtain the full proof through existing actions and delivered interview materials", () => {
    let session = startGame(tutorialCase);
    const opening = getPlayerCaseView(tutorialCase, session);
    expect(opening.scenes.flatMap((scene) => scene.objects).find((object) => object.id === "object_tea_tray")?.description)
      .not.toContain("李闻舟");

    const route = [
      "evidence_broken_watch",
      "evidence_housekeeper_testimony",
      "evidence_teacup_residue",
      "evidence_brass_bookend",
      "evidence_transfer_ledger",
      "evidence_torn_audit_memo",
      "evidence_smart_lock_log",
      "evidence_camera_reflection",
      "evidence_paint_curing_record",
      "evidence_elevator_log",
      "evidence_livestream_record",
    ];
    for (const id of route) {
      const item = tutorialCase.evidence.find((evidence) => evidence.id === id)!;
      const { discovery } = item;
      if (discovery.method === "interview") {
        const playerText = discovery.dialogueAliases![0]!;
        const response = buildDeterministicDialogueShortcut(tutorialCase, session, discovery.characterId!, playerText);
        expect(response, id).not.toBeNull();
        session = recordDialogueTurn(tutorialCase, session, {
          commandId: id,
          characterId: discovery.characterId!,
          playerText,
          response: response!,
        }).session;
      } else {
        session = performInvestigation(tutorialCase, session, {
          commandId: id,
          text: discovery.actionAliases[0]!,
          sceneId: discovery.sceneId,
          objectId: discovery.objectId,
        }).session;
      }
      expect(session.discoveredEvidenceIds, id).toContain(id);
    }

    expect(new Set(tutorialCase.solution.requiredEvidenceIds)).toEqual(new Set(route));
    expect(session.dialogue.at(-1)?.utterance).toContain("已经");
    expect(session.dialogue.at(-1)?.utterance).not.toContain("可以提供");
    const submitted = submitCaseReport(tutorialCase, session, {
      commandId: "submit_tutorial_proof",
      culpritId: tutorialCase.solution.culpritId,
      motiveFactId: tutorialCase.solution.motiveFactId,
      methodFactId: tutorialCase.solution.methodFactId,
      evidenceIds: tutorialCase.solution.requiredEvidenceIds,
      timelineEventIds: tutorialCase.solution.requiredTimelineEventIds,
      reasoning: "原始时间与毒理材料限定两段实施机会，连续本人原片排除其他嫌疑人，财务、书挡及持卡入室材料形成完整证据链。",
    });
    expect(submitted.outcome.report.verdict).toBe("solved");
    expect(submitted.outcome.report.score).toBe(100);
  });
});
