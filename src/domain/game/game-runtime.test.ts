import { describe, expect, it } from "vitest";

import { tutorialCase } from "@/content/tutorial/tutorial-case";

import {
  getCaseReview,
  getPlayerCaseView,
  performInvestigation,
  presentEvidence,
  recordDialogueTurn,
  requestHint,
  startGame,
  submitCaseReport,
  type GameSession,
} from "./game-runtime";

const startedAt = "2026-08-31T10:00:00+08:00";

describe("deterministic game runtime", () => {
  it("starts with only public, initially unlocked information", () => {
    const session = newSession();
    const view = getPlayerCaseView(tutorialCase, session);
    const serialized = JSON.stringify(view);

    expect({
      scenes: session.unlockedSceneIds,
      characters: session.unlockedCharacterIds,
      evidence: session.discoveredEvidenceIds,
      leaksPrivateProfile: serialized.includes("privateProfile"),
      leaksSolution: serialized.includes("culpritId"),
      leaksLieRules: serialized.includes("lieRules"),
    }).toEqual({
      scenes: ["scene_study", "scene_kitchen"],
      characters: [
        "character_li_wenzhou",
        "character_shen_lan",
        "character_zhao_heng",
        "character_chen_mo",
        "character_luo_fang",
      ],
      evidence: [],
      leaksPrivateProfile: false,
      leaksSolution: false,
      leaksLieRules: false,
    });
  });

  it("discovers evidence and applies progressive unlock rules", () => {
    const result = performInvestigation(tutorialCase, newSession(), {
      commandId: "command_find_memo",
      text: "我想检查碎纸篓",
      sceneId: "scene_study",
      now: "2026-08-31T10:01:00+08:00",
    });

    expect(result.outcome).toEqual({
      status: "discovered",
      discoveredEvidenceIds: ["evidence_torn_audit_memo"],
      unlockedSceneIds: ["scene_security_room"],
      unlockedCharacterIds: ["character_han_zhuo"],
    });
  });

  it("does not reveal evidence from a locked scene", () => {
    const result = performInvestigation(tutorialCase, newSession(), {
      commandId: "command_locked_log",
      text: "恢复门禁日志",
      sceneId: "scene_security_room",
    });

    expect(result.outcome.status).toBe("locked");
    expect(result.session.discoveredEvidenceIds).toEqual([]);
  });

  it("keeps dialogue-only testimony out of free-form investigation", () => {
    const result = performInvestigation(tutorialCase, newSession(), {
      commandId: "command_search_for_testimony",
      text: "追问茶盘经过",
      characterId: "character_luo_fang",
    });

    expect(result.outcome).toEqual({
      status: "not_found",
      discoveredEvidenceIds: [],
      unlockedSceneIds: [],
      unlockedCharacterIds: [],
    });
  });

  it("treats a repeated command id as idempotent", () => {
    const command = {
      commandId: "command_query_paint",
      text: "核实沈岚的不在场证明",
    };
    const first = performInvestigation(tutorialCase, newSession(), command);
    const second = performInvestigation(tutorialCase, first.session, command);

    expect({
      firstStatus: first.outcome.status,
      secondStatus: second.outcome.status,
      unchanged: second.session === first.session,
      revision: second.session.revision,
    }).toEqual({
      firstStatus: "discovered",
      secondStatus: "duplicate",
      unchanged: true,
      revision: 1,
    });
  });

  it("reveals hints progressively and tracks their penalty", () => {
    const first = requestHint(tutorialCase, newSession(), {
      commandId: "command_hint_1",
      targetFactId: "fact_motive_embezzlement",
    });
    const second = requestHint(tutorialCase, first.session, {
      commandId: "command_hint_2",
      targetFactId: "fact_motive_embezzlement",
    });

    expect([
      { status: first.outcome.status, level: first.outcome.level },
      { status: second.outcome.status, level: second.outcome.level },
    ]).toEqual([
      { status: "revealed", level: 1 },
      { status: "revealed", level: 2 },
    ]);
  });

  it("only lets the player present evidence they have discovered", () => {
    const unavailable = presentEvidence(tutorialCase, newSession(), {
      commandId: "command_present_early",
      characterId: "character_li_wenzhou",
      evidenceId: "evidence_transfer_ledger",
    });
    const discovery = performInvestigation(tutorialCase, unavailable.session, {
      commandId: "command_find_ledger",
      text: "翻找书桌抽屉",
      sceneId: "scene_study",
    });
    const presented = presentEvidence(tutorialCase, discovery.session, {
      commandId: "command_present_ledger",
      characterId: "character_li_wenzhou",
      evidenceId: "evidence_transfer_ledger",
    });

    expect([
      unavailable.outcome.status,
      discovery.outcome.status,
      presented.outcome.status,
    ]).toEqual(["evidence_not_discovered", "discovered", "presented"]);
  });

  it("records bounded character dialogue and discovers matching testimony", () => {
    const result = recordDialogueTurn(tutorialCase, newSession(), {
      commandId: "command_ask_tea",
      characterId: "character_luo_fang",
      playerText: "到底是谁把茶送进书房的？",
      response: {
        utterance: "李闻舟主动接过了茶盘，说他来送。",
        demeanor: "cooperative",
        disclosedClaimIds: ["claim_luo_tea"],
        memorySummary: "侦探追问了送茶经过，我说明是李闻舟接走茶盘。",
        stateDelta: { trust: 7, pressure: 2, alertness: -1 },
      },
      now: "2026-08-31T10:05:00+08:00",
    });
    const playerView = getPlayerCaseView(tutorialCase, result.session);

    expect({
      status: result.outcome.status,
      evidence: result.outcome.discoveredEvidenceIds,
      claims: playerView.claims.map((claim) => claim.id),
      dialogueCount: playerView.dialogue.length,
      hiddenStateLeaked: JSON.stringify(playerView).includes("alertness"),
      characterState: result.session.characterStates.character_luo_fang,
    }).toEqual({
      status: "responded",
      evidence: ["evidence_housekeeper_testimony"],
      claims: ["claim_luo_tea"],
      dialogueCount: 1,
      hiddenStateLeaked: false,
      characterState: {
        trust: 52,
        pressure: 12,
        alertness: 9,
        exchangeCount: 1,
        memorySummary: "侦探追问了送茶经过，我说明是李闻舟接走茶盘。",
      },
    });
  });

  it("rejects a character disclosing another person's claim", () => {
    expect(() =>
      recordDialogueTurn(tutorialCase, newSession(), {
        commandId: "command_invalid_claim",
        characterId: "character_luo_fang",
        playerText: "你知道李闻舟的不在场证明吗？",
        response: {
          utterance: "我可以替他说出他的完整证词。",
          demeanor: "guarded",
          disclosedClaimIds: ["claim_li_alibi"],
          memorySummary: "",
          stateDelta: { trust: 0, pressure: 0, alertness: 0 },
        },
      }),
    ).toThrow(/cannot disclose claim/);
  });

  it("accepts one correct structured report and then exposes the review", () => {
    const investigated = discoverRequiredEvidence(newSession());
    const submitted = submitCaseReport(tutorialCase, investigated, {
      commandId: "command_submit_report",
      culpritId: tutorialCase.solution.culpritId,
      motiveFactId: tutorialCase.solution.motiveFactId,
      methodFactId: tutorialCase.solution.methodFactId,
      evidenceIds: tutorialCase.solution.requiredEvidenceIds,
      timelineEventIds: tutorialCase.solution.requiredTimelineEventIds,
      reasoning: "财务动机、门禁记录和物证共同形成闭环。",
      now: "2026-08-31T10:30:00+08:00",
    });
    const replayed = submitCaseReport(tutorialCase, submitted.session, {
      commandId: "command_submit_report",
      culpritId: tutorialCase.solution.culpritId,
      motiveFactId: tutorialCase.solution.motiveFactId,
      methodFactId: tutorialCase.solution.methodFactId,
      evidenceIds: tutorialCase.solution.requiredEvidenceIds,
      timelineEventIds: tutorialCase.solution.requiredTimelineEventIds,
      reasoning: "重复提交",
    });
    const review = getCaseReview(tutorialCase, submitted.session);

    expect({
      status: submitted.outcome.status,
      verdict: submitted.outcome.report.verdict,
      score: submitted.outcome.report.score,
      gameStatus: submitted.session.status,
      replayStatus: replayed.outcome.status,
      culprit: review?.culprit?.id,
      lieCount: review?.lies.length,
    }).toEqual({
      status: "submitted",
      verdict: "solved",
      score: 100,
      gameStatus: "closed",
      replayStatus: "duplicate",
      culprit: "character_li_wenzhou",
      lieCount: 1,
    });
  });

  it("treats a correct early accusation with partial evidence as a solved case", () => {
    const afterTea = performInvestigation(tutorialCase, newSession(), {
      commandId: "command_early_tea",
      text: "化验茶水",
      sceneId: "scene_study",
    }).session;
    const afterBookend = performInvestigation(tutorialCase, afterTea, {
      commandId: "command_early_bookend",
      text: "检查黄铜书挡",
      sceneId: "scene_study",
    }).session;

    const submitted = submitCaseReport(tutorialCase, afterBookend, {
      commandId: "command_submit_early_report",
      culpritId: tutorialCase.solution.culpritId,
      motiveFactId: "",
      methodFactId: "",
      evidenceIds: ["evidence_teacup_residue", "evidence_brass_bookend"],
      timelineEventIds: [],
      reasoning: "茶中残留与带有纤维的书挡已经足以让我锁定李闻舟。",
    });

    expect(submitted.outcome.report).toMatchObject({
      verdict: "solved",
      score: 45,
      correct: {
        culprit: true,
        motive: false,
        method: false,
        evidence: false,
        timeline: false,
      },
    });
    expect(submitted.session.status).toBe("closed");
  });

  it("fully declassifies missed evidence and its acquisition route after closure", () => {
    const afterTea = performInvestigation(tutorialCase, newSession(), {
      commandId: "command_debrief_tea",
      text: "化验茶水",
      sceneId: "scene_study",
    }).session;
    const afterBookend = performInvestigation(tutorialCase, afterTea, {
      commandId: "command_debrief_bookend",
      text: "检查黄铜书挡",
      sceneId: "scene_study",
    }).session;
    const submitted = submitCaseReport(tutorialCase, afterBookend, {
      commandId: "command_submit_debrief",
      culpritId: tutorialCase.solution.culpritId,
      motiveFactId: "",
      methodFactId: "",
      evidenceIds: ["evidence_teacup_residue", "evidence_brass_bookend"],
      timelineEventIds: [],
      reasoning: "两条物证都指向李闻舟，但我决定提前提交结论。",
    });
    const review = getCaseReview(tutorialCase, submitted.session);
    const housekeeperTestimony = review?.evidence.find(
      (evidence) => evidence.id === "evidence_housekeeper_testimony",
    );
    const liWenzhou = review?.characters.find(
      (character) => character.id === "character_li_wenzhou",
    );
    const liAlibi = review?.claims.find((claim) => claim.id === "claim_li_alibi");

    expect({
      evidenceCount: review?.evidence.length,
      housekeeper: housekeeperTestimony,
      liSecrets: liWenzhou?.secrets,
      liLieRules: liWenzhou?.lieRules,
      liAlibi,
      factCount: review?.facts.length,
    }).toMatchObject({
      evidenceCount: tutorialCase.evidence.length,
      housekeeper: {
        discovered: false,
        includedInReport: false,
        requiredForSolution: true,
        supportsFacts: [
          expect.objectContaining({ id: "fact_housekeeper_sighting" }),
        ],
        acquisition: {
          method: "interview",
          character: expect.objectContaining({
            id: "character_luo_fang",
            name: "罗芳",
          }),
          primaryAction: "询问罗芳谁送了茶",
          prerequisiteEvidence: [],
        },
        followUps: [
          expect.objectContaining({
            characterId: "character_li_wenzhou",
            claimId: "claim_li_alibi",
          }),
        ],
      },
      liSecrets: expect.arrayContaining([
        expect.objectContaining({ id: "fact_motive_embezzlement" }),
      ]),
      liLieRules: expect.arrayContaining([
        expect.objectContaining({
          fact: expect.objectContaining({ id: "fact_method_sedative_bookend" }),
        }),
      ]),
      liAlibi: expect.objectContaining({
        kind: "lie",
        speakerName: "李闻舟",
      }),
      factCount: tutorialCase.facts.length,
    });
  });

  it("requires two discovered evidence items before an early accusation can close a case", () => {
    const afterTea = performInvestigation(tutorialCase, newSession(), {
      commandId: "command_early_one_evidence",
      text: "化验茶水",
      sceneId: "scene_study",
    }).session;

    expect(() =>
      submitCaseReport(tutorialCase, afterTea, {
        commandId: "command_reject_thin_early_report",
        culpritId: tutorialCase.solution.culpritId,
        motiveFactId: "",
        methodFactId: "",
        evidenceIds: ["evidence_teacup_residue"],
        timelineEventIds: [],
        reasoning: "我只有一条物证，尚不足以作为正式的提前结案依据。",
      }),
    ).toThrow(/at least two discovered evidence items/);
  });

  it("requires a named suspect before an early accusation can close a case", () => {
    const afterTea = performInvestigation(tutorialCase, newSession(), {
      commandId: "command_early_blank_culprit_tea",
      text: "化验茶水",
      sceneId: "scene_study",
    }).session;
    const afterBookend = performInvestigation(tutorialCase, afterTea, {
      commandId: "command_early_blank_culprit_bookend",
      text: "检查黄铜书挡",
      sceneId: "scene_study",
    }).session;

    expect(() =>
      submitCaseReport(tutorialCase, afterBookend, {
        commandId: "command_reject_blank_culprit",
        culpritId: "",
        motiveFactId: "",
        methodFactId: "",
        evidenceIds: ["evidence_teacup_residue", "evidence_brass_bookend"],
        timelineEventIds: [],
        reasoning: "两条物证都指向同一名嫌疑人，但我没有在报告中填写姓名。",
      }),
    ).toThrow(/requires a named suspect/);
  });

  it("keeps a wrong early accusation permanently closed", () => {
    const afterTea = performInvestigation(tutorialCase, newSession(), {
      commandId: "command_wrong_early_tea",
      text: "化验茶水",
      sceneId: "scene_study",
    }).session;
    const afterBookend = performInvestigation(tutorialCase, afterTea, {
      commandId: "command_wrong_early_bookend",
      text: "检查黄铜书挡",
      sceneId: "scene_study",
    }).session;
    const wrong = submitCaseReport(tutorialCase, afterBookend, {
      commandId: "command_submit_wrong_early_report",
      culpritId: "character_shen_lan",
      motiveFactId: "",
      methodFactId: "",
      evidenceIds: ["evidence_teacup_residue", "evidence_brass_bookend"],
      timelineEventIds: [],
      reasoning: "茶中残留与书挡痕迹让我错误地怀疑了沈岚。",
    });
    const correction = submitCaseReport(tutorialCase, wrong.session, {
      commandId: "command_submit_late_correction",
      culpritId: tutorialCase.solution.culpritId,
      motiveFactId: "",
      methodFactId: "",
      evidenceIds: ["evidence_teacup_residue", "evidence_brass_bookend"],
      timelineEventIds: [],
      reasoning: "我想在结案后更正为李闻舟。",
    });

    expect({
      verdict: wrong.outcome.report.verdict,
      status: wrong.session.status,
      correction: correction.outcome.status,
    }).toEqual({
      verdict: "unsolved",
      status: "closed",
      correction: "already_closed",
    });
  });

  it("does not award guessed facts or timeline ids before the evidence chain is found", () => {
    const afterWatch = performInvestigation(tutorialCase, newSession(), {
      commandId: "command_guessed_ids_watch",
      text: "检查腕表",
      sceneId: "scene_study",
    }).session;
    const afterPaintRecord = performInvestigation(tutorialCase, afterWatch, {
      commandId: "command_guessed_ids_paint",
      text: "核实沈岚的不在场证明",
    }).session;
    const submitted = submitCaseReport(tutorialCase, afterPaintRecord, {
      commandId: "command_submit_guessed_ids",
      culpritId: tutorialCase.solution.culpritId,
      motiveFactId: tutorialCase.solution.motiveFactId,
      methodFactId: tutorialCase.solution.methodFactId,
      evidenceIds: [
        "evidence_broken_watch",
        "evidence_paint_curing_record",
        "evidence_unknown",
      ],
      timelineEventIds: [
        ...tutorialCase.solution.requiredTimelineEventIds,
        "event_unknown",
      ],
      reasoning: "我只是在没有搜证的情况下猜测全部内部标识。",
    });

    expect(submitted.outcome.report).toMatchObject({
      score: 43,
      correct: {
        culprit: true,
        motive: false,
        method: false,
        evidence: false,
        timeline: false,
      },
      breakdown: { culprit: 40, motive: 0, method: 0, evidence: 3, timeline: 0 },
    });
  });

  it("redacts character identities from pre-submission timeline choices", () => {
    const view = getPlayerCaseView(
      tutorialCase,
      discoverRequiredEvidence(newSession()),
    );
    const timeline = JSON.stringify(view.reportOptions.timelineEvents);

    expect(view.reportOptions.hasCompleteEvidenceChain).toBe(true);
    expect(timeline).not.toContain("李闻舟");
    expect(timeline).toContain("某位嫌疑人");
  });
});

