import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import { createModelCallAudit, modelCallAuditSchema } from "@/ai/model-audit";
import type { StructuredModelProvider } from "@/ai/model-provider";
import {
  caseArtifactSchema,
  parseCaseArtifact,
  type CaseArtifact,
} from "@/domain/case/case-artifact";
import { findReachableEvidenceIds } from "@/domain/case/evidence-reachability";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";

import {
  buildBlindSolveMessages,
  buildCaseDraftMessages,
  buildCaseRepairMessages,
} from "./generation-prompts";
import {
  blindSolveResultSchema,
  caseGenerationRequestSchema,
  generationIssueSchema,
  type BlindSolveResult,
} from "./generation-schema";

const CaseGenerationState = new StateSchema({
  request: caseGenerationRequestSchema,
  attempt: z.number().int().nonnegative().default(0),
  draft: caseArtifactSchema.nullable().default(null),
  validationIssues: z.array(generationIssueSchema).default([]),
  blindSolve: blindSolveResultSchema.nullable().default(null),
  finalArtifact: caseArtifactSchema.nullable().default(null),
  rejectionReason: z.string().nullable().default(null),
  modelCalls: z.array(modelCallAuditSchema).default([]),
});

export type CaseGenerationStage =
  | "drafting"
  | "validating"
  | "repairing"
  | "blind_solving"
  | "finalizing";

export interface CaseGenerationProgress {
  stage: CaseGenerationStage;
  progress: number;
}

export type CaseGenerationProgressListener = (
  progress: CaseGenerationProgress,
) => void | Promise<void>;

export interface CaseGenerationGraphOptions {
  checkpointer?: BaseCheckpointSaver;
  maxArtifactAttempts?: number;
  onProgress?: CaseGenerationProgressListener;
}

