import { describe, expect, it } from "vitest";

import {
  StructuredOutputParseError,
  type StructuredModelProvider,
  type StructuredModelRequest,
  type StructuredModelResult,
} from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import {
  caseArtifactRepairPatchSchema,
  caseArtifactSchema,
  parseCaseArtifact,
  type CaseArtifact,
} from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";
import { findInitiallyDiscoverableSceneEvidenceIds, findReachableEvidenceIds } from "@/domain/case/evidence-reachability";
import { performInvestigation, startGame } from "@/domain/game/game-runtime";

import {
  blindSolveSupportsConclusion,
  compileMinimumSolutionChain,
  createCaseGenerationGraph,
} from "./case-generation-graph";
import {
  buildBlindSolveMessages,
  buildBlindSolveInput,
  buildEvidenceReviewMessages,
  buildCaseDraftMessages,
  buildCaseRepairMessages,
  buildOpeningReviewMessages,
} from "./generation-prompts";
import { validateInitialScenePacing } from "./generation-plan";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";
import { ScriptedBlindProtocol } from "./testing/scripted-blind-protocol";
import { makeSupportedEvidenceReview, ScriptedEvidenceReview } from "./testing/scripted-evidence-review";
import { buildEvidenceReviewBatches } from "./evidence-review-batches";
import { buildEvidenceReviewPlan } from "./evidence-review";

