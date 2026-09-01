import { describe, expect, it } from "vitest";

import type {
  StructuredModelProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "@/ai/model-provider";
import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { parseCaseArtifact } from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";

import {
  blindSolveSupportsConclusion,
  compileMinimumSolutionChain,
  createCaseGenerationGraph,
} from "./case-generation-graph";
import { buildBlindSolveMessages } from "./generation-prompts";

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
      { stage: "blind_solving", progress: 80 },
      { stage: "finalizing", progress: 92 },
    ]);
  });

  it("repairs deterministic validation failures before blind solving", async () => {
    const valid = generatedTutorial("case_generated_two", "seed-two");
    const invalid = structuredClone(valid);
    invalid.scenes = invalid.scenes.slice(0, 2);
    const provider = new ScriptedProvider([
      invalid,
      valid,
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
        "repaired_case_artifact",
        "blind_case_solution",
      ],
      finalId: "case_generated_two",
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
      artifact,
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
        "repaired_case_artifact",
        "blind_case_solution",
      ],
    });
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

  constructor(private readonly responses: unknown[]) {}

  async invokeStructured<T extends Record<string, unknown>>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    this.requests.push(request.schemaName);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No scripted response remains");
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
    modelCalls: [],
  };
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