export function createCaseGenerationGraph(
  provider: StructuredModelProvider,
  options: CaseGenerationGraphOptions = {},
) {
  // 发布前有限循环：草稿 -> 结构/可解性校验 -> 修复 -> 无答案盲解；耗尽次数即拒绝而非放行。
  const maxArtifactAttempts = options.maxArtifactAttempts ?? 3;
  const reportProgress = async (
    stage: CaseGenerationStage,
    progress: number,
  ) => {
    // 进度持久化/展示失败不应中断真相账本的生成；最终 job status 才是业务终态。
    try {
      await options.onProgress?.({ stage, progress });
    } catch {
      // no-op: the worker heartbeat and terminal result remain independently durable.
    }
  };

  const draftCase: typeof CaseGenerationState.Node = async (state) => {
    await reportProgress("drafting", 10 + Math.min(state.attempt, 2) * 20);
    const messages = buildCaseDraftMessages(state.request);
    const result = await provider.invokeStructured({
      tier: "pro",
      schema: caseArtifactSchema,
      schemaName: "case_artifact",
      messages,
      // 第一版只需要紧凑、可校验的案件账本；过大的输出上限会让 V4 长时间占用请求。
      temperature: 0.35,
      maxTokens: 12_000,
    });
    return {
      attempt: state.attempt + 1,
      draft: compileMinimumSolutionChain(result.value),
      modelCalls: [
        ...state.modelCalls,
        createModelCallAudit("case_draft", "pro", messages, result),
      ],
    };
  };

  const validateCase: typeof CaseGenerationState.Node = async (state) => {
    await reportProgress(
      "validating",
      25 + Math.min(Math.max(state.attempt - 1, 0), 2) * 20,
    );
    if (!state.draft) {
      return {
        validationIssues: [
          { code: "missing_draft", path: "draft", message: "draft is empty" },
        ],
      };
    }
    const report = validatePublishableCaseArtifact(state.draft);
    const requestIssues = [];
    if (state.draft.seed !== state.request.seed) {
      requestIssues.push({
        code: "seed_mismatch",
        path: "seed",
        message: `expected seed "${state.request.seed}"`,
      });
    }
    return { validationIssues: [...report.issues, ...requestIssues] };
  };

  const repairCase: typeof CaseGenerationState.Node = async (state) => {
    await reportProgress(
      "repairing",
      38 + Math.min(Math.max(state.attempt - 1, 0), 2) * 18,
    );
    if (!state.draft) throw new Error("Cannot repair an empty case draft");
    const messages = buildCaseRepairMessages({
      request: state.request,
      draft: state.draft,
      issues: state.validationIssues,
    });
    const result = await provider.invokeStructured({
      tier: "pro",
      schema: caseArtifactSchema,
      schemaName: "repaired_case_artifact",
      messages,
      temperature: 0.2,
      maxTokens: 12_000,
    });
    return {
      attempt: state.attempt + 1,
      draft: compileMinimumSolutionChain(result.value),
      blindSolve: null,
      modelCalls: [
        ...state.modelCalls,
        createModelCallAudit("case_repair", "pro", messages, result),
      ],
    };
  };

  const blindSolve: typeof CaseGenerationState.Node = async (state) => {
    await reportProgress("blind_solving", 80);
    if (!state.draft) throw new Error("Cannot blind-solve an empty case draft");
    const messages = buildBlindSolveMessages(state.draft);
    const result = await provider.invokeStructured({
      tier: "pro",
      schema: blindSolveResultSchema,
      schemaName: "blind_case_solution",
      messages,
      temperature: 0,
      maxTokens: 2_000,
    });
    return {
      blindSolve: result.value,
      modelCalls: [
        ...state.modelCalls,
        createModelCallAudit("blind_solve", "pro", messages, result),
      ],
    };
  };

  const recordBlindFailure: typeof CaseGenerationState.Node = (state) => ({
    validationIssues: [
      {
        code: "blind_solver_mismatch",
        path: "evidence",
        message: `blind solver selected "${state.blindSolve?.culpritId ?? "none"}" instead of the truth-ledger culprit`,
      },
    ],
  });

  const finalize: typeof CaseGenerationState.Node = async (state) => {
    await reportProgress("finalizing", 92);
    if (!state.draft) throw new Error("Cannot finalize an empty case draft");
    // 再次 parse/freeze，使后续持久化拿到的就是不可变真相账本。
    return { finalArtifact: parseCaseArtifact(state.draft), rejectionReason: null };
  };

  const reject: typeof CaseGenerationState.Node = (state) => ({
    finalArtifact: null,
    rejectionReason: state.validationIssues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; "),
  });

  return new StateGraph(CaseGenerationState)
    .addNode("draft_case", draftCase)
    .addNode("validate_case", validateCase)
    .addNode("repair_case", repairCase)
    .addNode("blind_solve_case", blindSolve)
    .addNode("record_blind_failure", recordBlindFailure)
    .addNode("finalize_case", finalize)
    .addNode("reject_case", reject)
    .addEdge(START, "draft_case")
    .addEdge("draft_case", "validate_case")
    .addConditionalEdges(
      "validate_case",
      (state) => {
        if (state.validationIssues.length === 0) return "blind";
        return state.attempt < maxArtifactAttempts ? "repair" : "reject";
      },
      {
        blind: "blind_solve_case",
        repair: "repair_case",
        reject: "reject_case",
      },
    )
    .addEdge("repair_case", "validate_case")
    .addConditionalEdges(
      "blind_solve_case",
      (state) =>
        state.draft &&
        state.blindSolve &&
        blindSolveSupportsConclusion(state.draft, state.blindSolve)
          ? "finalize"
          : "mismatch",
      {
        finalize: "finalize_case",
        mismatch: "record_blind_failure",
      },
    )
    .addConditionalEdges(
      "record_blind_failure",
      (state) => (state.attempt < maxArtifactAttempts ? "repair" : "reject"),
      { repair: "repair_case", reject: "reject_case" },
    )
    .addEdge("finalize_case", END)
    .addEdge("reject_case", END)
    .compile({ checkpointer: options.checkpointer });
}