describe("case generation graph", () => {
  it("publishes a semantically valid case only after an independent blind solve", async () => {
    const artifact = generatedTutorial("case_generated_one", "seed-one");
    const provider = new ScriptedProvider([
      artifact,
      blindResult(artifact),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("seed-one"));

    expect({
      finalId: result.finalArtifact?.id,
      valid: result.finalArtifact
        ? validatePublishableCaseArtifact(result.finalArtifact).valid
        : false,
      calls: provider.stageRequests,
      rejection: result.rejectionReason,
    }).toEqual({
      finalId: "case_generated_one",
      valid: true,
      calls: ["case_artifact", "case_opening_review", "case_evidence_review", "blind_case_solution"],
      rejection: null,
    });
  });

  it("reports durable UI stages while drafting, checking, blind-solving, and freezing a case", async () => {
    const artifact = generatedTutorial("case_generated_progress", "seed-progress");
    const provider = new ScriptedProvider([
      artifact,
      blindResult(artifact),
    ]);
    const progress: Array<{ stage: string; progress: number }> = [];
    const graph = createCaseGenerationGraph(provider, {
      onProgress: (entry) => {
        progress.push(entry);
      },
    });

    await graph.invoke(initialState("seed-progress"));

    expect(progress).toEqual([
      { stage: "drafting", progress: 10 },
      { stage: "validating", progress: 25 },
      { stage: "blind_solving", progress: 92 },
      { stage: "finalizing", progress: 96 },
    ]);
  });

  it("repairs deterministic validation failures before blind solving", async () => {
    const valid = generatedTutorial("case_generated_two", "seed-two");
    const invalid = structuredClone(valid);
    invalid.scenes = invalid.scenes.slice(0, 2);
    const provider = new ScriptedProvider([
      invalid,
      { scenes: [valid.scenes[2]] },
      blindResult(valid),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("seed-two"));

    expect({
      attempts: result.attempt,
      calls: provider.stageRequests,
      finalId: result.finalArtifact?.id,
    }).toEqual({
      attempts: 2,
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "case_opening_review",
        "case_evidence_review",
        "blind_case_solution",
      ],
      finalId: "case_generated_two",
    });
  });

  it("repairs a document chain that bypasses every required interview before review", async () => {
    const seed = "supporting-seed-2";
    const invalid = structuredClone(generatedTutorial("case_decorative_interviews", seed));
    const originalTeaPrerequisites = [...invalid.evidence.find((evidence) => evidence.id === "evidence_teacup_residue")!.discovery.prerequisiteEvidenceIds];
    // v5的茶检本身已依赖管家；此反例明确移除该取得依赖，再加独立存档旁路。
    invalid.evidence.find((evidence) => evidence.id === "evidence_teacup_residue")!.discovery.prerequisiteEvidenceIds = ["evidence_broken_watch"];
    const interview = invalid.evidence.find((evidence) => evidence.id === "evidence_livestream_record")!;
    const archive = {
      ...structuredClone(interview),
      id: "evidence_archive_copy",
      name: "独立调阅的修复室存档",
      description: "平台直接调阅的原始录像连续覆盖案发时间，沈岚始终在修复工作台前。",
      kind: "document" as const,
      discovery: { method: "query" as const, actionAliases: ["调阅修复室存档"], prerequisiteEvidenceIds: ["evidence_broken_watch"] },
    };
    invalid.evidence.push(archive);
    const repaired = structuredClone(invalid);
    repaired.evidence.find((evidence) => evidence.id === "evidence_teacup_residue")!.discovery.prerequisiteEvidenceIds = originalTeaPrerequisites;
    const repairedArchive = repaired.evidence.find((evidence) => evidence.id === archive.id)!;
    repairedArchive.discovery.prerequisiteEvidenceIds = [interview.id];
    repairedArchive.description = "根据沈岚提供的录像链接调阅原始存档，连续画面覆盖案发时间，她始终在修复工作台前。";
    const provider = new ScriptedProvider([
      invalid,
      { evidence: [{ id: archive.id, description: repairedArchive.description, discovery: { prerequisiteEvidenceIds: [interview.id] } }, { id: "evidence_teacup_residue", discovery: { prerequisiteEvidenceIds: originalTeaPrerequisites } }] },
      blindResult(repaired),
    ]);

    const result = await createCaseGenerationGraph(provider).invoke(initialState(seed));

    expect(result.finalArtifact).toEqual(repaired);
    expect(provider.stageRequests).toEqual(["case_artifact", "case_artifact_repair_patch", "case_opening_review", "case_evidence_review", "blind_case_solution"]);
    const repair = JSON.parse(provider.requestDetails[1]!.messages[1]!.content);
    expect(repair.validationIssues).toContainEqual(expect.objectContaining({ code: "unnecessary_interview_evidence" }));
    expect(provider.requestDetails[1]).toMatchObject({ reasoning: true, reasoningEffort: "low", maxTokens: 9_200 });
  });

  it("repairs a seeded supporting-cast mismatch before publishing", async () => {
    const valid = generatedTutorial(
      "case_generated_seeded_cast",
      "supporting-seed-1",
    );
    const addedCharacter = valid.characters.find(
      (character) => character.id === "character_wu_yue",
    );
    if (!addedCharacter) throw new Error("Generated fixture needs a third witness");
    const invalid = structuredClone(valid);
    invalid.characters = invalid.characters.filter(
      (character) => character.id !== addedCharacter.id,
    );
    const provider = new ScriptedProvider([
      invalid,
      { characters: [addedCharacter] },
      blindResult(valid),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("supporting-seed-1"));

    expect({
      attempts: result.attempt,
      calls: provider.stageRequests,
      supportingCharacterCount: result.finalArtifact?.characters.filter(
        (character) =>
          character.roleTier === "witness" || character.roleTier === "referenced",
      ).length,
    }).toEqual({
      attempts: 2,
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "case_opening_review",
        "case_evidence_review",
        "blind_case_solution",
      ],
      supportingCharacterCount: 3,
    });
  });

  it("removes an extra supporting character with a compact repair", async () => {
    const valid = generatedTutorial(
      "case_generated_seeded_cast_trim",
      "supporting-seed-3",
    );
    const invalid = structuredClone(valid);
    const witnessTemplate = invalid.characters.find(
      (character) => character.roleTier === "witness",
    );
    if (!witnessTemplate) {
      throw new Error("Generated fixture needs a witness template");
    }
    const extraCharacter = {
      ...structuredClone(witnessTemplate),
      id: "character_extra_referenced",
      name: "外围关联人",
      roleTier: "referenced" as const,
      publicProfile: "与案件有外围关联，未参与核心事件。",
      privateProfile: "没有掌握可用的案件线索。",
      knowledge: { factIds: [], evidenceIds: [], claimIds: [] },
      secretFactIds: [],
      lieRules: [],
    };
    invalid.characters.push(extraCharacter);
    const provider = new ScriptedProvider([
      invalid,
      { removeCharacterIds: [extraCharacter.id] },
      blindResult(valid),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("supporting-seed-3"));

    expect({
      attempts: result.attempt,
      calls: provider.stageRequests,
      supportingCharacterCount: result.finalArtifact?.characters.filter(
        (character) =>
          character.roleTier === "witness" || character.roleTier === "referenced",
      ).length,
    }).toEqual({
      attempts: 2,
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "case_opening_review",
        "case_evidence_review",
        "blind_case_solution",
      ],
      supportingCharacterCount: 1,
    });
  });

  it("repairs an initial phone dispute and profile leak without anonymously rewriting evidence", async () => {
    const seed = "supporting-seed-0";
    const valid = generatedTutorial("case_generated_initial_text", seed);
    const invalid = structuredClone(valid);
    const initial = invalid.evidence.find((evidence) => evidence.id === "evidence_broken_watch")!;
    initial.name = "死者手机中的争执短信";
    initial.description = "手机短信显示陈默因一笔投资款与顾明远发生经济纠纷。";
    invalid.characters.find((character) => character.id === "character_chen_mo")!.publicProfile = "顾明远的私人医生，与死者有经济纠纷。";
    const compiled = compileMinimumSolutionChain(invalid);
    expect(compiled.evidence.find((evidence) => evidence.id === initial.id)).toEqual(initial);
    expect(validateInitialScenePacing(compiled).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "initial_profile_hidden_conflict",
      "initial_scene_suspect_name_leak",
    ]));
    const provider = new ScriptedProvider([
      invalid,
      {
        evidence: [valid.evidence.find((evidence) => evidence.id === initial.id)!],
        characters: [valid.characters.find((character) => character.id === "character_chen_mo")!],
      },
      blindResult(valid),
    ]);
    const result = await createCaseGenerationGraph(provider).invoke(initialState(seed));
    expect(result.finalArtifact?.evidence.find((evidence) => evidence.id === initial.id)).toEqual(valid.evidence.find((evidence) => evidence.id === initial.id));
    expect(result.attempt).toBe(2);
    expect(provider.stageRequests).toEqual(["case_artifact", "case_artifact_repair_patch", "case_opening_review", "case_evidence_review", "blind_case_solution"]);
    const repair = JSON.parse(provider.requestDetails[1]!.messages[1]!.content);
    expect(repair.validationIssues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining(["initial_profile_hidden_conflict", "initial_scene_suspect_name_leak"]));
    expect(JSON.stringify(repair.repairSnapshot.playerFacingText)).toContain("经济纠纷");
  });

  it("repairs an invalid first-draft lie strategy with a compact patch", async () => {
    const valid = generatedTutorial("case_generated_lie_rule", "seed-lie-rule");
    const malformed = structuredClone(valid) as unknown as {
      characters: Array<{
        id: string;
        lieRules: Array<{
          factId: string;
          strategy: string;
          coverStatement: string;
        }>;
      }>;
    };
    const characterIndex = malformed.characters.findIndex(
      (character) => character.lieRules.length > 0,
    );
    if (characterIndex < 0) {
      throw new Error("Tutorial case requires a character with a lie rule");
    }
    const malformedCharacter = malformed.characters[characterIndex]!;
    malformedCharacter.lieRules[0]!.strategy = "fabricate_alibi";
    const repairedCharacter = valid.characters[characterIndex]!;
    const provider = new ScriptedProvider([
      structuredOutputValidationError(malformed),
      {
        characters: [
          {
            id: repairedCharacter.id,
            lieRules: repairedCharacter.lieRules,
          },
        ],
      },
      blindResult(valid),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("seed-lie-rule"));

    expect({
      attempts: result.attempt,
      finalId: result.finalArtifact?.id,
      calls: provider.stageRequests,
    }).toEqual({
      attempts: 2,
      finalId: "case_generated_lie_rule",
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "case_opening_review",
        "case_evidence_review",
        "blind_case_solution",
      ],
    });
    expect(result.modelCalls[0]?.response).toMatchObject({
      structuredOutputValidation: {
        schemaName: "case_artifact",
        issues: [
          expect.objectContaining({
            path: ["characters", characterIndex, "lieRules", 0, "strategy"],
            received: '"fabricate_alibi"',
          }),
        ],
      },
    });
  });

  it("preflights reference closure and the decisive evidence chain before drafting", () => {
    const messages = buildCaseDraftMessages({
      seed: "supporting-seed-1",
      theme: "现代宅邸中的封闭空间案件",
      difficulty: "standard",
    });

    expect(messages[0]?.content).toContain("输出前必须先完成以下结构预检");
    expect(messages[0]?.content).toContain("所有引用都必须来自已列出的实体 ID");
    expect(messages[0]?.content).toContain("用必要证据独立演算一次");
    expect(messages[0]?.content).toContain(
      "现场 physical/forensic 证据的 excludesCharacterIds 必须为空",
    );
    expect(messages[0]?.content).toContain("本局恰好 3 名核心嫌疑人、3 名证人");
    expect(messages[0]?.content).toContain("首发场景中的证据不得指向或排除任何嫌疑人");
  });

  it("keeps direct-evidence topology repairs compact and explicit", () => {
    const messages = buildCaseRepairMessages({
      request: {
        seed: "seed-direct-repair",
        theme: "现代宅邸中的封闭空间案件",
        difficulty: "standard",
      },
      draft: tutorialCase,
      issues: [
        {
          code: "premature_direct_evidence_lock",
          path: "evidence[2].excludesCharacterIds",
          message:
            'direct scene evidence "evidence_brass_bookend" independently excludes every other suspect; move suspect exclusions to non-direct evidence',
        },
      ],
    });

    expect(messages[0]?.content).toContain(
      "不得通过现场 physical/forensic 证据排除嫌疑人",
    );
    const payload = JSON.parse(messages[1]?.content ?? "{}");
    expect(payload.repairSnapshot).toHaveProperty("playerFacingText");
    expect(
      payload.repairSnapshot.playerFacingText.evidence.find(
        (evidence: { id: string }) => evidence.id === "evidence_brass_bookend",
      ).description,
    ).toContain("李闻舟");
  });

  it("focuses an evidence repair on related proof while preserving its acquisition route and complete timeline", () => {
    const draft = structuredClone(generatedTutorial("case_focused_proof", "supporting-seed-0"));
    const testimony = draft.evidence.find((item) => item.id === "evidence_housekeeper_testimony")!;
    testimony.excludesCharacterIds = ["character_shen_lan"];
    testimony.discovery.prerequisiteEvidenceIds = ["evidence_broken_watch"];
    draft.facts.push({ id: "fact_unused_decoration", type: "context", statement: "一幅装饰画与案件无关。" });
    draft.evidence.push({
      ...draft.evidence.find((item) => item.id === "evidence_broken_watch")!,
      id: "evidence_unused_decoration",
      name: "装饰画",
      description: "这段无关装饰说明不应进入局部证明修复。",
      supportsFactIds: ["fact_unused_decoration"],
    });
    const messages = buildCaseRepairMessages({
      request: { seed: draft.seed, theme: "现代宅邸", difficulty: "standard" },
      draft,
      issues: [{
        code: "evidence_narrative_mismatch",
        path: `evidence[${draft.evidence.indexOf(testimony)}]`,
        message: `${testimony.id}: unsupported exclusions character_shen_lan; 送茶见闻不能排除沈岚。`,
      }],
    });
    const { repairSnapshot } = JSON.parse(messages[1]!.content);
    expect(repairSnapshot.structuralLedger.timeline).toEqual(draft.timeline);
    expect(repairSnapshot.playerFacingText.setting).toEqual({ era: draft.setting.era, place: draft.setting.place });
    expect(repairSnapshot.structuralLedger.setting).toEqual(draft.setting);
    expect(repairSnapshot.structuralLedger.evidence).toContainEqual(
      expect.objectContaining({ id: testimony.id, discovery: testimony.discovery }),
    );
    expect(repairSnapshot.playerFacingText.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: testimony.id, description: testimony.description }),
      expect.objectContaining({ id: "evidence_broken_watch" }),
    ]));
    expect(repairSnapshot.playerFacingText.characters).toContainEqual(
      expect.objectContaining({ id: "character_shen_lan" }),
    );
    expect(repairSnapshot.knownIds.evidence).toContain("evidence_unused_decoration");
    expect(repairSnapshot.structuralLedger.evidence).not.toContainEqual(
      expect.objectContaining({ id: "evidence_unused_decoration" }),
    );
    expect(JSON.stringify(repairSnapshot.playerFacingText)).not.toContain("无关装饰说明");
  });

  it("repairs a localized discovery mismatch with a compact patch instead of another full case", async () => {
    const valid = generatedTutorial("case_generated_patch", "seed-patch");
    const invalid = structuredClone(valid);
    const mismatchedEvidence = invalid.evidence.find(
      (evidence) => Boolean(evidence.discovery.objectId),
    );
    const validEvidence = valid.evidence.find(
      (evidence) => evidence.id === mismatchedEvidence?.id,
    );
    const wrongScene = invalid.scenes.find(
      (scene) => scene.id !== mismatchedEvidence?.discovery.sceneId,
    );
    if (!mismatchedEvidence || !validEvidence || !wrongScene) {
      throw new Error("Generated fixture needs object evidence in multiple scenes");
    }
    mismatchedEvidence.discovery.sceneId = wrongScene.id;
    const provider = new ScriptedProvider([
      invalid,
      {
        evidence: [
          { id: validEvidence.id, discovery: validEvidence.discovery },
        ],
      },
      blindResult(valid),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("seed-patch"));

    expect({
      attempts: result.attempt,
      finalId: result.finalArtifact?.id,
      valid: result.finalArtifact
        ? validatePublishableCaseArtifact(result.finalArtifact).valid
        : false,
      calls: provider.stageRequests,
    }).toEqual({
      attempts: 2,
      finalId: "case_generated_patch",
      valid: true,
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "case_opening_review",
        "case_evidence_review",
        "blind_case_solution",
      ],
    });
    expect(provider.requestDetails[1]).toMatchObject({
      schemaName: "case_artifact_repair_patch",
      tier: "pro",
      reasoning: false,
      maxTokens: 3_200,
    });
    expect(
      provider.requestDetails.filter((request) => request.schemaName !== "case_evidence_review" || JSON.parse(request.messages[1]!.content).reviewBatch.index === 0).map(({ schemaName, reasoning, reasoningEffort, maxTokens }) => ({
        schemaName,
        reasoning,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        maxTokens,
      })),
    ).toEqual([
      { schemaName: "case_artifact", reasoning: false, maxTokens: 12_000 },
      {
        schemaName: "case_artifact_repair_patch",
        reasoning: false,
        maxTokens: 3_200,
      },
      {
        schemaName: "case_opening_review",
        reasoning: true,
        reasoningEffort: "low",
        maxTokens: 7_200,
      },
      {
        schemaName: "case_evidence_review",
        reasoning: false,
        maxTokens: 3_200,
      },
      {
        schemaName: "blind_case_solution",
        reasoning: true,
        reasoningEffort: "low",
        maxTokens: 8_000,
      },
    ]);
    expect(provider.requestDetails[1]?.messages[0]?.content).toContain("局部修复补丁");
    const repairContent = provider.requestDetails[1]?.messages[1]?.content ?? "{}";
    const repairPayload = JSON.parse(repairContent);
    expect(repairPayload).toHaveProperty("repairSnapshot");
    expect(repairPayload.repairSnapshot.structuralLedger.timeline).toEqual(valid.timeline);
    expect(repairPayload).not.toHaveProperty("draft");
    expect(repairContent.length).toBeLessThan(JSON.stringify(invalid).length);
  });

  it("retries a malformed compact patch before rejecting the case", async () => {
    const valid = generatedTutorial("case_generated_patch_retry", "seed-patch-retry");
    const invalid = structuredClone(valid);
    invalid.scenes = invalid.scenes.slice(0, 2);
    const provider = new ScriptedProvider([
      invalid,
      { unsupportedPatchField: true },
      { scenes: [valid.scenes[2]] },
      blindResult(valid),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("seed-patch-retry"));

    expect({
      attempts: result.attempt,
      finalId: result.finalArtifact?.id,
      calls: provider.stageRequests,
    }).toEqual({
      attempts: 3,
      finalId: "case_generated_patch_retry",
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "case_artifact_repair_patch",
        "case_opening_review",
        "case_evidence_review",
        "blind_case_solution",
      ],
    });
    const retriedRepair = JSON.parse(provider.requestDetails[2]!.messages[1]!.content);
    expect(retriedRepair.validationIssues).toContainEqual(expect.objectContaining({
      code: "invalid_repair_patch",
      message: expect.stringContaining("unsupportedPatchField"),
    }));
  });

  it("audits malformed and unparseable repair responses before retrying them", async () => {
    const valid = generatedTutorial(
      "case_generated_patch_audit",
      "seed-patch-audit",
    );
    const invalid = structuredClone(valid);
    invalid.scenes = invalid.scenes.slice(0, 2);
    const malformedPatch = structuredRepairOutputValidationError({
      unsupportedPatchField: true,
    });
    const unparseablePatch = new StructuredOutputParseError(
      "case_artifact_repair_patch",
      "mock-deepseek-pro",
      { inputTokens: 700, cachedInputTokens: 0, outputTokens: 80 },
      { content: "修复建议如下，但没有 JSON。" },
      "content 14 chars, finish_reason=stop",
    );
    const provider = new ScriptedProvider([
      invalid,
      malformedPatch,
      unparseablePatch,
      { scenes: [valid.scenes[2]] },
      blindResult(valid),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("seed-patch-audit"));

    expect(result.attempt).toBe(4);
    expect(modelStages(result.modelCalls)).toEqual([
      "case_draft",
      "case_repair_format_recovery",
      "case_repair_parse_recovery",
      "case_repair",
      "opening_review",
      "evidence_review",
      "blind_solve",
    ]);
    expect(result.modelCalls[1]?.response).toMatchObject({
      structuredOutputValidation: {
        schemaName: "case_artifact_repair_patch",
      },
    });
    expect(result.modelCalls[2]?.response).toMatchObject({
      structuredOutputParse: {
        schemaName: "case_artifact_repair_patch",
        diagnostic: "content 14 chars, finish_reason=stop",
      },
    });
  });

  it("audits a valid repair patch that cannot be merged into the case", async () => {
    const valid = generatedTutorial(
      "case_generated_patch_apply_audit",
      "seed-patch-apply-audit",
    );
    const invalid = structuredClone(valid);
    invalid.scenes = invalid.scenes.slice(0, 2);
    const provider = new ScriptedProvider([
      invalid,
      { characters: [{ id: "character_incomplete_new" }] },
      { scenes: [valid.scenes[2]] },
      blindResult(valid),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("seed-patch-apply-audit"));

    expect(modelStages(result.modelCalls)).toEqual([
      "case_draft",
      "case_repair_apply_recovery",
      "case_repair",
      "opening_review",
      "evidence_review",
      "blind_solve",
    ]);
  });

  it("repairs missing proof relationships instead of compiling a fabricated solution", async () => {
    const seed = "seed-systemic-normalization";
    const valid = generatedTutorial("case_generated_proof_repair", seed);
    const invalid = structuredClone(valid);
    const missingExclusions = invalid.evidence.filter((evidence) => evidence.excludesCharacterIds.length > 0);
    missingExclusions.forEach((evidence) => { evidence.excludesCharacterIds = []; });
    const compiled = compileMinimumSolutionChain(invalid);
    expect(compiled.evidence).toEqual(invalid.evidence);
    expect(validatePublishableCaseArtifact(compiled).issues).toContainEqual(expect.objectContaining({ code: "non_unique_solution" }));
    const repairs = valid.evidence.filter((evidence) => evidence.excludesCharacterIds.length > 0).map((evidence) => ({ id: evidence.id, excludesCharacterIds: evidence.excludesCharacterIds }));
    const provider = new ScriptedProvider([invalid, { evidence: repairs }, blindResult(valid)]);
    const result = await createCaseGenerationGraph(provider).invoke(initialState(seed));
    expect(result.attempt).toBe(2);
    expect(provider.stageRequests).toEqual(["case_artifact", "case_artifact_repair_patch", "case_opening_review", "case_evidence_review", "blind_case_solution"]);
    expect(result.finalArtifact?.evidence).toEqual(valid.evidence);
    const repair = JSON.parse(provider.requestDetails[1]!.messages[1]!.content);
    expect(repair.repairSnapshot).toHaveProperty("playerFacingText");
    expect(provider.requestDetails[1]).toMatchObject({ reasoning: false, reasoningEffort: undefined, maxTokens: 3_200 });
    expect(repair.repairSnapshot.structuralLedger.timeline).toEqual(valid.timeline);
    expect(compileMinimumSolutionChain(result.finalArtifact!)).toEqual(result.finalArtifact);
  });

  it.each([true, false])("shares a finite six-version budget across structural and semantic repairs (final repair succeeds: %s)", async (repairsFinalRelation) => {
    const seed = "supporting-seed-3";
    const valid = generatedTutorial("case_structural_then_semantic_repair", seed);
    const invalid = structuredClone(valid);
    const evidence = (id: string) => invalid.evidence.find((item) => item.id === id)!;
    const originalEvidence = (id: string) => valid.evidence.find((item) => item.id === id)!;
    const cup = evidence("evidence_teacup_residue");
    cup.discovery.sceneId = "scene_kitchen";
    const camera = evidence("evidence_camera_originals");
    camera.excludesCharacterIds = [];
    const testimony = evidence("evidence_housekeeper_testimony");
    testimony.discovery.dialogueAliases = ["谁送了茶"];
    testimony.supportsFactIds.push(invalid.solution.motiveFactId);
    const leakedProfile = "此前因分账不均与顾明远闹翻。";
    invalid.characters[1]!.publicProfile = leakedProfile;
    const unsupportedMotive = {
      evidenceId: testimony.id,
      unsupportedFactIds: [invalid.solution.motiveFactId],
      unsupportedImplicatedCharacterIds: [],
      unsupportedExcludedCharacterIds: [],
      reason: "该证词只说明送茶经过，未提供任何挪用资金或财务追责的动机信息。",
    };
    const provider = new ScriptedProvider([
      invalid,
      { evidence: [{ id: cup.id, discovery: { sceneId: originalEvidence(cup.id).discovery.sceneId } }] },
      { evidence: [{ id: camera.id, excludesCharacterIds: originalEvidence(camera.id).excludesCharacterIds }] },
      { evidence: [{ id: testimony.id, discovery: { dialogueAliases: originalEvidence(testimony.id).discovery.dialogueAliases } }] },
      { characters: [{ id: valid.characters[1]!.id, publicProfile: valid.characters[1]!.publicProfile }] },
      repairsFinalRelation
        ? { evidence: [{ id: testimony.id, supportsFactIds: originalEvidence(testimony.id).supportsFactIds }] }
        : { evidence: [{ id: testimony.id, supportsFactIds: testimony.supportsFactIds }] },
      ...(repairsFinalRelation ? [blindResult(valid)] : []),
    ], [
      { issues: [{ kind: "hidden_conflict", path: "characters[1].publicProfile", quote: leakedProfile, reason: "公开介绍直接透露具体财务冲突。" }] },
      { issues: [] },
      { issues: [] },
    ], [
      { issues: [unsupportedMotive] },
      { issues: repairsFinalRelation ? [] : [unsupportedMotive] },
    ]);

    const result = await createCaseGenerationGraph(provider).invoke(initialState(seed));

    expect(result.attempt).toBe(6);
    expect(provider.stageRequests).toEqual([
      "case_artifact",
      "case_artifact_repair_patch",
      "case_artifact_repair_patch",
      "case_artifact_repair_patch",
      "case_opening_review",
      "case_artifact_repair_patch",
      "case_opening_review",
      "case_evidence_review",
      "case_artifact_repair_patch",
      "case_opening_review",
      "case_evidence_review",
      ...(repairsFinalRelation ? ["blind_case_solution"] : []),
    ]);
    const patches = provider.requestDetails.filter((request) => request.schemaName === "case_artifact_repair_patch");
    expect(patches).toHaveLength(5);
    expect(JSON.parse(patches[0]!.messages[1]!.content).validationIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "discovery_location_mismatch" }),
      expect.objectContaining({ code: "non_unique_solution" }),
      expect.objectContaining({ code: "insufficient_interview_dialogue_aliases" }),
    ]));
    expect(JSON.parse(patches[4]!.messages[1]!.content).validationIssues).toEqual([
      expect.objectContaining({ code: "evidence_narrative_mismatch", message: expect.stringContaining(unsupportedMotive.reason) }),
    ]);
    if (repairsFinalRelation) {
      expect(result.finalArtifact).toEqual(valid);
      expect(result.rejectionReason).toBeNull();
    } else {
      expect(result.finalArtifact).toBeNull();
      expect(result.validationIssues).toEqual([expect.objectContaining({ code: "evidence_narrative_mismatch" })]);
      expect(result.rejectionReason).toContain(unsupportedMotive.reason);
      expect(provider.stageRequests).not.toContain("blind_case_solution");
    }
  });

  it.each(["evidence", "blind"])("exhausts all six late %s failures with a domain rejection instead of a recursion error", async (stage) => {
    const seed = "supporting-seed-3";
    const draft = structuredClone(generatedTutorial("case_late_repair_exhaustion", seed));
    const testimony = draft.evidence.find((evidence) => evidence.id === "evidence_housekeeper_testimony")!;
    if (stage === "evidence") testimony.supportsFactIds.push(draft.solution.motiveFactId);
    const unsupportedMotive = { evidenceId: testimony.id, unsupportedFactIds: [draft.solution.motiveFactId], unsupportedImplicatedCharacterIds: [], unsupportedExcludedCharacterIds: [], reason: "送茶见闻不能支持挪用资金的动机。" };
    const wrongBlindSolve = { ...blindResult(draft), culpritId: "character_shen_lan" };
    const responses: unknown[] = [draft];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      if (stage === "blind") responses.push(wrongBlindSolve);
      if (attempt < 6) responses.push({ evidence: [{ id: testimony.id, description: testimony.description }] });
    }
    const provider = new ScriptedProvider(responses, undefined,
      stage === "evidence" ? Array.from({ length: 6 }, () => ({ issues: [unsupportedMotive] })) : undefined,
    );

    const result = await createCaseGenerationGraph(provider).invoke(initialState(seed));

    expect(result.attempt).toBe(6);
    expect(result.finalArtifact).toBeNull();
    expect(result.validationIssues).toContainEqual(expect.objectContaining({ code: stage === "evidence" ? "evidence_narrative_mismatch" : "blind_solver_mismatch" }));
    expect(provider.stageRequests.filter((name) => name === "case_artifact_repair_patch")).toHaveLength(5);
    expect(provider.stageRequests.filter((name) => name === "case_evidence_review")).toHaveLength(6);
    expect(provider.stageRequests.filter((name) => name === "blind_case_solution")).toHaveLength(stage === "blind" ? 6 : 0);
  });

  it("repairs the current incomplete chain without reopening a fixed opening-method issue", async () => {
    const seed = "supporting-seed-0";
    const base = generatedTutorial("case_method_feedback", seed);
    const invalid = structuredClone(base);
    const methodFactId = invalid.solution.methodFactId;
    const openingEvidence = invalid.evidence.find(
      (evidence) => evidence.id === "evidence_broken_watch",
    )!;
    const laterMethodEvidence = invalid.evidence.find(
      (evidence) => evidence.id === "evidence_brass_bookend",
    )!;
    const motiveEvidence = invalid.evidence.find((evidence) => evidence.supportsFactIds.includes(invalid.solution.motiveFactId))!;
    const originalMotiveSupports = [...motiveEvidence.supportsFactIds];
    for (const evidence of invalid.evidence) {
      evidence.supportsFactIds = evidence.supportsFactIds.filter(
        (factId) => factId !== methodFactId && factId !== invalid.solution.motiveFactId,
      );
    }
    openingEvidence.supportsFactIds.push(methodFactId);
    openingEvidence.description =
      "伤口形态显示受害者先摄入镇静剂，随后遭黄铜书挡袭击。";
    if (!invalid.solution.requiredEvidenceIds.includes(openingEvidence.id)) invalid.solution.requiredEvidenceIds.push(openingEvidence.id);

    const afterOpeningRepair = structuredClone(invalid);
    const repairedOpening = afterOpeningRepair.evidence.find(
      (evidence) => evidence.id === openingEvidence.id,
    )!;
    repairedOpening.supportsFactIds = repairedOpening.supportsFactIds.filter(
      (factId) => factId !== methodFactId,
    );
    repairedOpening.description = base.evidence.find(
      (evidence) => evidence.id === openingEvidence.id,
    )!.description;
    afterOpeningRepair.evidence.find((evidence) => evidence.id === motiveEvidence.id)!.supportsFactIds = originalMotiveSupports;

    const finalDraft = structuredClone(afterOpeningRepair);
    finalDraft.evidence.find(
      (evidence) => evidence.id === laterMethodEvidence.id,
    )!.supportsFactIds.push(methodFactId);
    const provider = new ScriptedProvider([
      invalid,
      {
        evidence: [{
          id: openingEvidence.id,
          supportsFactIds: repairedOpening.supportsFactIds,
          description: repairedOpening.description,
        }, { id: motiveEvidence.id, supportsFactIds: originalMotiveSupports }],
      },
      {
        evidence: [{
          id: laterMethodEvidence.id,
          supportsFactIds: finalDraft.evidence.find(
            (evidence) => evidence.id === laterMethodEvidence.id,
          )!.supportsFactIds,
        }],
      },
      blindResult(finalDraft),
    ]);

    const result = await createCaseGenerationGraph(provider).invoke(
      initialState(seed),
    );

    expect(result.finalArtifact).toEqual(finalDraft);
    expect(result.attempt).toBe(3);
    expect(provider.stageRequests).toEqual([
      "case_artifact",
      "case_artifact_repair_patch",
      "case_artifact_repair_patch",
      "case_opening_review",
      "case_evidence_review",
      "blind_case_solution",
    ]);
    const repairs = provider.requestDetails.filter(
      (request) => request.schemaName === "case_artifact_repair_patch",
    );
    const openingRepair = JSON.parse(repairs[0]!.messages[1]!.content);
    expect(openingRepair.validationIssues).toContainEqual(
      expect.objectContaining({
        code: "premature_initial_scene_sensitive_fact",
        path: expect.stringContaining("supportsFactIds"),
      }),
    );
    expect(
      openingRepair.repairSnapshot.playerFacingText.evidence.find(
        (evidence: { id: string }) => evidence.id === openingEvidence.id,
      ).description,
    ).toContain("镇静剂");

    const chainRepair = JSON.parse(repairs[1]!.messages[1]!.content);
    expect(chainRepair.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "incomplete_solution" }),
        expect.objectContaining({
          code: "insufficient_required_evidence_chain",
        }),
      ]),
    );
    expect(chainRepair.validationIssues).not.toContainEqual(
      expect.objectContaining({ code: "premature_initial_scene_sensitive_fact" }),
    );
    expect(
      chainRepair.repairSnapshot.playerFacingText.evidence.find(
        (evidence: { id: string }) => evidence.id === openingEvidence.id,
      ).description,
    ).toBe(repairedOpening.description);
    expect(
      chainRepair.repairSnapshot.playerFacingText.evidence.find(
        (evidence: { id: string }) => evidence.id === laterMethodEvidence.id,
      ).description,
    ).toBe(laterMethodEvidence.description);
    expect(
      chainRepair.repairSnapshot.playerFacingText.facts.find(
        (fact: { id: string }) => fact.id === methodFactId,
      ).statement,
    ).toBe(
      invalid.facts.find((fact) => fact.id === methodFactId)!.statement,
    );
    expect(
      result.finalArtifact!.evidence.find(
        (evidence) => evidence.id === laterMethodEvidence.id,
      )!.discovery.prerequisiteEvidenceIds,
    ).toEqual(base.evidence.find((evidence) => evidence.id === laterMethodEvidence.id)!.discovery.prerequisiteEvidenceIds);
  });

  it("closes repairable list references across the generated artifact", () => {
    const draft = structuredClone(
      generatedTutorial("case_generated_reference_closure", "seed-reference-closure"),
    );
    const character = draft.characters[1]!;
    const sceneObject = draft.scenes[0]!.objects[0]!;
    const timelineEvent = draft.timeline[0]!;
    const claim = draft.claims[0]!;
    const evidence = draft.evidence[0]!;

    character.knowledge.factIds.push("fact_missing");
    character.knowledge.evidenceIds.push("evidence_missing");
    character.knowledge.claimIds.push("claim_missing");
    character.secretFactIds.push("fact_missing");
    character.lieRules.push({
      factId: "fact_missing",
      strategy: "deny",
      coverStatement: "这条不存在的事实不应进入发布账本。",
    });
    sceneObject.evidenceIds = ["evidence_missing"];
    timelineEvent.characterIds.push("character_missing");
    timelineEvent.factIds.push("fact_missing");
    claim.factIds.push("fact_missing");
    evidence.supportsFactIds.push("fact_missing");
    evidence.contradictsClaimIds.push("claim_missing");
    evidence.implicatesCharacterIds.push("character_missing");
    evidence.excludesCharacterIds.push("character_missing");
    draft.solution.requiredEvidenceIds.push("evidence_missing");
    draft.solution.requiredTimelineEventIds.push("timeline_missing");

    const compiled = compileMinimumSolutionChain(draft);
    const danglingIssues = validatePublishableCaseArtifact(compiled).issues.filter(
      (issue) => issue.code === "dangling_reference",
    );

    expect(danglingIssues).toEqual([]);
    expect(
      compiled.scenes[0]?.objects[0]?.evidenceIds,
    ).toEqual(expect.arrayContaining(
      compiled.evidence
        .filter(
          (item) =>
            item.discovery.objectId === compiled.scenes[0]?.objects[0]?.id,
        )
        .map((item) => item.id),
    ));
    expect(compileMinimumSolutionChain(compiled)).toEqual(compiled);
  });

  it("renames only claims that collide with another entity type and updates claim references", () => {
    const draft = structuredClone(generatedTutorial("case_claim_collision", "supporting-seed-0"));
    const claim = draft.claims.find((item) => item.id === "claim_li_alibi")!;
    const formerId = claim.id;
    // v5把反证留给能实际辨认本人入室的倒影记录；引用重命名仍覆盖该真实使用处。
    const contradictoryEvidence = draft.evidence.find((item) => item.contradictsClaimIds.includes(formerId))!;
    claim.id = "fact_motive_embezzlement";
    for (const character of draft.characters) character.knowledge.claimIds = character.knowledge.claimIds.map((id) => id === formerId ? claim.id : id);
    for (const evidence of draft.evidence) evidence.contradictsClaimIds = evidence.contradictsClaimIds.map((id) => id === formerId ? claim.id : id);
    const compiled = compileMinimumSolutionChain(draft);
    expect(compiled.claims.find((item) => item.statement === claim.statement)).toEqual({ ...claim, id: "claim_fact_motive_embezzlement" });
    expect(compiled.characters[1]!.knowledge.claimIds).toContain("claim_fact_motive_embezzlement");
    expect(compiled.evidence.find((evidence) => evidence.id === contradictoryEvidence.id)!.contradictsClaimIds).toContain("claim_fact_motive_embezzlement");
    expect(compiled.facts).toEqual(draft.facts);
    expect(compiled.evidence.map((evidence) => ({ ...evidence, contradictsClaimIds: [] }))).toEqual(draft.evidence.map((evidence) => ({ ...evidence, contradictsClaimIds: [] })));
    expect(validatePublishableCaseArtifact(compiled)).toEqual({ valid: true, issues: [] });

    const duplicateClaim = structuredClone(compiled);
    duplicateClaim.claims.push(structuredClone(duplicateClaim.claims[0]!));
    expect(validatePublishableCaseArtifact(compileMinimumSolutionChain(duplicateClaim)).issues).toContainEqual(expect.objectContaining({ code: "duplicate_entity_id" }));
  });

  it("preserves a valid proof, meaningful prerequisites and its authored chain", () => {
    const draft = generatedTutorial("case_generated_preserved", "supporting-seed-0");
    const compiled = compileMinimumSolutionChain(draft);
    expect(validatePublishableCaseArtifact(compiled)).toEqual({ valid: true, issues: [] });
    expect(compiled.solution).toEqual(draft.solution);
    expect(compiled.evidence).toEqual(draft.evidence);
    expect(compiled.unlockRules).toEqual(draft.unlockRules);
    expect(compiled.evidence.some((evidence) => evidence.discovery.prerequisiteEvidenceIds.length > 0)).toBe(true);
    expect(compiled.evidence.find((evidence) => evidence.id === "evidence_brass_bookend")?.description).toContain("李闻舟");
    expect([...findInitiallyDiscoverableSceneEvidenceIds(compiled)]).toEqual(["evidence_broken_watch"]);
  });

  it("does not invent proof relationships or replace an incomplete required chain", () => {
    const draft = structuredClone(generatedTutorial("case_generated_incomplete", "seed-compiled"));
    draft.solution.requiredEvidenceIds = draft.evidence.slice(0, 5).map((evidence) => evidence.id);
    draft.evidence.forEach((evidence) => {
      evidence.supportsFactIds = [];
      evidence.implicatesCharacterIds = [];
      evidence.excludesCharacterIds = [];
    });
    const compiled = compileMinimumSolutionChain(draft);
    expect(compiled.evidence).toEqual(draft.evidence);
    expect(compiled.solution).toEqual(draft.solution);
    expect(validatePublishableCaseArtifact(compiled).issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["non_unique_solution", "insufficient_required_evidence_chain"]));
  });

  it.each(["prerequisite", "unlock_all", "unlock_any"])("keeps an unknown %s condition blocked for repair", (condition) => {
    const draft = structuredClone(generatedTutorial("case_generated_blocked", "supporting-seed-0"));
    const clue = draft.evidence.find((evidence) => evidence.id === "evidence_broken_watch")!;
    if (condition === "prerequisite") {
      clue.discovery.prerequisiteEvidenceIds = ["evidence_missing"];
    } else {
      draft.unlockRules.push({
        id: "unlock_initial_watch",
        targetType: "evidence",
        targetId: clue.id,
        allEvidenceIds: condition === "unlock_all" ? ["evidence_missing"] : [],
        anyEvidenceIds: condition === "unlock_any" ? ["evidence_missing"] : [],
      });
    }
    const compiled = compileMinimumSolutionChain(draft);
    expect(compiled.evidence).toEqual(draft.evidence);
    expect(compiled.unlockRules).toEqual(draft.unlockRules);
    expect(findReachableEvidenceIds(compiled).has(clue.id)).toBe(false);
    expect(validatePublishableCaseArtifact(compiled).issues).toContainEqual(expect.objectContaining({ code: "dangling_reference" }));
    const investigated = performInvestigation(compiled, startGame(compiled), {
      commandId: `investigate_${condition}`,
      text: clue.discovery.actionAliases[0]!,
      sceneId: clue.discovery.sceneId,
    });
    expect(investigated.session.discoveredEvidenceIds).not.toContain(clue.id);
  });

  it("preserves invalid direct-scene exclusions for the validator to reject", () => {
    const draft = structuredClone(generatedTutorial("case_generated_direct_invalid", "seed-direct-normalized"));
    const direct = draft.evidence.find((evidence) => evidence.id === "evidence_brass_bookend")!;
    direct.excludesCharacterIds = draft.characters.filter((character) => character.roleTier === "suspect" && character.id !== draft.culpritId).map((character) => character.id);
    const compiled = compileMinimumSolutionChain(draft);
    expect(compiled.evidence.find((evidence) => evidence.id === direct.id)?.excludesCharacterIds).toEqual(direct.excludesCharacterIds);
    expect(validatePublishableCaseArtifact(compiled).issues).toContainEqual(expect.objectContaining({ code: "premature_direct_evidence_lock" }));
  });

  it.each([
    ["profile", "hidden_conflict", "此前因分账不均与顾明远闹翻。"],
    ["anonymous_clue", "identity_shortcut", "记录显示，唯一负责基金会财务的人当晚曾要求销毁审计材料。"],
    ["early_testimony", "early_testimony", "当晚我在走廊听到死者与一名来客激烈争吵。"],
  ])("repairs a semantic %s shortcut, reviews again, then blind-solves", async (location, kind, leakedText) => {
    const seed = "supporting-seed-0";
    const valid = generatedTutorial("case_opening_repair", seed);
    const invalid = structuredClone(valid);
    const firstClue = invalid.evidence.find((evidence) => evidence.id === "evidence_broken_watch")!;
    const clueIndex = invalid.evidence.indexOf(firstClue);
    const leakedFromProfile = location !== "anonymous_clue";
    if (leakedFromProfile) invalid.characters[1]!.publicProfile = leakedText;
    else firstClue.description = leakedText;
    expect(validateInitialScenePacing(invalid)).toEqual([]);
    expect(compileMinimumSolutionChain(invalid).evidence).toEqual(invalid.evidence);
    const issue = { kind, path: leakedFromProfile ? "characters[1].publicProfile" : `evidence[${clueIndex}].description`, quote: leakedText, reason: "开局材料提前给出隐藏冲突、关键见闻或唯一身份对应，需留到后续调查。" };
    const patch = leakedFromProfile
      ? { characters: [{ id: valid.characters[1]!.id, publicProfile: valid.characters[1]!.publicProfile }] }
      : { evidence: [{ id: firstClue.id, description: valid.evidence[clueIndex]!.description }] };
    const provider = new ScriptedProvider([invalid, patch, blindResult(valid)], [{ issues: [issue] }, { issues: [] }]);
    const result = await createCaseGenerationGraph(provider).invoke(initialState(seed));
    expect(result.finalArtifact).toEqual(valid);
    expect(result.attempt).toBe(2);
    expect(provider.stageRequests).toEqual(["case_artifact", "case_opening_review", "case_artifact_repair_patch", "case_opening_review", "case_evidence_review", "blind_case_solution"]);
    expect(modelStages(result.modelCalls)).toEqual(["case_draft", "opening_review", "case_repair", "opening_review", "evidence_review", "blind_solve"]);
    const repair = JSON.parse(provider.requestDetails[2]!.messages[1]!.content);
    expect(repair.validationIssues).toContainEqual(expect.objectContaining({ code: "initial_information_shortcut", path: issue.path, message: expect.stringContaining(leakedText) }));
    expect(JSON.stringify(repair.repairSnapshot.playerFacingText)).toContain(leakedText);
    const reviewedAgain = JSON.parse(provider.requestDetails[3]!.messages[1]!.content);
    expect(JSON.stringify(reviewedAgain)).not.toContain(leakedText);
  });

  it("rejects repeated opening-review failures after the repair budget", async () => {
    const seed = "supporting-seed-0";
    const draft = structuredClone(generatedTutorial("case_opening_rejected", seed));
    const leakedText = "此前因分账不均与顾明远闹翻。";
    draft.characters[1]!.publicProfile = leakedText;
    const issue = { kind: "hidden_conflict", path: "characters[1].publicProfile", quote: leakedText, reason: "直接揭露具体财务冲突。" };
    const provider = new ScriptedProvider([draft, { title: draft.title }], [{ issues: [issue] }, { issues: [issue] }]);
    const result = await createCaseGenerationGraph(provider, { maxArtifactAttempts: 2 }).invoke(initialState(seed));
    expect(result.finalArtifact).toBeNull();
    expect(result.rejectionReason).toContain(leakedText);
    expect(modelStages(result.modelCalls)).toEqual(["case_draft", "opening_review", "case_repair", "opening_review"]);
    expect(provider.stageRequests).not.toContain("blind_case_solution");
  });

  it.each([
    new Error("opening review unavailable"),
    { unexpected: true },
    { issues: [{ path: "characters[1].publicProfile", quote: "此前因分账不均与顾明远闹翻。", reason: "未分类的问题不能被默认为安全线索。" }] },
  ])("cannot publish when the opening review errors or is malformed: %j", async (failure) => {
    const seed = "supporting-seed-0";
    const draft = generatedTutorial("case_opening_error", seed);
    const provider = new ScriptedProvider([draft, blindResult(draft)], [failure]);
    await expect(createCaseGenerationGraph(provider).invoke(initialState(seed))).rejects.toThrow();
    expect(provider.stageRequests).toEqual(["case_artifact", "case_opening_review"]);
  });

  it("passes an ordinary lead even when the reviewer records its quote and reason in issues", async () => {
    const seed = "supporting-seed-0";
    const draft = structuredClone(generatedTutorial("case_opening_suspicion", seed));
    const quote = "李闻舟曾在二楼走廊附近出现，但到访时间及其他人的行踪仍需核实。";
    draft.briefing += quote;
    const provider = new ScriptedProvider([draft, blindResult(draft)], [{
      issues: [{
        kind: "ordinary_lead",
        path: "briefing",
        quote,
        reason: "这只是合理怀疑，尚未锁定真凶；到访时间及其他人的行踪有合理替代解释，仍需后续核验。",
      }],
    }]);
    const result = await createCaseGenerationGraph(provider).invoke(initialState(seed));
    expect(result.finalArtifact?.briefing).toBe(draft.briefing);
    expect(result.attempt).toBe(1);
    expect(result.validationIssues).toEqual([]);
    expect(provider.stageRequests).toEqual(["case_artifact", "case_opening_review", "case_evidence_review", "blind_case_solution"]);
    expect(provider.requestDetails[1]!.messages[0]!.content).toContain("合理的怀疑不等于锁定");
  });

  it("gives the opening reviewer only the actual initial public dossier", () => {
    const draft = generatedTutorial("case_opening_input", "supporting-seed-0");
    const messages = buildOpeningReviewMessages(draft);
    const dossier = JSON.parse(messages[1]!.content);
    const serialized = JSON.stringify(dossier);
    expect(dossier.initialEvidence.map((evidence: { id: string }) => evidence.id)).toEqual(["evidence_broken_watch"]);
    expect(dossier.characters.map((character: { id: string }) => character.id)).not.toContain("character_han_zhuo");
    expect(serialized).not.toMatch(/"(?:culpritId|solution|privateProfile|secretFactIds|lieRules|knowledge|claims|timeline|supportsFactIds|implicatesCharacterIds|excludesCharacterIds)"/);
    expect(serialized).not.toContain("挪用资金即将败露");
    expect(serialized).not.toContain(draft.evidence.find((evidence) => evidence.id === "evidence_transfer_ledger")!.description);
    expect(serialized).not.toContain(draft.facts.find((fact) => fact.id === draft.solution.methodFactId)!.statement);
  });

  it("repairs a required interview with no visible question lead in the existing evidence review", async () => {
    const seed = "supporting-seed-3";
    const valid = generatedTutorial("case_hidden_interview_question", seed);
    const invalid = structuredClone(valid);
    const testimony = invalid.evidence.find((evidence) => evidence.id === "evidence_housekeeper_testimony")!;
    testimony.discovery.dialogueAliases = ["青瓷暗纹", "三七交接号", "朱砂圆印"];
    const reviewIssue = {
      evidenceId: testimony.id,
      unsupportedFactIds: [],
      unsupportedImplicatedCharacterIds: [],
      unsupportedExcludedCharacterIds: [],
      missingInterviewLead: true,
      reason: "茶盘是公开调查方向，但三个问法仅含从未公开的暗号，无法自然引出访谈。",
    };
    const provider = new ScriptedProvider([
      invalid,
      { evidence: [{ id: testimony.id, discovery: { dialogueAliases: valid.evidence.find((evidence) => evidence.id === testimony.id)!.discovery.dialogueAliases } }] },
      blindResult(valid),
    ], undefined, [{ issues: [reviewIssue] }, { issues: [] }]);

    const result = await createCaseGenerationGraph(provider).invoke(initialState(seed));

    expect(result.finalArtifact).toEqual(valid);
    expect(result.attempt).toBe(2);
    expect(provider.stageRequests).toEqual(["case_artifact", "case_opening_review", "case_evidence_review", "case_artifact_repair_patch", "case_opening_review", "case_evidence_review", "blind_case_solution"]);
    const repair = JSON.parse(provider.requestDetails.find((request) => request.schemaName === "case_artifact_repair_patch")!.messages[1]!.content);
    expect(repair.validationIssues).toContainEqual(expect.objectContaining({
      code: "missing_interview_lead",
      path: `evidence[${invalid.evidence.indexOf(testimony)}].discovery.dialogueAliases`,
      message: expect.stringContaining(reviewIssue.reason),
    }));
  });

  it("rejects repeated missing interview leads after the normal repair budget", async () => {
    const seed = "supporting-seed-3";
    const draft = structuredClone(generatedTutorial("case_unaskable_interview", seed));
    draft.evidence.find((evidence) => evidence.id === "evidence_housekeeper_testimony")!.discovery.dialogueAliases = ["青瓷暗纹", "三七交接号", "朱砂圆印"];
    const review = { issues: [{ evidenceId: "evidence_housekeeper_testimony", unsupportedFactIds: [], unsupportedImplicatedCharacterIds: [], unsupportedExcludedCharacterIds: [], missingInterviewLead: true, reason: "必要访谈只能用未公开的暗号触发。" }] };
    const provider = new ScriptedProvider([draft, { evidence: [{ id: "evidence_housekeeper_testimony", discovery: { dialogueAliases: ["青瓷暗纹", "三七交接号", "朱砂圆印"] } }] }], undefined, [review, review]);

    const result = await createCaseGenerationGraph(provider, { maxArtifactAttempts: 2 }).invoke(initialState(seed));

    expect(result.finalArtifact).toBeNull();
    expect(result.rejectionReason).toContain("必要访谈只能用未公开的暗号触发");
    expect(provider.stageRequests).not.toContain("blind_case_solution");
  });

  it("repairs unsupported exclusions after evidence review, then reruns both reviews before blind solving", async () => {
    const seed = "supporting-seed-0";
    const valid = generatedTutorial("case_evidence_review_repair", seed);
    const invalid = structuredClone(valid);
    const testimony = invalid.evidence.find(
      (evidence) => evidence.id === "evidence_housekeeper_testimony",
    )!;
    const testimonyIndex = invalid.evidence.indexOf(testimony);
    const unsupportedIds = [
      "character_shen_lan",
      "character_chen_mo",
    ];
    // 保留韩卓对赵衡的独立排除，使两名必要证人仍各有实际贡献；这里只造其余两项虚假排除。
    const groundedExclusions = valid.evidence
      .filter((evidence) =>
        evidence.excludesCharacterIds.some((id) => unsupportedIds.includes(id)),
      )
      .map((evidence) => ({
        id: evidence.id,
        excludesCharacterIds: evidence.excludesCharacterIds,
      }));
    for (const evidence of invalid.evidence) {
      evidence.excludesCharacterIds = evidence.excludesCharacterIds.filter(
        (id) => !unsupportedIds.includes(id),
      );
    }
    testimony.excludesCharacterIds = unsupportedIds;
    const reviewIssue = {
      evidenceId: testimony.id,
      unsupportedFactIds: [],
      unsupportedImplicatedCharacterIds: [],
      unsupportedExcludedCharacterIds: unsupportedIds,
      reason: "正文只说明罗芳看到李闻舟送茶，不能据此排除没有被证词提及的沈岚和陈默。",
    };
    const provider = new ScriptedProvider(
      [
        invalid,
        { evidence: [{ id: testimony.id, excludesCharacterIds: [] }] },
        { evidence: groundedExclusions },
        blindResult(valid),
      ],
      undefined,
      [{ issues: [reviewIssue] }, { issues: [] }],
    );

    const result = await createCaseGenerationGraph(provider).invoke(
      initialState(seed),
    );

    expect(result.finalArtifact).toEqual(valid);
    expect(result.attempt).toBe(3);
    expect(provider.stageRequests).toEqual([
      "case_artifact",
      "case_opening_review",
      "case_evidence_review",
      "case_artifact_repair_patch",
      "case_artifact_repair_patch",
      "case_opening_review",
      "case_evidence_review",
      "blind_case_solution",
    ]);
    expect(modelStages(result.modelCalls)).toEqual([
      "case_draft",
      "opening_review",
      "evidence_review",
      "case_repair",
      "case_repair",
      "opening_review",
      "evidence_review",
      "blind_solve",
    ]);
    const repairRequests = provider.requestDetails.filter(
      (request) => request.schemaName === "case_artifact_repair_patch",
    );
    const repairRequest = repairRequests[0]!;
    const repair = JSON.parse(repairRequest.messages[1]!.content);
    expect(repairRequests).toEqual([
      expect.objectContaining({ reasoning: false, reasoningEffort: undefined, maxTokens: 3_200 }),
      expect.objectContaining({ reasoning: false, reasoningEffort: undefined, maxTokens: 3_200 }),
    ]);
    expect(repair.repairSnapshot.structuralLedger.timeline).toEqual(valid.timeline);
    for (const characterId of unsupportedIds) {
      expect(repair.validationIssues).toContainEqual({
        code: "evidence_narrative_mismatch",
        path: `evidence[${testimonyIndex}]`,
        message: expect.stringContaining(`unsupported exclusions ${characterId}`),
      });
    }
    expect(
      repair.repairSnapshot.structuralLedger.evidence.find(
        (evidence: { id: string }) => evidence.id === testimony.id,
      ).excludesCharacterIds,
    ).toEqual(unsupportedIds);
    expect(
      repair.repairSnapshot.structuralLedger.evidence.find(
        (evidence: { id: string }) => evidence.id === testimony.id,
      ).discovery.dialogueUtterance,
    ).toBe(testimony.discovery.dialogueUtterance);
    expect(
      repair.repairSnapshot.playerFacingText.evidence.find(
        (evidence: { id: string }) => evidence.id === testimony.id,
      ).description,
    ).toBe(testimony.description);
    const structuralRepair = JSON.parse(repairRequests[1]!.messages[1]!.content);
    expect(structuralRepair.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "non_unique_solution" }),
      ]),
    );
    expect(structuralRepair.validationIssues).not.toContainEqual(
      expect.objectContaining({ code: "evidence_narrative_mismatch" }),
    );
  });

  it.each([true, false])("does not discard an unsupported contradiction when all other relation issue arrays are empty (repair: %s)", async (repair) => {
    const seed = "supporting-seed-0";
    const valid = generatedTutorial("case_unsupported_contradiction", seed);
    const invalid = structuredClone(valid);
    const evidence = invalid.evidence.find((item) => item.id === "evidence_teacup_residue")!;
    const claim = invalid.claims.find((item) => item.id === "claim_li_alibi")!;
    evidence.contradictsClaimIds = [claim.id];
    const issue = {
      evidenceId: evidence.id,
      unsupportedFactIds: [], unsupportedImplicatedCharacterIds: [], unsupportedExcludedCharacterIds: [],
      unsupportedContradictedClaimIds: [claim.id],
      reason: "茶杯检验不能反驳李闻舟未到书房的具体行踪声明。",
    };
    const provider = new ScriptedProvider(
      repair ? [invalid, { evidence: [{ id: evidence.id, contradictsClaimIds: [] }] }, blindResult(valid)] : [invalid],
      undefined,
      repair ? [{ issues: [issue] }, { issues: [] }] : [{ issues: [issue] }],
    );
    const result = await createCaseGenerationGraph(provider, { maxArtifactAttempts: repair ? 2 : 1 }).invoke(initialState(seed));
    const reviewRequest = provider.requestDetails.find((request) => request.schemaName === "case_evidence_review" && JSON.parse(request.messages[1]!.content).claims.some((item: { id: string }) => item.id === claim.id))!;
    const dossier = JSON.parse(reviewRequest.messages[1]!.content);
    expect(dossier.claims).toContainEqual({ id: claim.id, speakerId: claim.speakerId, statement: claim.statement });
    expect(dossier.evidence.find((item: { id: string }) => item.id === evidence.id).contradictsClaimIds).toEqual([claim.id]);
    if (repair) {
      expect(result.finalArtifact).toEqual(valid);
      const patchRequest = provider.requestDetails.find((request) => request.schemaName === "case_artifact_repair_patch")!;
      expect(JSON.parse(patchRequest.messages[1]!.content).validationIssues).toContainEqual(
        expect.objectContaining({ code: "evidence_narrative_mismatch", message: expect.stringContaining(`unsupported contradictions ${claim.id}`) }),
      );
      expect(provider.stageRequests.filter((name) => name === "case_evidence_review")).toHaveLength(2);
    } else {
      expect(result.finalArtifact).toBeNull();
      expect(result.rejectionReason).toContain(issue.reason);
      expect(provider.stageRequests).not.toContain("blind_case_solution");
    }
  });

  it("rejects repeated evidence-narrative failures after the repair budget", async () => {
    const seed = "supporting-seed-0";
    const draft = structuredClone(
      generatedTutorial("case_evidence_review_rejected", seed),
    );
    draft.evidence.find(
      (evidence) => evidence.id === "evidence_housekeeper_testimony",
    )!.excludesCharacterIds = ["character_shen_lan"];
    const issue = {
      evidenceId: "evidence_housekeeper_testimony",
      unsupportedFactIds: [],
      unsupportedImplicatedCharacterIds: [],
      unsupportedExcludedCharacterIds: ["character_shen_lan"],
      reason: "看到李闻舟送茶并不能排除沈岚。",
    };
    const provider = new ScriptedProvider(
      [draft, { evidence: [{ id: issue.evidenceId, excludesCharacterIds: issue.unsupportedExcludedCharacterIds }] }],
      undefined,
      [{ issues: [issue] }, { issues: [issue] }],
    );

    const result = await createCaseGenerationGraph(provider, {
      maxArtifactAttempts: 2,
    }).invoke(initialState(seed));

    expect(result.finalArtifact).toBeNull();
    expect(result.rejectionReason).toContain(
      "evidence_housekeeper_testimony: unsupported exclusions",
    );
    expect(result.rejectionReason).toContain("character_shen_lan");
    expect(provider.stageRequests).toEqual([
      "case_artifact",
      "case_opening_review",
      "case_evidence_review",
      "case_artifact_repair_patch",
      "case_opening_review",
      "case_evidence_review",
    ]);
    expect(provider.stageRequests).not.toContain("blind_case_solution");
  });

  it.each(["missing", "unknown", "duplicate", "out-of-scope"])("rejects %s evidence-review obligations instead of filtering to an empty green light", async (mode) => {
    const seed = "supporting-seed-0";
    const draft = generatedTutorial("case_evidence_review_coverage", seed);
    const plan = buildEvidenceReviewBatches(buildEvidenceReviewPlan(draft))[0]!;
    const review = makeSupportedEvidenceReview(plan);
    if (mode === "missing") review.results.pop();
    if (mode === "unknown") review.results[0]!.obligationId = "not_requested";
    if (mode === "duplicate") review.results.push(review.results[0]!);
    if (mode === "out-of-scope") review.results[0]!.citations[0]!.sourceId = "truthTimeline";
    const provider = new ScriptedProvider(
      [draft],
      undefined,
      [review],
    );

    await expect(createCaseGenerationGraph(provider, { maxArtifactAttempts: 1 }).invoke(
      initialState(seed),
    )).rejects.toThrow("coverage/source contract");
    expect(provider.stageRequests).toEqual([
      "case_artifact",
      "case_opening_review",
      "case_evidence_review",
    ]);
  });

  it.each([
    new Error("evidence review unavailable"),
    { unexpected: true },
  ])("cannot publish when evidence review errors or is malformed: %j", async (failure) => {
    const seed = "supporting-seed-0";
    const draft = generatedTutorial("case_evidence_review_error", seed);
    const provider = new ScriptedProvider(
      [draft, blindResult(draft)],
      undefined,
      [failure],
    );

    await expect(
      createCaseGenerationGraph(provider).invoke(initialState(seed)),
    ).rejects.toThrow();
    expect(provider.stageRequests).toEqual([
      "case_artifact",
      "case_opening_review",
      "case_evidence_review",
    ]);
  });

  it("gives evidence review only public setting and treats fact targets as unproven", () => {
    const draft = generatedTutorial(
      "case_evidence_review_input",
      "supporting-seed-0",
    );
    const messages = buildEvidenceReviewMessages(draft);
    const dossier = JSON.parse(messages[1]!.content);
    const serialized = JSON.stringify(dossier);

    expect(Object.keys(dossier)).toEqual([
      "setting",
      "characters",
      "facts",
      "claims",
      "evidence",
      "sourceEvidence",
      "reviewPlan",
    ]);
    expect(serialized).not.toMatch(
      /"(?:culpritId|victimId|solution|privateProfile|secretFactIds|lieRules|knowledge|timeline|requiredEvidenceIds)"\s*:/,
    );
    expect(dossier.setting).toEqual({ era: draft.setting.era, place: draft.setting.place });
    expect(dossier).not.toHaveProperty("truthTimeline");
    const contradictedIds = new Set(draft.evidence.flatMap((evidence) => evidence.contradictsClaimIds));
    expect(dossier.claims).toEqual(draft.claims.filter((claim) => contradictedIds.has(claim.id)).map((claim) => ({
      id: claim.id, speakerId: claim.speakerId, statement: claim.statement,
    })));
    expect(messages[0]!.content).toContain(
      "facts、claims 同样只是待核对的关联目标，不是独立证据来源",
    );
    expect(messages[0]!.content).toContain(
      "看到甲经过现场，只能涉及甲，不能排除乙丙丁",
    );
    expect(messages[0]!.content).toMatch(
      /implicates.{0,30}(?:涉及|合理怀疑).{0,30}(?:不等于|不能).{0,30}(?:定罪|定案)/u,
    );
  });

  it("does not supply private discovery or fatal-event times as public review evidence", () => {
    const draft = structuredClone(generatedTutorial("case_review_time_window", "supporting-seed-0"));
    draft.setting.occurredAt = "2025-03-14T23:30:00+08:00";
    draft.timeline = [{
      id: "event_actual_fatal_blow",
      timestamp: "2025-03-14T23:00:00+08:00",
      description: "受害者此时遭钝器击中，23:30才被发现。",
      sceneId: draft.scenes[0]!.id,
      characterIds: [draft.victimId, draft.culpritId],
      factIds: [draft.solution.methodFactId],
    }];
    const messages = buildEvidenceReviewMessages(draft);
    const dossier = JSON.parse(messages[1]!.content);
    expect(dossier.setting).not.toHaveProperty("occurredAt");
    expect(dossier).not.toHaveProperty("truthTimeline");
    expect(messages[0]!.content).toContain("先区分实际实施致死行为与发现死亡");
    expect(messages[0]!.content).toContain("输入不提供内幕发生时刻或真相时间线");
    expect(messages[0]!.content).toContain("未说明实际窗口与本人身份核验时，不能排除本人");
  });

  it("gives the reviewer public question context without treating the target interview or its unlocks as prior leads", () => {
    const draft = structuredClone(generatedTutorial("case_interview_lead_context", "supporting-seed-3"));
    const interview = draft.evidence.find((evidence) => evidence.id === "evidence_housekeeper_testimony")!;
    const record = draft.evidence.find((evidence) => evidence.id === "evidence_torn_audit_memo")!;
    // 构造一条目标访谈之前可取得的独立记录，保持公开claim可作追问入口的正例。
    draft.evidence.find((evidence) => evidence.id === "evidence_livestream_record")!.discovery.prerequisiteEvidenceIds = ["evidence_broken_watch"];
    record.discovery.prerequisiteEvidenceIds = [interview.id];
    const messages = buildEvidenceReviewMessages(draft);
    const dossier = JSON.parse(messages[1]!.content);
    const reviewedInterview = dossier.evidence.find((evidence: { id: string }) => evidence.id === interview.id);
    const lead = dossier.reviewPlan.obligations.find((item: { kind: string; evidenceId: string }) => item.kind === "interview_lead" && item.evidenceId === interview.id);
    const leadSources = dossier.reviewPlan.sources.filter((source: { id: string }) => lead.allowedSourceIds.includes(source.id));
    const leadEvidenceIds = leadSources.map((source: { evidenceId?: string }) => source.evidenceId);

    expect(reviewedInterview).toMatchObject({ isRequiredInterview: true, characterId: interview.discovery.characterId, dialogueAliases: interview.discovery.dialogueAliases });
    expect(leadEvidenceIds).toContain("evidence_broken_watch");
    expect(leadEvidenceIds).not.toContain(interview.id);
    expect(leadEvidenceIds).not.toContain(record.id);
    expect(leadEvidenceIds).not.toContain("evidence_smart_lock_log");
    expect(leadSources).toContainEqual(expect.objectContaining({ path: "briefing", text: draft.briefing }));
    expect(leadSources).toContainEqual(expect.objectContaining({ path: "scenes[1].objects[0].description", text: expect.stringContaining("询问厨房值守人员") }));
    expect(leadSources).toContainEqual(expect.objectContaining({ text: draft.claims.find((claim) => claim.id === "claim_chen_alibi")!.statement }));
    expect(messages[0]!.content).toContain("玩家可见的非剧透追问线索");
    expect(messages[0]!.content).toContain("不要求提前出现具体答案或精确关键词");
  });

  it("repairs a logically opaque case when the blind detective chooses differently", async () => {
    const artifact = generatedTutorial("case_generated_three", "seed-three");
    const provider = new ScriptedProvider([
      artifact,
      { ...blindResult(artifact), culpritId: "character_shen_lan" },
      {
        evidence: [
          {
            id: artifact.evidence[0]!.id,
            description: `${artifact.evidence[0]!.description} 这条记录与其他证据相互印证。`,
          },
        ],
      },
      blindResult(artifact),
    ]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("seed-three"));

    expect({
      attempts: result.attempt,
      finalId: result.finalArtifact?.id,
      calls: provider.stageRequests,
    }).toEqual({
      attempts: 2,
      finalId: "case_generated_three",
      calls: [
        "case_artifact",
        "case_opening_review",
        "case_evidence_review",
        "blind_case_solution",
        "case_artifact_repair_patch",
        "case_opening_review",
        "case_evidence_review",
        "blind_case_solution",
      ],
    });
    const blindRepairPayload = JSON.parse(
      provider.requestDetails.find((request) => request.schemaName === "case_artifact_repair_patch")?.messages[1]?.content ?? "{}",
    );
    expect(blindRepairPayload).toHaveProperty("repairSnapshot.playerFacingText");
  });

  it("rejects an invalid case after the finite repair budget", async () => {
    const invalid = structuredClone(
      generatedTutorial("case_generated_rejected", "seed-rejected"),
    );
    invalid.scenes = invalid.scenes.slice(0, 2);
    const provider = new ScriptedProvider([invalid]);
    const graph = createCaseGenerationGraph(provider, { maxArtifactAttempts: 1 });
    const result = await graph.invoke(initialState("seed-rejected"));

    expect(result.finalArtifact).toBeNull();
    expect(result.rejectionReason).toContain("at least 3 scenes");
    expect(provider.stageRequests).toEqual(["case_artifact"]);
  });

  it("keeps truth fields and private profiles out of the blind dossier", () => {
    const serialized = JSON.stringify(buildBlindSolveMessages(tutorialCase));

    expect({
      hasEvidence: serialized.includes(tutorialCase.evidence[0]!.name),
      hasOriginalEvidenceId: serialized.includes("evidence_smart_lock_log"),
      hasCulpritField: JSON.parse(buildBlindSolveMessages(tutorialCase)[1]!.content).culpritId !== undefined,
      hasSolution: serialized.includes('"solution"'),
      hasPrivateProfile: serialized.includes("挪用资金即将败露"),
      hasClaimKind: serialized.includes('"kind":"lie"'),
    }).toEqual({
      hasEvidence: true,
      hasOriginalEvidenceId: false,
      hasCulpritField: false,
      hasSolution: false,
      hasPrivateProfile: false,
      hasClaimKind: false,
    });
  });

  it("omits unreachable evidence, claims and truth metadata from the blind dossier", () => {
    const draft = structuredClone(generatedTutorial("case_blind_input", "supporting-seed-0"));
    const unreachable = draft.evidence.find((evidence) => evidence.id === "evidence_camera_reflection")!;
    unreachable.discovery.prerequisiteEvidenceIds = [unreachable.id];
    const dossier = JSON.parse(buildBlindSolveMessages(draft)[1]!.content);
    expect(dossier.fullyDiscoveredEvidence.map((evidence: { name: string }) => evidence.name)).not.toContain(unreachable.name);
    expect(JSON.stringify(dossier)).not.toMatch(/"(?:culpritId|solution|privateProfile|claims|timeline|facts|supportsFactIds|implicatesCharacterIds|excludesCharacterIds|contradictsClaimIds)"/);
    expect(dossier.fullyDiscoveredEvidence).toContainEqual(expect.objectContaining({ name: draft.evidence.find((evidence) => evidence.id === "evidence_brass_bookend")!.name, description: draft.evidence.find((evidence) => evidence.id === "evidence_brass_bookend")!.description }));
    const interview = draft.evidence.find((evidence) => evidence.id === "evidence_housekeeper_testimony")!;
    expect(dossier.fullyDiscoveredEvidence).toContainEqual(expect.objectContaining({
      name: interview.name, description: interview.description, dialogueUtterance: interview.discovery.dialogueUtterance,
    }));
  });

  it("hides answer-bearing identifiers and restores only references actually supplied to the blind detective", () => {
    const source = generatedTutorial("case_opaque_references", "supporting-seed-0");
    const draft = JSON.parse(JSON.stringify(source)
      .replaceAll(source.culpritId, "character_culprit")
      .replaceAll("evidence_housekeeper_testimony", "evidence_culprit_testimony")) as CaseArtifact;
    const input = buildBlindSolveInput(draft);
    const serialized = JSON.stringify(input.messages);
    for (const entity of [...draft.characters, ...draft.evidence]) expect(serialized).not.toContain(entity.id);
    const protocol = new ScriptedBlindProtocol();
    protocol.reply({ schemaName: "case_artifact", messages: [] }, draft);
    const reply = protocol.reply({ schemaName: "blind_case_solution", messages: input.messages }, blindResult(draft)) as ReturnType<typeof blindResult>;
    const restored = input.restoreResult({ ...reply, reasoning: `依据 ${reply.evidenceIds[0]} 判断 ${reply.culpritId}，其余证据共同补齐动机、手法及其他人的排除。` })!;
    expect(restored.culpritId).toBe(draft.culpritId);
    expect(restored.evidenceIds).toEqual(blindResult(draft).evidenceIds);
    expect(restored.reasoning).toContain(draft.culpritId);
    expect(restored.reasoning).toContain(restored.evidenceIds[0]);
    expect(blindSolveSupportsConclusion(draft, restored)).toBe(true);
    expect(input.restoreResult({ ...reply, culpritId: draft.culpritId })).toBeNull();
    expect(input.restoreResult({ ...reply, culpritId: "person_0000000000000000" })).toBeNull();
    expect(input.restoreResult({ ...reply, evidenceIds: [...reply.evidenceIds, draft.evidence[0]!.id] })).toBeNull();
    expect(input.restoreResult({ ...reply, evidenceIds: [...reply.evidenceIds, "exhibit_0000000000000000"] })).toBeNull();
    expect(input.restoreResult({ ...reply, culpritId: "" })?.culpritId).toBe("");
  });

  it("keeps blind references independent of the hidden answer and author array order", () => {
    const draft = structuredClone(generatedTutorial("case_blind_order", "supporting-seed-0"));
    const original = buildBlindSolveMessages(draft);
    draft.culpritId = draft.characters.find((character) => character.roleTier === "suspect" && character.id !== draft.culpritId)!.id;
    draft.solution.culpritId = draft.culpritId;
    draft.characters.reverse();
    draft.evidence.reverse();
    expect(buildBlindSolveMessages(draft)).toEqual(original);
    const firstPeople = new Set(Array.from({ length: 12 }, (_, index) => {
      const dossier = JSON.parse(buildBlindSolveMessages({ ...draft, seed: `blind-order-${index}` })[1]!.content);
      return dossier.suspects[0].name;
    }));
    expect(firstPeople.size).toBeGreaterThan(1);
  });

  it("rejects a graph result that directly quotes original IDs despite a correct apparent answer", async () => {
    const artifact = generatedTutorial("case_blind_original_ids", "supporting-seed-0");
    const scripted = new ScriptedProvider([artifact]);
    const provider: StructuredModelProvider = {
      async invokeStructured(request) {
        if (request.schemaName !== "blind_case_solution") return scripted.invokeStructured(request);
        return {
          value: request.schema.parse(blindResult(artifact)),
          model: "mock-deepseek-pro",
          usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500 },
          rawResponse: { content: JSON.stringify(blindResult(artifact)) },
        };
      },
    };
    const result = await createCaseGenerationGraph(provider, { maxArtifactAttempts: 1 }).invoke(initialState(artifact.seed));
    expect(result.finalArtifact).toBeNull();
    expect(result.validationIssues).toContainEqual(expect.objectContaining({ code: "blind_solver_mismatch" }));
    expect(result.modelCalls.at(-1)!.response).toEqual(expect.objectContaining({ content: JSON.stringify(blindResult(artifact)) }));
  });

  it("requires the blind citation chain to eliminate every other suspect", () => {
    const draft = generatedTutorial("case_blind_exclusions", "supporting-seed-0");
    expect(blindSolveSupportsConclusion(draft, {
      ...blindResult(draft),
      evidenceIds: ["evidence_transfer_ledger", "evidence_brass_bookend", "evidence_housekeeper_testimony"],
    })).toBe(false);
  });

  it("does not accept inaccessible proof supplied by the blind detective", () => {
    const draft = structuredClone(generatedTutorial("case_blind_unreachable", "supporting-seed-0"));
    const alibi = draft.evidence.find((evidence) => evidence.id === "evidence_elevator_log")!;
    alibi.discovery.prerequisiteEvidenceIds = [alibi.id];
    expect(blindSolveSupportsConclusion(draft, blindResult(draft))).toBe(false);
  });

  it("does not count repeated citations as independent proof", () => {
    const draft = structuredClone(generatedTutorial("case_blind_duplicates", "supporting-seed-0"));
    const evidence = draft.evidence.find((item) => item.id === "evidence_transfer_ledger")!;
    evidence.supportsFactIds = [draft.solution.motiveFactId, draft.solution.methodFactId];
    evidence.excludesCharacterIds = draft.characters.filter((character) => character.roleTier === "suspect" && character.id !== draft.culpritId).map((character) => character.id);
    expect(blindSolveSupportsConclusion(draft, { ...blindResult(draft), evidenceIds: [evidence.id, evidence.id, evidence.id] })).toBe(false);
  });

  it("requires the blind detective to cite evidence for culprit, motive, and method", () => {
    const result = blindResult(tutorialCase);
    expect(blindSolveSupportsConclusion(tutorialCase, result)).toBe(true);
    expect(
      blindSolveSupportsConclusion(tutorialCase, {
        ...result,
        evidenceIds: [
          "evidence_broken_watch",
          "evidence_paint_curing_record",
          "evidence_elevator_log",
        ],
      }),
    ).toBe(false);
  });
});

