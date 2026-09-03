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

import {
  blindSolveSupportsConclusion,
  compileMinimumSolutionChain,
  createCaseGenerationGraph,
} from "./case-generation-graph";
import {
  buildBlindSolveMessages,
  buildCaseDraftMessages,
  buildCaseRepairMessages,
} from "./generation-prompts";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";

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
      calls: provider.requests,
      rejection: result.rejectionReason,
    }).toEqual({
      finalId: "case_generated_one",
      valid: true,
      calls: ["case_artifact", "blind_case_solution"],
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
      calls: provider.requests,
      finalId: result.finalArtifact?.id,
    }).toEqual({
      attempts: 2,
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "blind_case_solution",
      ],
      finalId: "case_generated_two",
    });
  });

  it("repairs a seeded supporting-cast mismatch before publishing", async () => {
    const valid = generatedTutorial(
      "case_generated_seeded_cast",
      "supporting-seed-1",
    );
    const addedCharacter = valid.characters.find(
      (character) => character.roleTier === "referenced",
    );
    if (!addedCharacter) throw new Error("Generated fixture needs a referenced character");
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
      calls: provider.requests,
      supportingCharacterCount: result.finalArtifact?.characters.filter(
        (character) =>
          character.roleTier === "witness" || character.roleTier === "referenced",
      ).length,
    }).toEqual({
      attempts: 2,
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "blind_case_solution",
      ],
      supportingCharacterCount: 4,
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
      calls: provider.requests,
      supportingCharacterCount: result.finalArtifact?.characters.filter(
        (character) =>
          character.roleTier === "witness" || character.roleTier === "referenced",
      ).length,
    }).toEqual({
      attempts: 2,
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "blind_case_solution",
      ],
      supportingCharacterCount: 2,
    });
  });

  it("normalizes a suspect name leaked by an initial scene clue", async () => {
    const artifact = generatedTutorial(
      "case_generated_initial_text",
      "supporting-seed-0",
    );
    const invalid = structuredClone(artifact);
    const leakedEvidence = invalid.evidence.find(
      (evidence) => evidence.id === "evidence_teacup_residue",
    );
    if (!leakedEvidence) {
      throw new Error("Generated fixture tea evidence is missing");
    }
    leakedEvidence.description = "陈默的门禁卡和玻璃碎片都留在现场。";
    const provider = new ScriptedProvider([invalid, blindResult(invalid)]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState("supporting-seed-0"));

    expect({
      attempts: result.attempt,
      calls: provider.requests,
      initialDescription: result.finalArtifact?.evidence.find(
        (evidence) => evidence.id === leakedEvidence.id,
      )?.description,
    }).toMatchObject({
      attempts: 1,
      calls: ["case_artifact", "blind_case_solution"],
      initialDescription: expect.not.stringContaining("陈默"),
    });
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
      calls: provider.requests,
    }).toEqual({
      attempts: 2,
      finalId: "case_generated_lie_rule",
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
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
    expect(messages[0]?.content).toContain("用这 5 条必要证据独立演算一次");
    expect(messages[0]?.content).toContain(
      "现场 physical/forensic 证据的 excludesCharacterIds 必须为空",
    );
    expect(messages[0]?.content).toContain("本局固定生成 4 名配角");
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
    expect(payload.repairSnapshot).not.toHaveProperty("playerFacingText");
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
      calls: provider.requests,
    }).toEqual({
      attempts: 2,
      finalId: "case_generated_patch",
      valid: true,
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "blind_case_solution",
      ],
    });
    expect(provider.requestDetails[1]).toMatchObject({
      schemaName: "case_artifact_repair_patch",
      tier: "pro",
      maxTokens: 3_200,
    });
    expect(provider.requestDetails[1]?.messages[0]?.content).toContain("局部修复补丁");
    const repairContent = provider.requestDetails[1]?.messages[1]?.content ?? "{}";
    const repairPayload = JSON.parse(repairContent);
    expect(repairPayload).toHaveProperty("repairSnapshot");
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
      calls: provider.requests,
    }).toEqual({
      attempts: 3,
      finalId: "case_generated_patch_retry",
      calls: [
        "case_artifact",
        "case_artifact_repair_patch",
        "case_artifact_repair_patch",
        "blind_case_solution",
      ],
    });
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

    expect(result.modelCalls.map((call) => call.task)).toEqual([
      "case_draft",
      "case_repair_format_recovery",
      "case_repair_parse_recovery",
      "case_repair",
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

    expect(result.modelCalls.map((call) => call.task)).toEqual([
      "case_draft",
      "case_repair_apply_recovery",
      "case_repair",
      "blind_solve",
    ]);
  });

  it("normalizes recurring reference, knowledge, solution, and opening-scene drift", async () => {
    const seed = "seed-systemic-normalization";
    const invalid = structuredClone(
      generatedTutorial("case_generated_systemic_normalization", seed),
    );
    const suspect = invalid.characters.find(
      (character) => character.roleTier === "suspect",
    );
    const openingScene = invalid.scenes.find((scene) => scene.initiallyUnlocked);
    const leakedEvidence = invalid.evidence.find(
      (evidence) => evidence.id === "evidence_teacup_residue",
    );
    const secretFact = invalid.facts.find(
      (fact) => suspect && !suspect.knowledge.factIds.includes(fact.id),
    );
    if (!suspect || !openingScene || !leakedEvidence || !secretFact) {
      throw new Error("Generated fixture is missing normalization inputs");
    }

    suspect.knowledge.evidenceIds.push("evidence_missing_from_draft");
    suspect.secretFactIds = [...suspect.secretFactIds, secretFact.id];
    suspect.knowledge.factIds = suspect.knowledge.factIds.filter(
      (factId) => factId !== secretFact.id,
    );
    invalid.evidence.forEach((evidence) => {
      evidence.excludesCharacterIds = [];
      if (evidence.discovery.method === "interview") {
        evidence.discovery = {
          ...evidence.discovery,
          sceneId: openingScene.id,
          prerequisiteEvidenceIds: [],
        };
      }
    });
    invalid.solution.requiredEvidenceIds = [invalid.evidence[0]!.id];
    leakedEvidence.description = `${suspect.name}的门禁卡与玻璃碎片都留在现场。`;

    const provider = new ScriptedProvider([invalid, blindResult(invalid)]);
    const graph = createCaseGenerationGraph(provider);
    const result = await graph.invoke(initialState(seed));

    expect({
      attempts: result.attempt,
      calls: provider.requests,
      valid: result.finalArtifact
        ? validatePublishableCaseArtifact(result.finalArtifact).valid
        : false,
      knowledge: result.finalArtifact?.characters.find(
        (character) => character.id === suspect.id,
      )?.knowledge,
      openingDescription: result.finalArtifact?.evidence.find(
        (evidence) => evidence.id === leakedEvidence.id,
      )?.description,
    }).toMatchObject({
      attempts: 1,
      calls: ["case_artifact", "blind_case_solution"],
      valid: true,
      knowledge: {
        factIds: expect.arrayContaining([secretFact.id]),
        evidenceIds: expect.not.arrayContaining(["evidence_missing_from_draft"]),
      },
      openingDescription: expect.not.stringContaining(suspect.name),
    });

    const compiledAgain = compileMinimumSolutionChain(result.finalArtifact!);
    expect(compiledAgain).toEqual(result.finalArtifact);
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
    const unlockRule = draft.unlockRules[0]!;

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
    evidence.discovery.prerequisiteEvidenceIds.push("evidence_missing");
    unlockRule.allEvidenceIds.push("evidence_missing");
    unlockRule.anyEvidenceIds.push("evidence_missing");
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

  it("compiles the declared solution into a reachable minimum evidence chain before validation", () => {
    const incomplete = structuredClone(
      generatedTutorial("case_generated_compiled", "seed-compiled"),
    );
    incomplete.solution.requiredEvidenceIds = incomplete.evidence
      .slice(0, 5)
      .map((evidence) => evidence.id);
    incomplete.evidence = incomplete.evidence.map((evidence) => ({
      ...evidence,
      supportsFactIds: [],
      implicatesCharacterIds: [],
      excludesCharacterIds: [],
    }));

    const compiled = compileMinimumSolutionChain(incomplete);

    expect(validatePublishableCaseArtifact(compiled)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("prioritizes dialogue evidence when compiling the required solution chain", () => {
    const draft = structuredClone(
      generatedTutorial("case_generated_interviews", "seed-interviews"),
    );
    const livestream = draft.evidence.find(
      (evidence) => evidence.id === "evidence_livestream_record",
    );
    if (!livestream) throw new Error("Tutorial livestream evidence is missing");
    livestream.discovery = {
      method: "interview",
      characterId: "character_chen_mo",
      actionAliases: ["询问陈默案发时在哪里", "追问医学直播"],
      dialogueAliases: ["案发时你在哪里", "你当晚在哪", "直播能证明吗"],
      dialogueUtterance: "我当晚一直在诊所直播，可以提供回放记录。",
      prerequisiteEvidenceIds: [],
    };
    draft.solution.requiredEvidenceIds = draft.evidence
      .slice(0, 5)
      .map((evidence) => evidence.id);

    const compiled = compileMinimumSolutionChain(draft);
    const requiredDialogueEvidenceIds = compiled.solution.requiredEvidenceIds.filter(
      (evidenceId) =>
        compiled.evidence.find((evidence) => evidence.id === evidenceId)?.discovery
          .method === "interview",
    );

    expect(requiredDialogueEvidenceIds).toHaveLength(2);
  });

  it("keeps direct scene physical and forensic clues out of the decisive chain", () => {
    const draft = structuredClone(
      generatedTutorial("case_generated_indirect_chain", "seed-indirect-chain"),
    );

    const compiled = compileMinimumSolutionChain(draft);
    const directRequiredEvidenceIds = compiled.solution.requiredEvidenceIds.filter(
      (evidenceId) => {
        const evidence = compiled.evidence.find((item) => item.id === evidenceId);
        return (
          Boolean(evidence?.discovery.sceneId) &&
          (evidence?.kind === "physical" || evidence?.kind === "forensic")
        );
      },
    );

    expect(directRequiredEvidenceIds).toEqual([]);
  });

  it("normalizes suspect exclusions off direct scene physical and forensic clues", () => {
    const draft = structuredClone(
      generatedTutorial("case_generated_direct_normalized", "seed-direct-normalized"),
    );
    const directEvidence = draft.evidence.find(
      (evidence) => evidence.id === "evidence_brass_bookend",
    );
    if (!directEvidence) throw new Error("Tutorial direct forensic evidence is missing");
    directEvidence.excludesCharacterIds = draft.characters
      .filter(
        (character) =>
          character.roleTier === "suspect" &&
          character.id !== draft.culpritId,
      )
      .map((character) => character.id);

    const compiled = compileMinimumSolutionChain(draft);

    expect(
      compiled.evidence.find(
        (evidence) => evidence.id === "evidence_brass_bookend",
      )?.excludesCharacterIds,
    ).toEqual([]);
    expect(validatePublishableCaseArtifact(compiled)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("keeps initially discoverable scene clues out of the decisive chain", () => {
    const draft = structuredClone(
      generatedTutorial("case_generated_initial_pacing", "seed-initial-pacing"),
    );

    const compiled = compileMinimumSolutionChain(draft);
    const initiallyAvailableEvidenceIds = [
      "evidence_teacup_residue",
      "evidence_brass_bookend",
      "evidence_transfer_ledger",
      "evidence_torn_audit_memo",
    ];

    expect(
      compiled.solution.requiredEvidenceIds.filter((id) =>
        initiallyAvailableEvidenceIds.includes(id),
      ),
    ).toEqual([]);
    expect(
      compiled.evidence
        .filter((evidence) => initiallyAvailableEvidenceIds.includes(evidence.id))
        .map((evidence) => ({
          id: evidence.id,
          implicates: evidence.implicatesCharacterIds,
          excludes: evidence.excludesCharacterIds,
        })),
    ).toEqual(
      initiallyAvailableEvidenceIds.map((id) => ({
        id,
        implicates: [],
        excludes: [],
      })),
    );
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
      calls: provider.requests,
    }).toEqual({
      attempts: 2,
      finalId: "case_generated_three",
      calls: [
        "case_artifact",
        "blind_case_solution",
        "case_artifact_repair_patch",
        "blind_case_solution",
      ],
    });
    const blindRepairPayload = JSON.parse(
      provider.requestDetails[2]?.messages[1]?.content ?? "{}",
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
    expect(provider.requests).toEqual(["case_artifact"]);
  });

  it("keeps truth fields and private profiles out of the blind dossier", () => {
    const serialized = JSON.stringify(buildBlindSolveMessages(tutorialCase));

    expect({
      hasEvidence: serialized.includes("evidence_smart_lock_log"),
      hasCulpritField: serialized.includes("culpritId"),
      hasSolution: serialized.includes('"solution"'),
      hasPrivateProfile: serialized.includes("挪用资金即将败露"),
      hasClaimKind: serialized.includes('"kind":"lie"'),
    }).toEqual({
      hasEvidence: true,
      hasCulpritField: false,
      hasSolution: false,
      hasPrivateProfile: false,
      hasClaimKind: false,
    });
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
  readonly requests: string[] = [];
  readonly requestDetails: Array<{
    schemaName: string;
    tier: string;
    maxTokens: number | undefined;
    messages: StructuredModelRequest<Record<string, unknown>>["messages"];
  }> = [];

  constructor(private readonly responses: unknown[]) {}

  async invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    this.requests.push(request.schemaName);
    this.requestDetails.push({
      schemaName: request.schemaName,
      tier: request.tier,
      maxTokens: request.maxTokens,
      messages: request.messages,
    });
    const response = this.responses.shift();
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
