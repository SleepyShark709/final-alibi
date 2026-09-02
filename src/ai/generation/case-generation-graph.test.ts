import { describe, expect, it } from "vitest";

import type {
  StructuredModelProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import {
  caseArtifactSchema,
  parseCaseArtifact,
} from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";

import {
  blindSolveSupportsConclusion,
  compileMinimumSolutionChain,
  createCaseGenerationGraph,
} from "./case-generation-graph";
import { buildBlindSolveMessages, buildCaseDraftMessages } from "./generation-prompts";

describe("case generation graph", () => {
  it("publishes a semantically valid case only after an independent blind solve", async () => {
    const artifact = generatedTutorial("case_generated_one", "seed-one");
    const provider = new ScriptedProvider([
      artifact,
      blindResult(artifact.culpritId),
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
      blindResult(artifact.culpritId),
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
      blindResult(valid.culpritId),
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
      blindResult(valid.culpritId),
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
      seed: "seed-preflight",
      theme: "现代宅邸中的封闭空间案件",
      difficulty: "standard",
    });

    expect(messages[0]?.content).toContain("输出前必须先完成以下结构预检");
    expect(messages[0]?.content).toContain("所有引用都必须来自已列出的实体 ID");
    expect(messages[0]?.content).toContain("用这 5 条必要证据独立演算一次");
  });

  it("repairs a localized dangling reference with a compact patch instead of another full case", async () => {
    const valid = generatedTutorial("case_generated_patch", "seed-patch");
    const invalid = structuredClone(valid);
    invalid.scenes[0]!.objects[0]!.evidenceIds = ["evidence_missing"];
    const provider = new ScriptedProvider([
      invalid,
      {
        sceneObjects: [
          { sceneId: valid.scenes[0]!.id, ...valid.scenes[0]!.objects[0] },
        ],
      },
      blindResult(valid.culpritId),
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
    invalid.scenes[0]!.objects[0]!.evidenceIds = ["evidence_missing"];
    const provider = new ScriptedProvider([
      invalid,
      { unsupportedPatchField: true },
      {
        sceneObjects: [
          { sceneId: valid.scenes[0]!.id, ...valid.scenes[0]!.objects[0] },
        ],
      },
      blindResult(valid.culpritId),
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

  it("repairs a logically opaque case when the blind detective chooses differently", async () => {
    const artifact = generatedTutorial("case_generated_three", "seed-three");
    const provider = new ScriptedProvider([
      artifact,
      blindResult("character_shen_lan"),
      {
        evidence: [
          {
            id: artifact.evidence[0]!.id,
            description: `${artifact.evidence[0]!.description} 这条记录与其他证据相互印证。`,
          },
        ],
      },
      blindResult(artifact.culpritId),
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
    const result = blindResult(tutorialCase.culpritId);
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
  return parseCaseArtifact({ ...tutorialCase, id, seed });
}

function blindResult(culpritId: string) {
  return {
    culpritId,
    evidenceIds: [
      "evidence_transfer_ledger",
      "evidence_smart_lock_log",
      "evidence_brass_bookend",
    ],
    reasoning: "账目证明动机，门禁记录证明机会，黄铜书挡与茶水检验共同证明作案手法。",
  };
}