class ScriptedProvider implements StructuredModelProvider {
  private readonly blindProtocol = new ScriptedBlindProtocol();
  private readonly evidenceProtocol = new ScriptedEvidenceReview();
  readonly requests: string[] = [];
  get stageRequests() { return this.requests.filter((name, index) => name !== "case_evidence_review" || this.requests[index - 1] !== name); }
  readonly requestDetails: Array<{
    schemaName: string;
    tier: string;
    reasoning: boolean | undefined;
    reasoningEffort: "low" | "high" | undefined;
    maxTokens: number | undefined;
    messages: StructuredModelRequest<Record<string, unknown>>["messages"];
  }> = [];

  constructor(
    private readonly responses: unknown[],
    private readonly openingReviews?: unknown[],
    private readonly evidenceReviews?: unknown[],
  ) {}

  async invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    this.requests.push(request.schemaName);
    this.requestDetails.push({
      schemaName: request.schemaName,
      tier: request.tier,
      reasoning: request.reasoning,
      reasoningEffort: request.reasoningEffort,
      maxTokens: request.maxTokens,
      messages: request.messages,
    });
    const scripted = request.schemaName === "case_opening_review"
      ? this.openingReviews === undefined ? { issues: [] } : this.openingReviews.shift()
      : request.schemaName === "case_evidence_review"
        ? this.evidenceProtocol.reply(request, () => this.evidenceReviews === undefined ? { issues: [] } : this.evidenceReviews.shift())
        : this.responses.shift();
    const response = this.blindProtocol.reply(request, scripted);
    if (response === undefined) throw new Error("No scripted response remains");
    if (response instanceof Error) throw response;
    return {
      value: request.schema.parse(response),
      model: "mock-deepseek-pro",
      usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500 },
      rawResponse: { schema: request.schemaName },
    };
  }
}

