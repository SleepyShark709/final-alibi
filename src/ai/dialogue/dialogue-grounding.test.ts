import { describe, expect, it } from "vitest";

import type { StructuredModelProvider, StructuredModelRequest, StructuredModelResult } from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import {
  buildDeterministicDialogueShortcut, buildGroundedDialogueFallback,
  isProofOrTimeQuestion, isVerificationFollowUp,
  performInvestigation, presentEvidence, recordDialogueTurn, startGame,
} from "@/domain/game/game-runtime";

import { createDialogueGraph } from "./dialogue-graph";
import { buildCharacterContext, buildCharacterMessages, buildDialogueGuardMessages } from "./dialogue-prompts";
import type { CharacterResponse } from "./dialogue-schema";

const characterId = "character_li_wenzhou";
const cover = "案发当晚我一直在物业办公室加班。";
// 真实模型曾返回这些句子，随后语义守卫错误地给出 safe=true。
const inventedWork = "我在物业办公室加班，整理这个月的账目。顾先生出事的时候，我根本不在场。";
const inventedAbsence = "这个……我确实没法给出一个具体的时间点。当时办公室里只有我一个人，没人能确认我几点到、几点走。我只能说，我整晚都在那里。";

describe("dialogue grounding counterexamples", () => {
  it("rejects the live late-return addition even when the guard cites the overtime cover", async () => {
    const artifact = monitoredOfficeCase();
    const utterance = "那天晚上我在物业办公室加班，一直待到很晚才回去。";
    const coverSource = artifact.characters.find((character) => character.id === characterId)!.lieRules.find((rule) => rule.factId === "fact_opportunity_stolen_card")!.coverStatement;
    const provider = new ApprovingProvider(response(utterance, ["claim_li_alibi"]), [{ candidateText: utterance, sourceText: coverSource }]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "late_return", playerText: "案发当天你在干嘛？",
    });
    expect(result.guard?.violationCodes).toContain("unsupported_claim");
    expect(result.finalResponse?.utterance).not.toContain("很晚才回去");
  });

  it("keeps public identities without inventing a history of property-related contact", async () => {
    const artifact = monitoredOfficeCase();
    const character = artifact.characters.find((person) => person.id === characterId)!;
    const victim = artifact.characters.find((person) => person.id === artifact.victimId)!;
    character.occupation = "小区物业经理";
    character.publicProfile = "小区物业经理。";
    artifact.briefing = "死者为小区业主。";
    const friction = "我和顾明远只是工作上的小摩擦，不至于杀人。";
    character.lieRules[0].coverStatement = friction;
    const utterance = "我是小区物业经理，他是业主，平时因为物业上的事打过交道。";
    const provider = new ApprovingProvider(response(utterance, []), [
      { candidateText: "我是小区物业经理", sourceText: `${character.name}的职业是${character.occupation}。` },
      { candidateText: "他是业主", sourceText: artifact.briefing },
      { candidateText: "平时因为物业上的事打过交道", sourceText: friction },
    ]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "invented_contact", playerText: "你和死者是什么关系？",
    });
    expect(result.guard?.violationCodes).toContain("unsupported_claim");
    expect(result.finalResponse?.utterance).not.toContain("打过交道");
    expect(result.finalResponse?.utterance).toContain("物业经理");
    expect(result.finalResponse?.utterance).toContain(`${victim.name}是小区业主`);
  });

  it("checks time and negation at the guard even outside a verification shortcut", async () => {
    const artifact = officeCase();
    const sourceText = "老周在八点二十分到办公室时，没有见到我；九点整才看见我。";
    addWitness(artifact, "negated_sighting", sourceText);
    const utterance = "老周在八点二十分就看见了我。";
    const provider = new ApprovingProvider(response(utterance, ["claim_proof_negated_sighting"]), [{ candidateText: utterance, sourceText }]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "negated_sighting_guard", playerText: "请补充你知道的情况。",
    });
    expect(provider.schemas).toEqual(["character_response", "dialogue_guard"]);
    expect(result.guard?.violationCodes).toContain("unsupported_claim");
    expect(result.finalResponse?.utterance).not.toContain("八点二十分就看见了我");
  });

  it.each([
    ["李闻舟看见顾明远进入书房。", "李闻舟进入书房。"],
    ["老周在九点十五分见到我。", "老周在九点五分见到我。"],
    ["我没有进入书房。", "我从未进入书房。"],
  ])("rejects deletions that change the actor or numeric value of a cited proposition: %s", async (sourceText, utterance) => {
    const artifact = officeCase();
    addWitness(artifact, "deleted_content", sourceText);
    const provider = new ApprovingProvider(response(utterance, ["claim_proof_deleted_content"]), [{ candidateText: utterance, sourceText }]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "deleted_content_guard", playerText: "请补充你知道的情况。",
    });
    expect(provider.schemas).toEqual(["character_response", "dialogue_guard"]);
    expect(result.guard?.violationCodes).toContain("unsupported_claim");
    expect(result.finalResponse?.utterance).not.toBe(utterance);
  });

  it("allows bound names and numeric styles without changing the complete proposition", async () => {
    const artifact = officeCase();
    const sourceText = "李闻舟在九点十五分看见顾明远进入书房。";
    const utterance = "我在9点15分见到死者进入书房。";
    addWitness(artifact, "same_proposition", sourceText);
    const provider = new ApprovingProvider(response(utterance, ["claim_proof_same_proposition"]), [{ candidateText: utterance, sourceText }]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "same_proposition_guard", playerText: "请补充你知道的情况。",
    });
    expect(provider.schemas).toEqual(["character_response", "dialogue_guard"]);
    expect(result.guard?.safe).toBe(true);
    expect(result.finalResponse?.utterance).toBe(utterance);
  });

  it.each([
    ["案发当天你在干嘛？", "那天晚上我在物业办公室加班，处理一些文件，没去过死者家。"],
    ["你在物业工作多久了？", "我在融泽嘉园做物业经理已经五年多了。"],
    ["请补充你的情况。", "我在融泽嘉园做物业经理已经五年多了。"],
  ])("rejects ungrounded live details even when a permissive guard approves: %s", async (playerText, utterance) => {
    const artifact = monitoredOfficeCase();
    const provider = new ApprovingProvider(response(utterance, []));
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "live_unsupported_detail", playerText,
    });
    expect(result.finalResponse?.utterance).not.toMatch(/处理一些文件|五年多/);
    if (provider.schemas.length > 0) expect(result.guard?.violationCodes).toContain("unsupported_claim");
  });

  it("answers a specific work question without replaying a location and surveillance cover", () => {
    const artifact = monitoredOfficeCase();
    const initial = "案发时我在物业办公室加班，没有去过死者家。";
    const session = recordDialogueTurn(artifact, startGame(artifact), {
      commandId: "alibi", characterId, playerText: "案发当天你在干嘛？", response: response(initial),
    }).session;
    const question = "刚才说在办公室，你具体在做什么？";
    const shortcut = buildDeterministicDialogueShortcut(artifact, session, characterId, question);
    const fallback = buildGroundedDialogueFallback(artifact, session, characterId, question);
    for (const reply of [shortcut, fallback].filter((candidate) => candidate !== null)) {
      expect(reply.utterance).toMatch(/具体工作|工作内容|具体做了什么/);
      expect(reply.utterance).not.toMatch(/监控为证|一直在物业办公室加班|处理文件/);
    }
  });

  it.each([false, true])("checks the guard's quoted source and rejects unsupported additional clauses: %s", async (fabricatedSource) => {
    const artifact = monitoredOfficeCase();
    const utterance = "我在物业办公室加班，处理一些文件。";
    const sourceText = fabricatedSource ? "我当晚在办公室处理文件。"
      : artifact.claims.find((claim) => claim.id === "claim_li_alibi")!.statement;
    const provider = new ApprovingProvider(response(utterance, []), [{ candidateText: utterance, sourceText }]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "false_guard_source", playerText: "案发当天你在干嘛？",
    });
    expect(result.guard?.violationCodes).toContain("unsupported_claim");
    expect(result.finalResponse?.utterance).not.toContain("处理一些文件");
    expect(provider.schemas).toEqual(["character_response", "dialogue_guard"]);
  });

  it("accepts an authorized numeric duration with a different numeral style", async () => {
    const artifact = officeCase();
    const sourceText = "我在小区任物业经理六年整。";
    addWitness(artifact, "tenure", sourceText);
    const utterance = "我在小区任物业经理6年整。";
    const provider = new ApprovingProvider(response(utterance, ["claim_proof_tenure"]), [{ candidateText: utterance, sourceText }]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "known_numeric_tenure", playerText: "你在物业工作多久了？",
    });
    expect(result.finalResponse?.utterance).toBe(utterance);
  });

  it("preserves an authorized surveillance cover without adding duplicate punctuation", () => {
    const artifact = monitoredOfficeCase();
    const session = recordDialogueTurn(artifact, startGame(artifact), {
      commandId: "alibi", characterId, playerText: "案发时你在哪里？", response: response("案发时我在物业办公室加班，没有去过死者家。"),
    }).session;
    const reply = buildGroundedDialogueFallback(artifact, session, characterId, "有谁可以证明？");
    expect(reply.utterance).toContain("监控");
    expect(reply.utterance).toMatch(/具体谁.*无法确认/);
    expect(reply.utterance).not.toContain("办公室加班");
    expect(reply.utterance).not.toContain("。。");
  });

  it("accepts a basic relationship supported by public occupation and case background", async () => {
    const artifact = monitoredOfficeCase();
    const character = artifact.characters.find((candidate) => candidate.id === characterId)!;
    character.occupation = "小区物业经理";
    artifact.briefing = "死者是小区业主。发现时已停止呼吸，现场正在勘查。";
    const utterance = "我是物业经理，死者是小区业主。";
    const provider = new ApprovingProvider(response(utterance, []), [
      { candidateText: "我是物业经理", sourceText: `${character.name}的职业是小区物业经理。` },
      { candidateText: "死者是小区业主", sourceText: "死者是小区业主。" },
    ]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId,
      commandId: "public_relationship", playerText: "你和死者是什么关系？",
    });
    expect(result.finalResponse?.utterance).toBe(utterance);
    expect(result.guard?.safe).toBe(true);
  });

  it("rejects a source quote that removes a sentence's qualification", async () => {
    const artifact = monitoredOfficeCase();
    artifact.briefing = "尚未确认死者是小区业主。";
    const utterance = "死者是小区业主。";
    const provider = new ApprovingProvider(response(utterance, []), [
      { candidateText: utterance, sourceText: "死者是小区业主。" },
    ]);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId,
      commandId: "truncated_source", playerText: "你和死者是什么关系？",
    });
    expect(result.guard?.violationCodes).toContain("unsupported_claim");
    expect(result.finalResponse?.utterance).not.toBe(utterance);
  });

  it("does not turn a public occupation into an account of that night's specific work", () => {
    const artifact = monitoredOfficeCase();
    const character = artifact.characters.find((candidate) => candidate.id === characterId)!;
    character.occupation = "小区物业经理";
    character.publicProfile = "小区物业经理。";
    const session = recordDialogueTurn(artifact, startGame(artifact), {
      commandId: "discuss_relationship", characterId, playerText: "你和死者是什么关系？",
      response: response("我是物业经理，死者是小区业主。"),
    }).session;
    const reply = buildGroundedDialogueFallback(artifact, session, characterId, "刚才说在办公室，你具体在做什么？");
    expect(reply.utterance).toContain("具体工作内容");
    expect(reply.utterance).toContain("无法确认");
    expect(reply.utterance).not.toContain("物业经理");
  });

  it.each(["你在物业上班多久了？", "他和你什么关系？", "具体说说你的工作。", "查一下这家公司。", "公司的财务记录由谁保管？", "你平时工作时要查哪些记录？", "工作上你能查到哪些记录？", "日常工作要核实哪些记录？"])("does not classify a background topic as an alibi verification: %s", (question) => {
    expect(isProofOrTimeQuestion(question)).toBe(false);
    expect(isVerificationFollowUp(question)).toBe(false);
    const artifact = officeCase();
    const reply = buildDeterministicDialogueShortcut(artifact, startGame(artifact), characterId, question) ??
      buildGroundedDialogueFallback(artifact, startGame(artifact), characterId, question);
    expect(reply.utterance).not.toMatch(/几点|人证|作证|这段行踪/);
  });

  it("answers a request for records after a witness follow-up without inventing corroboration", () => {
    let session = startGame(tutorialCase);
    for (const [index, question] of ["案发当天你在干嘛？", "有谁可以证明？"].entries()) {
      const reply = buildDeterministicDialogueShortcut(tutorialCase, session, characterId, question) ??
        buildGroundedDialogueFallback(tutorialCase, session, characterId, question);
      session = recordDialogueTurn(tutorialCase, session, {
        commandId: `record_question_context_${index}`, characterId, playerText: question, response: reply,
      }).session;
    }
    const reply = buildGroundedDialogueFallback(tutorialCase, session, characterId, "那能查到什么记录？");
    expect(reply.utterance).toContain("记录");
    expect(reply.utterance).toContain("无法确认");
    expect(reply.utterance).not.toMatch(/人证|客房|打电话/);
    expect(reply.disclosedClaimIds).toEqual([]);
    expect(isProofOrTimeQuestion("你的日常工作记录能证明案发当天的行踪吗？")).toBe(true);
  });

  it("answers job tenure from an authorized fact and keeps that topic when asked again", () => {
    const artifact = officeCase();
    const statement = "我从2021年开始在物业上班。";
    artifact.facts.push({ id: "fact_job_tenure", type: "context", statement });
    artifact.characters.find((character) => character.id === characterId)!.knowledge.factIds.push("fact_job_tenure");
    let session = startGame(artifact, { sessionId: "job_tenure" });
    const questions = ["你在物业上班多久了？", "再问一次", "再问一次"];
    for (const [index, playerText] of questions.entries()) {
      const reply = buildGroundedDialogueFallback(artifact, session, characterId, playerText);
      expect(reply.utterance).toContain(statement);
      expect(reply.utterance).not.toMatch(/几点|人证|只能说明自己知道/);
      expect(reply.utterance).not.toBe(session.dialogue.at(-1)?.utterance);
      session = recordDialogueTurn(artifact, session, { commandId: `tenure_${index}`, characterId, playerText, response: reply }).session;
    }
  });

  it("uses a pronoun only to resolve the person when the player changes to a relationship question", () => {
    const artifact = officeCase();
    const proof = "老周在八点二十分看见我在物业办公室。";
    const relationship = "我和老周是同事关系。";
    addWitness(artifact, "zhou", proof);
    addWitness(artifact, "relationship", relationship);
    const session = recordDialogueTurn(artifact, startGame(artifact, { sessionId: "relationship" }), {
      commandId: "proof", characterId, playerText: "谁看见你了？", response: response(proof, ["claim_proof_zhou"]),
    }).session;
    const reply = buildGroundedDialogueFallback(artifact, session, characterId, "他和你什么关系？");
    expect(reply.utterance).toContain(relationship);
    expect(reply.utterance).not.toMatch(/作证|人证|八点二十分/);
    expect(reply.disclosedClaimIds).toEqual(["claim_proof_relationship"]);
  });

  it("retains a time attached after a comma in the original witness fact", () => {
    const artifact = officeCase();
    const statement = "老周看见我在物业办公室，当时八点二十分。";
    addWitness(artifact, "zhou", statement);
    const session = startGame(artifact, { sessionId: "comma_time" });
    const reply = buildGroundedDialogueFallback(artifact, session, characterId, "老周几点见到你？");
    expect(reply.utterance).toContain(statement);
    expect(reply.utterance).not.toMatch(/整晚|一直|无法确认/);
    expect(buildGroundedDialogueFallback(artifact, session, characterId, "小陈几点见到你？").utterance).not.toContain("八点二十分");
  });

  it.each(["你可以核对已经拿到的证据。", "我目前无法确认。"])("allows a pure suggestion or uncertainty without requiring a prior factual source: %s", async (utterance) => {
    const artifact = officeCase();
    const draft = response(utterance, []);
    const provider = new ApprovingProvider(draft);
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "suggest_verification", playerText: "还有什么要补充的？",
    });
    expect(result.finalResponse).toEqual(draft);
    expect(provider.schemas).toEqual(["character_response", "dialogue_guard"]);
  });

  it("still rejects an unsupported claim to have checked accounts", async () => {
    const artifact = officeCase();
    const provider = new ApprovingProvider(response("我那晚核对账目。", []));
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact), characterId, commandId: "claimed_verification", playerText: "还有什么要补充的？",
    });
    expect(result.guard?.violationCodes).toContain("unsupported_claim");
    expect(result.finalResponse?.utterance).not.toContain("核对账目");
    expect(provider.schemas).toEqual(["character_response"]);
  });

  it("keeps secrets as confidentiality constraints and permits them after evidence unlocks them", async () => {
    const artifact = officeCase();
    const secret = artifact.facts.find((fact) => fact.id === "fact_motive_embezzlement")!;
    const session = startGame(artifact, { sessionId: "secret_unlock" });
    const promptInput = { caseArtifact: artifact, session, characterId, playerText: "请补充你知道的情况。" };
    const guardContext = JSON.parse(buildDialogueGuardMessages({ ...promptInput, candidate: response(secret.statement, []) })[1].content);
    expect(JSON.stringify(guardContext.permittedContext)).not.toContain(secret.statement);
    expect(guardContext.forbiddenFactStatements).toContain(secret.statement);
    expect(buildCharacterMessages(promptInput)[0].content).toContain(secret.statement);

    const afterLedger = performInvestigation(artifact, session, { commandId: "ledger", sceneId: "scene_study", text: "翻找书桌抽屉" }).session;
    const unlocked = performInvestigation(artifact, afterLedger, { commandId: "memo", sceneId: "scene_study", text: "检查碎纸篓" }).session;
    expect(buildCharacterContext({ ...promptInput, session: unlocked }).character.knownFacts).toContainEqual({ id: secret.id, statement: secret.statement });
    const provider = new ApprovingProvider(response(secret.statement, []));
    const result = await createDialogueGraph(provider).invoke({ ...promptInput, session: unlocked, commandId: "secret_after_unlock" });
    expect(result.finalResponse?.utterance).toBe(secret.statement);
    expect(provider.schemas).toEqual(["character_response", "dialogue_guard"]);
  });

  it.each([inventedWork, inventedAbsence])("blocks an actual live fabrication even when the semantic guard would approve: %s", async (utterance) => {
    const artifact = officeCase();
    const provider = new ApprovingProvider(response(utterance));
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session: startGame(artifact, { sessionId: "fabrication" }),
      characterId, commandId: "initial", playerText: "案发那天晚上你在做什么？",
    });

    expect(result.guard?.violationCodes).toContain("unsupported_claim");
    expect(result.finalResponse?.utterance).toBe(cover);
    expect(provider.schemas).toEqual(["character_response"]);
  });

  it("does not promote an old model fabrication into ledger authority across proof and time follow-ups", async () => {
    const artifact = officeCase();
    let session = recordDialogueTurn(artifact, startGame(artifact, { sessionId: "tainted_history" }), {
      commandId: "old_reply", characterId, playerText: "那天你在做什么？",
      response: response(inventedAbsence),
    }).session;
    const provider = new ApprovingProvider(response(inventedAbsence));
    const graph = createDialogueGraph(provider);
    const questions = ["谁能证明你整个晚上都在物业办公室？", "那他是几点见到你的？", "你刚才提到的人，能证明你整晚没离开吗？"];
    for (const [index, playerText] of questions.entries()) {
      const commandId = `followup_${index}`;
      const result = await graph.invoke({ caseArtifact: artifact, session, characterId, commandId, playerText });
      expect(result.finalResponse?.utterance).not.toMatch(/只有我|没人|无人|一个人|整理/);
      expect(result.finalResponse?.utterance).toMatch(/无法确认|提供不了|没有能确认/);
      expect(result.finalResponse?.disclosedClaimIds).toEqual([]);
      session = recordDialogueTurn(artifact, session, { commandId, characterId, playerText, response: result.finalResponse! }).session;
    }
    expect(provider.schemas).toEqual([]);
    expect(session.dialogue).toHaveLength(4);
  });

  it("answers proof from the complete record without letting the model repeat an alibi", async () => {
    const artifact = officeCase();
    addWitness(artifact, "zhou", "老周在八点二十分看见我在物业办公室。");
    const session = recordDialogueTurn(artifact, startGame(artifact, { sessionId: "paraphrased_alibi" }), {
      commandId: "initial", characterId, playerText: "那天晚上在哪里？",
      response: response("那个晚上我都待在物业办公室加班。"),
    }).session;
    const provider = new ApprovingProvider(response(cover));
    const result = await createDialogueGraph(provider, { maxDraftAttempts: 1 }).invoke({
      caseArtifact: artifact, session, characterId, commandId: "proof", playerText: "谁能证明你当时在物业办公室？",
    });
    expect(result.finalResponse?.utterance).toContain("老周");
    expect(result.finalResponse?.utterance).not.toBe(cover);
    expect(provider.schemas).toEqual([]);
  });

  it.each([false, true])("handles contradictory evidence after a cover shortcut, including legacy missing claim IDs: %s", (legacy) => {
    const artifact = officeCase();
    let session = startGame(artifact, { sessionId: "shortcut_contradiction" });
    const playerText = "案发时你是不是用了顾明远遗失的备用门卡进入书房？";
    const shortcut = buildDeterministicDialogueShortcut(artifact, session, characterId, playerText)!;
    expect(shortcut.disclosedClaimIds).toEqual(["claim_li_alibi"]);
    session = recordDialogueTurn(artifact, session, {
      commandId: "initial", characterId, playerText,
      response: legacy ? { ...shortcut, disclosedClaimIds: [] } : shortcut,
    }).session;
    session = performInvestigation(artifact, session, { commandId: "ledger", sceneId: "scene_study", text: "翻找书桌抽屉" }).session;
    session = performInvestigation(artifact, session, { commandId: "memo", sceneId: "scene_study", text: "检查碎纸篓" }).session;
    session = performInvestigation(artifact, session, { commandId: "log", sceneId: "scene_security_room", text: "恢复门禁日志" }).session;
    session = performInvestigation(artifact, session, { commandId: "reflection", sceneId: "scene_security_room", text: "逐帧查看监控" }).session;
    session = presentEvidence(artifact, session, { commandId: "present", characterId, evidenceId: "evidence_camera_reflection" }).session;
    const reply = buildGroundedDialogueFallback(artifact, session, characterId, "监控玻璃中的倒影和你刚才说的矛盾，你怎么解释？");
    expect(reply.utterance).toContain("监控玻璃中的倒影");
    expect(reply.utterance).toContain("冲突");
    expect(reply.disclosedClaimIds).toEqual([]);
  });

  it.each(["小陈", "小刘"])("prioritizes the explicitly named witness over the previous witness: %s", (name) => {
    const artifact = officeCase();
    const zhou = "老周在八点二十分看见我在物业办公室。";
    addWitness(artifact, "zhou", zhou);
    addWitness(artifact, "chen", "小陈在九点整看见我在物业办公室。");
    const session = recordDialogueTurn(artifact, startGame(artifact, { sessionId: "changed_witness" }), {
      commandId: "zhou", characterId, playerText: "老周什么时候见过你？", response: response(zhou, ["claim_proof_zhou"]),
    }).session;
    const reply = buildGroundedDialogueFallback(artifact, session, characterId, `那${name}是几点见到你的？`);
    expect(reply.utterance).not.toMatch(/老周|八点二十分/);
    if (name === "小陈") {
      expect(reply.utterance).toContain("小陈在九点整");
      expect(reply.disclosedClaimIds).toEqual(["claim_proof_chen"]);
    } else {
      expect(reply.utterance).toContain("没有能确认");
      expect(reply.disclosedClaimIds).toEqual([]);
    }
  });
});