function newSession() {
  return startGame(tutorialCase, {
    sessionId: "game_test",
    now: startedAt,
  });
}

function discoverRequiredEvidence(initial: GameSession) {
  const actions = [
    ["tea", "化验茶水", "scene_study"],
    ["bookend", "检查黄铜书挡", "scene_study"],
    ["ledger", "翻找书桌抽屉", "scene_study"],
    ["paint", "核实沈岚的不在场证明", undefined],
    ["memo", "检查碎纸篓", "scene_study"],
    ["elevator", "查询货梯日志", "scene_security_room"],
    ["lock", "恢复门禁日志", "scene_security_room"],
  ] as const;

  const investigated = actions.reduce(
    (session, [suffix, text, sceneId]) =>
      performInvestigation(tutorialCase, session, {
        commandId: `command_${suffix}`,
        text,
        sceneId,
      }).session,
    initial,
  );
  const afterHousekeeper = recordDialogueTurn(tutorialCase, investigated, {
    commandId: "command_ask_housekeeper_for_chain",
    characterId: "character_luo_fang",
    playerText: "询问罗芳谁送了茶",
    response: {
      utterance: "李闻舟主动接过茶盘，说要替我送上二楼。",
      demeanor: "cooperative",
      disclosedClaimIds: ["claim_luo_tea"],
      memorySummary: "罗芳确认了茶盘被李闻舟接走的经过。",
      stateDelta: { trust: 4, pressure: 1, alertness: 0 },
    },
  });
  return recordDialogueTurn(tutorialCase, afterHousekeeper.session, {
    commandId: "command_ask_chen_for_chain",
    characterId: "character_chen_mo",
    playerText: "询问陈默案发时在哪里",
    response: {
      utterance: "我在诊所做医学直播，后台回放和观众互动记录都在。",
      demeanor: "guarded",
      disclosedClaimIds: ["claim_chen_alibi"],
      memorySummary: "陈默提供了案发时医学直播的回放链接。",
      stateDelta: { trust: 1, pressure: 2, alertness: 1 },
    },
  }).session;
}