export function blindSolveSupportsConclusion(
  caseArtifact: CaseArtifact,
  blindSolve: BlindSolveResult,
) {
  if (blindSolve.culpritId !== caseArtifact.culpritId) return false;
  const evidenceById = new Map(
    caseArtifact.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const citedEvidence = blindSolve.evidenceIds.map((id) => evidenceById.get(id));
  if (citedEvidence.length < 3 || citedEvidence.some((evidence) => !evidence)) {
    return false;
  }
  const supportedFactIds = new Set(
    citedEvidence.flatMap((evidence) => evidence?.supportsFactIds ?? []),
  );
  return (
    citedEvidence.some((evidence) =>
      evidence?.implicatesCharacterIds.includes(caseArtifact.culpritId),
    ) &&
    supportedFactIds.has(caseArtifact.solution.motiveFactId) &&
    supportedFactIds.has(caseArtifact.solution.methodFactId)
  );
}

/**
 * 将模型已声明的 solution 元数据编译为解题器可检查的最小证据链。
 *
 * 这一步不选择或替换真凶、动机、手法，也不改写玩家可见文案；它只补齐模型经常
 * 遗漏的 supports/implicates/excludes 关系。随后仍必须通过盲解，避免“字段正确、
 * 故事不通”的案件被发布。
 */
export function compileMinimumSolutionChain(
  caseArtifact: CaseArtifact,
): CaseArtifact {
  const suspectIds = caseArtifact.characters
    .filter((character) => character.roleTier === "suspect")
    .map((character) => character.id);
  const culpritId = caseArtifact.culpritId;
  const otherSuspectIds = suspectIds.filter((id) => id !== culpritId);
  const evidenceById = new Map(
    caseArtifact.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const reachableEvidenceIds = findReachableEvidenceIds(caseArtifact);
  const candidateEvidenceIds = uniqueIds([
    ...caseArtifact.solution.requiredEvidenceIds,
    ...reachableEvidenceIds,
  ]).filter((id) => evidenceById.has(id) && reachableEvidenceIds.has(id));

  if (
    suspectIds.length !== 4 ||
    otherSuspectIds.length !== 3 ||
    candidateEvidenceIds.length < 5 ||
    !caseArtifact.facts.some(
      (fact) => fact.id === caseArtifact.solution.motiveFactId,
    ) ||
    !caseArtifact.facts.some(
      (fact) => fact.id === caseArtifact.solution.methodFactId,
    )
  ) {
    return caseArtifact;
  }

  const directSceneEvidenceIds = new Set(
    candidateEvidenceIds.filter((id) => {
      const evidence = evidenceById.get(id);
      return (
        Boolean(evidence?.discovery.sceneId) &&
        (evidence?.kind === "physical" || evidence?.kind === "forensic")
      );
    }),
  );
  const nonDirectEvidenceIds = candidateEvidenceIds.filter(
    (id) => !directSceneEvidenceIds.has(id),
  );
  // 现场法证可以支撑推理，但不能被编译器自动拼成三条以内的直指结论。
  // 决定性链条必须跨过人物对话和非现场直证，保留玩家调查与交叉验证的空间。
  const interviewEvidenceIds = nonDirectEvidenceIds.filter((id) => {
    const evidence = evidenceById.get(id);
    return (
      evidence?.discovery.method === "interview" &&
      Boolean(evidence.discovery.characterId)
    );
  });
  // Keep two witness conversations in the decisive chain. If the draft does not
  // contain them, publication validation will send it through the repair pass.
  if (interviewEvidenceIds.length < 2) {
    return caseArtifact;
  }
  const nonInterviewEvidenceIds = nonDirectEvidenceIds.filter(
    (id) => !interviewEvidenceIds.includes(id),
  );
  if (nonInterviewEvidenceIds.length < 3) {
    return caseArtifact;
  }
  const requiredEvidenceIds = [
    ...interviewEvidenceIds.slice(0, 2),
    ...nonInterviewEvidenceIds.slice(0, 3),
  ];
  const chainIndexByEvidenceId = new Map(
    requiredEvidenceIds.map((id, index) => [id, index]),
  );

  return {
    ...caseArtifact,
    evidence: caseArtifact.evidence.map((evidence) => {
      const chainIndex = chainIndexByEvidenceId.get(evidence.id);
      const excludesCharacterIds = evidence.excludesCharacterIds.filter(
        (id) => id !== culpritId,
      );
      if (chainIndex === undefined) {
        return { ...evidence, excludesCharacterIds };
      }

      const supportsFactIds =
        chainIndex === 0
          ? uniqueIds([
              ...evidence.supportsFactIds,
              caseArtifact.solution.motiveFactId,
            ])
          : chainIndex === 1
            ? uniqueIds([
                ...evidence.supportsFactIds,
                caseArtifact.solution.methodFactId,
              ])
            : evidence.supportsFactIds;
      const implicatesCharacterIds =
        chainIndex <= 1
          ? uniqueIds([...evidence.implicatesCharacterIds, culpritId])
          : evidence.implicatesCharacterIds;
      const excludedSuspectId = chainIndex >= 2
        ? otherSuspectIds[chainIndex - 2]
        : undefined;

      return {
        ...evidence,
        critical: true,
        supportsFactIds,
        implicatesCharacterIds,
        excludesCharacterIds: excludedSuspectId
          ? uniqueIds([...excludesCharacterIds, excludedSuspectId])
          : excludesCharacterIds,
        discovery: {
          ...evidence.discovery,
          // 必要证据必须可达，避免模型把它们全部藏在相互依赖的解锁链后。
          prerequisiteEvidenceIds: [],
        },
      };
    }),
    solution: {
      ...caseArtifact.solution,
      requiredEvidenceIds,
    },
  };
}

function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}