function officeCase() {
  const artifact = structuredClone(tutorialCase);
  artifact.claims.find((claim) => claim.id === "claim_li_alibi")!.statement = cover;
  artifact.characters.find((character) => character.id === characterId)!.lieRules.find((rule) => rule.factId === "fact_opportunity_stolen_card")!.coverStatement = cover;
  return artifact;
}

function monitoredOfficeCase() {
  const artifact = officeCase();
  artifact.claims.find((claim) => claim.id === "claim_li_alibi")!.statement = "案发时我在物业办公室加班，没有去过死者家。";
  artifact.characters.find((character) => character.id === characterId)!.lieRules.find((rule) => rule.factId === "fact_opportunity_stolen_card")!.coverStatement = "我那天晚上一直在物业办公室加班，有监控为证。";
  return artifact;
}

function addWitness(artifact: ReturnType<typeof officeCase>, suffix: string, statement: string) {
  const factId = `fact_proof_${suffix}`;
  const claimId = `claim_proof_${suffix}`;
  artifact.facts.push({ id: factId, type: "alibi", statement });
  artifact.claims.push({ id: claimId, speakerId: characterId, kind: "truth", statement, factIds: [factId] });
  const character = artifact.characters.find((candidate) => candidate.id === characterId)!;
  character.knowledge.factIds.push(factId);
  character.knowledge.claimIds.push(claimId);
}

function response(utterance: string, disclosedClaimIds = ["claim_li_alibi"]): CharacterResponse {
  return { utterance, disclosedClaimIds, demeanor: "guarded", memorySummary: "", stateDelta: { trust: 0, pressure: 0, alertness: 0 } };
}

class ApprovingProvider implements StructuredModelProvider {
  readonly schemas: string[] = [];
  constructor(private readonly draft: CharacterResponse, private readonly groundingChecks?: Array<{ candidateText: string; sourceText: string }>) {}

  async invokeStructured<T extends Record<string, unknown>>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>> {
    this.schemas.push(request.schemaName);
    const value = request.schemaName === "dialogue_guard" ? { safe: true, violationCodes: [], feedback: "", groundingChecks: this.groundingChecks } : this.draft;
    return { value: request.schema.parse(value), model: "approving-mock", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, rawResponse: {} };
  }
}
