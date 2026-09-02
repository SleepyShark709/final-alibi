import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import {
  createModelCallAudit,
  createModelCallAuditFromStructuredOutputValidationError,
  modelCallAuditSchema,
} from "@/ai/model-audit";
import {
  isStructuredOutputValidationError,
  type StructuredModelProvider,
  type StructuredOutputValidationError,
} from "@/ai/model-provider";
import {
  applyCaseArtifactRepairPatch,
  caseArtifactSchema,
  caseArtifactRepairPatchSchema,
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

const fullArtifactMaxTokens = 12_000;
const repairPatchMaxTokens = 3_200;
const defaultMaxArtifactAttempts =
  1 + Math.floor(fullArtifactMaxTokens / repairPatchMaxTokens);

const formatRepairTargetSchema = z
  .object({
    characterId: z.string().min(1),
    factId: z.string().min(1),
    path: z.string().min(1),
    received: z.string().min(1),
  })
  .strict();

type FormatRepairTarget = z.infer<typeof formatRepairTargetSchema>;

const CaseGenerationState = new StateSchema({
  request: caseGenerationRequestSchema,
  attempt: z.number().int().nonnegative().default(0),
  draft: caseArtifactSchema.nullable().default(null),
  validationIssues: z.array(generationIssueSchema).default([]),
  formatRepairTargets: z.array(formatRepairTargetSchema).default([]),
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
  // 首稿后最多三次紧凑补丁；合计输出上限仍小于一次完整案件重写。
  const maxArtifactAttempts = options.maxArtifactAttempts ?? defaultMaxArtifactAttempts;
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
    try {
      const result = await provider.invokeStructured({
        tier: "pro",
        schema: caseArtifactSchema,
        schemaName: "case_artifact",
        messages,
        // 第一版只需要紧凑、可校验的案件账本；过大的输出上限会让 V4 长时间占用请求。
        temperature: 0.35,
        maxTokens: fullArtifactMaxTokens,
      });
      return {
        attempt: state.attempt + 1,
        draft: compileMinimumSolutionChain(result.value),
        modelCalls: [
          ...state.modelCalls,
          createModelCallAudit("case_draft", "pro", messages, result),
        ],
      };
    } catch (error) {
      if (!isStructuredOutputValidationError(error)) throw error;
      const recovery = recoverInvalidLieStrategyDraft(error);
      if (!recovery) throw error;

      console.warn("[generation-format-recovery] repairing invalid lie strategy", {
        schemaName: error.schemaName,
        targets: recovery.targets,
      });
      return {
        attempt: state.attempt + 1,
        draft: compileMinimumSolutionChain(recovery.draft),
        formatRepairTargets: recovery.targets,
        modelCalls: [
          ...state.modelCalls,
          createModelCallAuditFromStructuredOutputValidationError(
            "case_draft_format_recovery",
            "pro",
            messages,
            error,
          ),
        ],
      };
    }
  };

  const validateCase: typeof CaseGenerationState.Node = async (state) => {
    const completedRepairPasses = Math.min(
      Math.max(state.attempt - 1, 0),
      3,
    );
    await reportProgress(
      "validating",
      25 + completedRepairPasses * 20,
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
    return {
      validationIssues: [
        ...report.issues,
        ...requestIssues,
        ...state.formatRepairTargets.map(formatRepairIssue),
      ],
    };
  };

  const repairCase: typeof CaseGenerationState.Node = async (state) => {
    const completedRepairPasses = Math.min(
      Math.max(state.attempt - 1, 0),
      2,
    );
    await reportProgress(
      "repairing",
      35 + completedRepairPasses * 20,
    );
    if (!state.draft) throw new Error("Cannot repair an empty case draft");
    const messages = buildCaseRepairMessages({
      request: state.request,
      draft: state.draft,
      issues: state.validationIssues,
    });
    try {
      const result = await provider.invokeStructured({
        tier: "pro",
        schema: caseArtifactRepairPatchSchema,
        schemaName: "case_artifact_repair_patch",
        messages,
        temperature: 0.2,
        // 局部补丁只含问题字段：上限远小于完整案件，避免失败修复比重新生成更慢。
        maxTokens: repairPatchMaxTokens,
      });
      return {
        attempt: state.attempt + 1,
        draft: compileMinimumSolutionChain(
          applyCaseArtifactRepairPatch(state.draft, result.value),
        ),
        formatRepairTargets: unresolvedFormatRepairTargets(
          state.formatRepairTargets,
          result.value,
        ),
        blindSolve: null,
        modelCalls: [
          ...state.modelCalls,
          createModelCallAudit("case_repair", "pro", messages, result),
        ],
      };
    } catch (error) {
      if (!isRecoverableRepairFormatError(error)) throw error;
      console.warn("[generation-repair] invalid patch response; retrying", {
        attempt: state.attempt,
        maxArtifactAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      // 结构化输出偶发不合规时保留原案卷并消耗一次轻量修复预算；下轮会带着同一批
      // validator issues 再请求补丁，而不是把一次格式波动直接暴露给玩家。
      return { attempt: state.attempt + 1, draft: state.draft, blindSolve: null };
    }
  };

  const blindSolve: typeof CaseGenerationState.Node = async (state) => {
    await reportProgress("blind_solving", 92);
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
    await reportProgress("finalizing", 96);
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

function isRecoverableRepairFormatError(error: unknown) {
  if (error instanceof z.ZodError) return true;
  if (
    isStructuredOutputValidationError(error) &&
    error.schemaName === "case_artifact_repair_patch"
  ) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('structured output "case_artifact_repair_patch"') ||
    error.message.includes('DeepSeek JSON for structured output "case_artifact_repair_patch"')
  );
}

function recoverInvalidLieStrategyDraft(
  error: StructuredOutputValidationError,
): { draft: CaseArtifact; targets: FormatRepairTarget[] } | null {
  if (error.schemaName !== "case_artifact" || error.issues.length === 0) {
    return null;
  }

  let candidate: unknown;
  try {
    candidate = structuredClone(error.input);
  } catch {
    return null;
  }
  if (!isRecord(candidate) || !Array.isArray(candidate.characters)) return null;

  const targets: FormatRepairTarget[] = [];
  for (const issue of error.issues) {
    const target = replaceInvalidLieStrategy(candidate, issue.path, issue.received);
    if (!target) return null;
    targets.push(target);
  }

  const parsed = caseArtifactSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return {
    draft: parsed.data,
    targets: uniqueFormatRepairTargets(targets),
  };
}

function replaceInvalidLieStrategy(
  candidate: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
  received: string,
): FormatRepairTarget | null {
  const [charactersKey, characterIndex, lieRulesKey, ruleIndex, strategyKey] = path;
  if (
    charactersKey !== "characters" ||
    typeof characterIndex !== "number" ||
    lieRulesKey !== "lieRules" ||
    typeof ruleIndex !== "number" ||
    strategyKey !== "strategy"
  ) {
    return null;
  }
  const characters = candidate.characters;
  if (!Array.isArray(characters)) return null;
  const character = characters[characterIndex];
  if (!isRecord(character) || !Array.isArray(character.lieRules)) return null;
  const rule = character.lieRules[ruleIndex];
  if (!isRecord(rule)) return null;
  const characterId = readNonEmptyString(character.id);
  const factId = readNonEmptyString(rule.factId);
  if (!characterId || !factId) return null;

  // 只为通过 schema 创建可修复的临时账本；formatRepairTargets 会强制下一轮补丁
  // 显式覆盖这条规则，不能把这个占位值静默发布。
  rule.strategy = "deny";
  return {
    characterId,
    factId,
    path: path.join("."),
    received,
  };
}

function formatRepairIssue(target: FormatRepairTarget) {
  return {
    code: "invalid_lie_strategy",
    path: target.path,
    message:
      `model returned ${target.received} for ${target.path}; ` +
      `explicitly replace character "${target.characterId}" lie rule for fact "${target.factId}" with one allowed strategy`,
  };
}

function unresolvedFormatRepairTargets(
  targets: FormatRepairTarget[],
  patch: z.infer<typeof caseArtifactRepairPatchSchema>,
) {
  return targets.filter((target) => {
    const repairedCharacter = patch.characters?.find(
      (character) => character.id === target.characterId,
    );
    return !repairedCharacter?.lieRules?.some(
      (rule) => rule.factId === target.factId,
    );
  });
}

function uniqueFormatRepairTargets(targets: FormatRepairTarget[]) {
  return [
    ...new Map(targets.map((target) => [target.path, target])).values(),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
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