function modelStages(calls: Array<{ task: string }>) {
  return calls.map((call) => call.task).filter((task, index, tasks) => task !== "evidence_review" || tasks[index - 1] !== task);
}

function initialState(seed: string) {
  return {
    request: {
      seed,
      theme: "现代宅邸中的封闭空间案件",
      difficulty: "standard" as const,
    },
    attempt: 0,
    draft: null,
    validationIssues: [],
    blindSolve: null,
    finalArtifact: null,
    rejectionReason: null,
    formatRepairTargets: [],
    modelCalls: [],
  };
}

function structuredOutputValidationError(input: unknown) {
  const parsed = caseArtifactSchema.safeParse(input);
  if (parsed.success) {
    throw new Error("Expected malformed case artifact to fail schema validation");
  }
  return Object.assign(
    new Error(
      'DeepSeek JSON for structured output "case_artifact" failed schema validation',
    ),
    {
      name: "StructuredOutputValidationError",
      schemaName: "case_artifact",
      input,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        received: formatReceivedValue(readPath(input, issue.path)),
      })),
      model: "mock-deepseek-pro",
      usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500 },
      rawResponse: { content: JSON.stringify(input) },
    },
  );
}

function structuredRepairOutputValidationError(input: unknown) {
  const parsed = caseArtifactRepairPatchSchema.safeParse(input);
  if (parsed.success) {
    throw new Error("Expected malformed repair patch to fail schema validation");
  }
  return Object.assign(
    new Error(
      'DeepSeek JSON for structured output "case_artifact_repair_patch" failed schema validation',
    ),
    {
      name: "StructuredOutputValidationError",
      schemaName: "case_artifact_repair_patch",
      input,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        received: formatReceivedValue(readPath(input, issue.path)),
      })),
      model: "mock-deepseek-pro",
      usage: { inputTokens: 800, cachedInputTokens: 0, outputTokens: 120 },
      rawResponse: { content: JSON.stringify(input) },
    },
  );
}

function readPath(input: unknown, path: ReadonlyArray<PropertyKey>) {
  let current = input;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
      continue;
    }
    if (
      current &&
      typeof current === "object" &&
      typeof segment === "string"
    ) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function formatReceivedValue(value: unknown) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized;
}

function generatedTutorial(id: string, seed: string) {
  return makeGeneratedCaseArtifact(id, seed);
}

function blindResult(caseArtifact: CaseArtifact) {
  return {
    culpritId: caseArtifact.culpritId,
    evidenceIds: caseArtifact.evidence.map((evidence) => evidence.id),
    reasoning: "账目证明动机，门禁记录证明机会，黄铜书挡与茶水检验共同证明作案手法。",
  };
}
