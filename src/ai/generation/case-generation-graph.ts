import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import {
  createModelCallAudit,
  createModelCallAuditFromStructuredOutputParseError,
  createModelCallAuditFromStructuredOutputValidationError,
  modelCallAuditSchema,
} from "@/ai/model-audit";
import {
  isStructuredOutputParseError,
  isStructuredOutputValidationError,
  type StructuredModelResult,
  type StructuredModelProvider,
  type StructuredOutputValidationError,
} from "@/ai/model-provider";
import {
  applyCaseArtifactRepairPatch,
  caseArtifactSchema,
  caseArtifactRepairPatchSchema,
  parseCaseArtifact,
  type CaseArtifact,
  type CaseArtifactRepairPatch,
} from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact, type CaseValidationIssue } from "@/domain/case/case-validator";
import { findReachableEvidenceIds } from "@/domain/case/evidence-reachability";
import { solveCaseWithEvidenceIds } from "@/domain/case/case-solver";

import {
  buildBlindSolveInput,
  buildCaseDraftMessages,
  buildCaseRepairMessages,
  buildOpeningReviewMessages,
} from "./generation-prompts";
import {
  deriveGenerationPlan,
  validateGeneratedCharacterPlan,
  validateInitialScenePacing,
} from "./generation-plan";
import {
  blindSolveResultSchema,
  caseGenerationRequestSchema,
  generationIssueSchema,
  openingReviewSchema,
  publicWindowReviewSchema,
  type BlindSolveResult,
} from "./generation-schema";
import { buildEvidenceReviewPlan } from "./evidence-review";
import { EvidenceReviewBatchError, reviewEvidenceInBatches } from "./evidence-review-batches";
import { buildCaseRepairContract, findAcquisitionRepairRegressions } from "./case-repair-contract";

const fullArtifactMaxTokens = 12_000;
const repairPatchMaxTokens = 3_200;
const reasoningTokenAllowance = 6_000;
const defaultMaxArtifactAttempts = 6;
class AcquisitionRepairRegressionError extends Error {}

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
  repairFormatIssues: z.array(generationIssueSchema).default([]),
  reviewFeedback: z.array(generationIssueSchema).default([]),
  blindSolve: blindSolveResultSchema.nullable().default(null),
  publicWindowReview: publicWindowReviewSchema.nullable().default(null),
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
  // 首稿后最多五次紧凑补丁，为结构通过后才发现的语义问题保留重修余量。
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
        // 首稿直接输出紧凑账本，推理预算留给独立审查，避免在写稿阶段长时间等待。
        reasoning: false,
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
    const generationPlan = deriveGenerationPlan(state.request.seed);
    const validationIssues = mergeRepairIssues([
      ...report.issues,
      ...requestIssues,
      ...validateGeneratedCharacterPlan(state.draft, generationPlan),
      ...validateInitialScenePacing(state.draft),
      ...state.formatRepairTargets.map(formatRepairIssue),
      ...state.repairFormatIssues,
    ], state.repairFormatIssues.length > 0
      ? state.validationIssues.filter((issue) => issue.code !== "invalid_repair_patch")
      : []);
    return {
      validationIssues,
      reviewFeedback: mergeRepairIssues(state.reviewFeedback, validationIssues),
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
    const repairContract = buildCaseRepairContract(state.draft, state.validationIssues, state.publicWindowReview);
    const acquisitionRepair = repairContract.scope?.mode === "acquisition";
    const messages = buildCaseRepairMessages({
      request: state.request,
      draft: state.draft,
      issues: state.validationIssues,
      repairScope: repairContract.scope,
      publicWindowReview: state.publicWindowReview,
    });
    let completedRepairResult: StructuredModelResult<CaseArtifactRepairPatch> | null =
      null;
    try {
      const result = await provider.invokeStructured({
        tier: "pro",
        schema: repairContract.schema,
        schemaName: "case_artifact_repair_patch",
        messages,
        reasoning: acquisitionRepair,
        ...(acquisitionRepair ? { reasoningEffort: "low" as const } : {}),
        temperature: 0.2,
        maxTokens: repairPatchMaxTokens + (acquisitionRepair ? reasoningTokenAllowance : 0),
      });
      completedRepairResult = result;
      const candidate = compileMinimumSolutionChain(applyCaseArtifactRepairPatch(state.draft, result.value));
      const regressions = acquisitionRepair ? findAcquisitionRepairRegressions(state.draft, candidate, state.request.seed) : [];
      if (regressions.length > 0) throw new AcquisitionRepairRegressionError(
        `候选补丁新增、未提交；原稿保持：${regressions.map((issue) => `${issue.code} ${issue.path}: ${issue.message}`).join("; ")}`,
      );
      return {
        attempt: state.attempt + 1,
        draft: candidate,
        formatRepairTargets: unresolvedFormatRepairTargets(
          state.formatRepairTargets,
          result.value,
        ),
        blindSolve: null,
        publicWindowReview: null,
        repairFormatIssues: [],
        modelCalls: [
          ...state.modelCalls,
          createModelCallAudit("case_repair", "pro", messages, result),
        ],
      };
    } catch (error) {
      if (!isRecoverableRepairFormatError(error)) throw error;
      const formatFailureAudit = isStructuredOutputValidationError(error)
        ? createModelCallAuditFromStructuredOutputValidationError(
            "case_repair_format_recovery",
            "pro",
            messages,
            error,
          )
        : isStructuredOutputParseError(error)
          ? createModelCallAuditFromStructuredOutputParseError(
              "case_repair_parse_recovery",
              "pro",
              messages,
              error,
            )
          : completedRepairResult
            ? createModelCallAudit(
                "case_repair_apply_recovery",
                "pro",
                messages,
                completedRepairResult,
              )
            : null;
      console.warn("[generation-repair] invalid patch response; retrying", {
        attempt: state.attempt,
        maxArtifactAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      // 保留原案卷，并把具体格式问题带进下轮，避免重复提交同一份无效补丁。
      return {
        attempt: state.attempt + 1,
        draft: state.draft,
        blindSolve: null,
        repairFormatIssues: [{
          code: "invalid_repair_patch",
          path: "repairPatch",
          message: error instanceof AcquisitionRepairRegressionError ? error.message : isStructuredOutputValidationError(error)
            ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
            : (error instanceof Error ? error.message : String(error)).slice(0, 700),
        }],
        modelCalls: formatFailureAudit
          ? [...state.modelCalls, formatFailureAudit]
          : state.modelCalls,
      };
    }
  };

  const blindSolve: typeof CaseGenerationState.Node = async (state) => {
    await reportProgress("blind_solving", 92);
    if (!state.draft) throw new Error("Cannot blind-solve an empty case draft");
    const reviewMessages = buildOpeningReviewMessages(state.draft);
    const review = await provider.invokeStructured({
      tier: "pro",
      schema: openingReviewSchema,
      schemaName: "case_opening_review",
      messages: reviewMessages,
      reasoning: true,
      reasoningEffort: "low",
      temperature: 0,
      maxTokens: 1_200 + reasoningTokenAllowance,
    });
    const reviewAudit = createModelCallAudit("opening_review", "pro", reviewMessages, review);
    const disclosureIssues = review.value.issues.filter((issue) => issue.kind !== "ordinary_lead");
    if (disclosureIssues.length > 0) {
      const issues = disclosureIssues.map((issue) => ({
        code: "initial_information_shortcut",
        path: issue.path,
        message: `${issue.quote}: ${issue.reason}`,
      }));
      return {
        blindSolve: null,
        validationIssues: issues,
        reviewFeedback: mergeRepairIssues(state.reviewFeedback, issues),
        modelCalls: [...state.modelCalls, reviewAudit],
      };
    }
    const evidenceReviewPlan = buildEvidenceReviewPlan(state.draft);
    const evidenceReview = await reviewEvidenceInBatches(provider, state.draft, evidenceReviewPlan).catch((error: unknown) => {
      if (error instanceof EvidenceReviewBatchError) {
        error.modelCalls.unshift(...state.modelCalls, reviewAudit);
      }
      throw error;
    });
    const issues = evidenceReview.issues;
    if (issues.length > 0) {
      return {
        blindSolve: null,
        publicWindowReview: evidenceReview.publicWindowReview,
        validationIssues: issues,
        reviewFeedback: mergeRepairIssues(state.reviewFeedback, issues),
        modelCalls: [...state.modelCalls, reviewAudit, ...evidenceReview.modelCalls],
      };
    }
    const blindInput = buildBlindSolveInput(state.draft);
    const messages = blindInput.messages;
    const result = await provider.invokeStructured({
      tier: "pro",
      schema: blindSolveResultSchema,
      schemaName: "blind_case_solution",
      messages,
      reasoning: true,
      reasoningEffort: "low",
      temperature: 0,
      maxTokens: 2_000 + reasoningTokenAllowance,
    });
    const restored = blindInput.restoreResult(result.value);
    const modelCalls = [
      ...state.modelCalls,
      reviewAudit,
      ...evidenceReview.modelCalls,
      createModelCallAudit("blind_solve", "pro", messages, result),
    ];
    if (!restored) {
      const issues = [{
        code: "blind_solver_mismatch",
        path: "evidence",
        message: "盲解返回了未提供的人物或证据编号，不能建立有效的引用链。",
      }];
      return { blindSolve: null, publicWindowReview: evidenceReview.publicWindowReview, validationIssues: issues, reviewFeedback: mergeRepairIssues(state.reviewFeedback, issues), modelCalls };
    }
    return {
      blindSolve: restored,
      publicWindowReview: evidenceReview.publicWindowReview,
      reviewFeedback: blindSolveSupportsConclusion(state.draft, restored) ? [] : state.reviewFeedback,
      modelCalls,
    };
  };

  const recordBlindFailure: typeof CaseGenerationState.Node = (state) => ({
    validationIssues: [
      {
        code: "blind_solver_mismatch",
        path: "evidence",
        message: `blind conclusion or its cited evidence does not establish the complete solution; selected "${state.blindSolve?.culpritId ?? "none"}"; cited ${state.blindSolve?.evidenceIds.join(", ") ?? "none"}; reasoning: ${state.blindSolve?.reasoning ?? "none"}`,
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
      (state) => {
        if (state.validationIssues.length > 0) {
          return state.attempt < maxArtifactAttempts ? "repair" : "reject";
        }
        return state.draft &&
        state.blindSolve &&
        blindSolveSupportsConclusion(state.draft, state.blindSolve)
          ? "finalize"
          : "mismatch";
      },
      {
        finalize: "finalize_case",
        mismatch: "record_blind_failure",
        repair: "repair_case",
        reject: "reject_case",
      },
    )
    .addConditionalEdges(
      "record_blind_failure",
      (state) => (state.attempt < maxArtifactAttempts ? "repair" : "reject"),
      { repair: "repair_case", reject: "reject_case" },
    )
    .addEdge("finalize_case", END)
    .addEdge("reject_case", END)
    .compile({ checkpointer: options.checkpointer })
    // 每版最多经过生成/补丁、校验、盲解与失败记录四个节点，另留终态步数。
    .withConfig({ recursionLimit: maxArtifactAttempts * 4 + 2 });
}

function mergeRepairIssues(previous: CaseValidationIssue[], current: CaseValidationIssue[]) {
  return [...new Map(
    [...previous, ...current].map((issue) => [`${issue.code}:${issue.path}`, issue]),
  ).values()];
}

export function blindSolveSupportsConclusion(
  caseArtifact: CaseArtifact,
  blindSolve: BlindSolveResult,
) {
  if (blindSolve.culpritId !== caseArtifact.culpritId) return false;
  const evidenceById = new Map(
    caseArtifact.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const citedIds = new Set(blindSolve.evidenceIds);
  const reachableIds = findReachableEvidenceIds(caseArtifact);
  if ([...citedIds].some((id) => !reachableIds.has(id))) return false;
  const citedEvidence = [...citedIds].map((id) => evidenceById.get(id));
  if (citedEvidence.length < 3 || citedEvidence.some((evidence) => !evidence)) {
    return false;
  }
  const supportedFactIds = new Set(
    citedEvidence.flatMap((evidence) => evidence?.supportsFactIds ?? []),
  );
  const citedSolution = solveCaseWithEvidenceIds(caseArtifact, citedIds);
  return (
    citedSolution.status === "unique" &&
    citedSolution.culpritId === caseArtifact.culpritId &&
    citedEvidence.some((evidence) =>
      evidence?.implicatesCharacterIds.includes(caseArtifact.culpritId),
    ) &&
    supportedFactIds.has(caseArtifact.solution.motiveFactId) &&
    supportedFactIds.has(caseArtifact.solution.methodFactId)
  );
}

function isRecoverableRepairFormatError(error: unknown) {
  if (error instanceof AcquisitionRepairRegressionError) return true;
  if (error instanceof z.ZodError) return true;
  if (
    isStructuredOutputParseError(error) &&
    error.schemaName === "case_artifact_repair_patch"
  ) {
    return true;
  }
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

/** 保留模型设计的证据链；缺失的证明关系和错误前置条件交由校验与修复。 */
export function compileMinimumSolutionChain(
  caseArtifact: CaseArtifact,
): CaseArtifact {
  return normalizeRepairableReferenceDrift(normalizeClaimIdCollisions(caseArtifact));
}

/** fact 与 claim 常被模型用同一 ID 命名；按引用类型改名，不改变陈述或证明关系。 */
function normalizeClaimIdCollisions(caseArtifact: CaseArtifact): CaseArtifact {
  const otherIds = new Set([
    ...caseArtifact.characters, ...caseArtifact.scenes,
    ...caseArtifact.scenes.flatMap((scene) => scene.objects),
    ...caseArtifact.facts, ...caseArtifact.timeline, ...caseArtifact.evidence,
    ...caseArtifact.unlockRules, ...caseArtifact.hintChains,
  ].map((item) => item.id));
  const reservedIds = new Set([...otherIds, ...caseArtifact.claims.map((claim) => claim.id)]);
  const replacements = new Map<string, string>();
  for (const claim of caseArtifact.claims) {
    if (!otherIds.has(claim.id) || replacements.has(claim.id)) continue;
    let id = `claim_${claim.id}`;
    while (reservedIds.has(id)) id = `claim_${id}`;
    replacements.set(claim.id, id);
    reservedIds.add(id);
  }
  if (replacements.size === 0) return caseArtifact;
  const claimId = (id: string) => replacements.get(id) ?? id;
  return {
    ...caseArtifact,
    claims: caseArtifact.claims.map((claim) => ({ ...claim, id: claimId(claim.id) })),
    characters: caseArtifact.characters.map((character) => ({
      ...character,
      knowledge: { ...character.knowledge, claimIds: character.knowledge.claimIds.map(claimId) },
    })),
    evidence: caseArtifact.evidence.map((evidence) => ({
      ...evidence, contradictsClaimIds: evidence.contradictsClaimIds.map(claimId),
    })),
  };
}

/**
 * 关闭生成模型最常见的列表引用漂移。
 *
 * 未声明实体的列表引用不可能承载有效语义，删除它们不会丢失可用信息；秘密、
 * 谎言规则及真凶自身的动机/手法则已经声明了角色必须知道的事实，因此补入
 * knowledge 是确定性的。标量拓扑（例如未知 culpritId）没有安全默认值，继续由
 * validator 和 repair 模型处理。
 */
function normalizeRepairableReferenceDrift(
  caseArtifact: CaseArtifact,
): CaseArtifact {
  const characterIds = new Set(
    caseArtifact.characters.map((character) => character.id),
  );
  const factIds = new Set(caseArtifact.facts.map((fact) => fact.id));
  const claimIds = new Set(caseArtifact.claims.map((claim) => claim.id));
  const evidenceIds = new Set(caseArtifact.evidence.map((evidence) => evidence.id));
  const timelineEventIds = new Set(caseArtifact.timeline.map((event) => event.id));
  const evidenceIdsByObjectId = new Map<string, string[]>();
  for (const evidence of caseArtifact.evidence) {
    const objectId = evidence.discovery.objectId;
    if (!objectId) continue;
    const objectEvidenceIds = evidenceIdsByObjectId.get(objectId) ?? [];
    objectEvidenceIds.push(evidence.id);
    evidenceIdsByObjectId.set(objectId, objectEvidenceIds);
  }
  const knownIds = <T extends string>(ids: readonly T[], validIds: ReadonlySet<string>) =>
    uniqueIds(ids.filter((id) => validIds.has(id)));

  return {
    ...caseArtifact,
    characters: caseArtifact.characters.map((character) => {
      const secretFactIds = knownIds(character.secretFactIds, factIds);
      const lieRules = character.lieRules.filter((rule) => factIds.has(rule.factId));
      const selfKnowledgeFactIds =
        character.id === caseArtifact.culpritId
          ? [
              caseArtifact.solution.motiveFactId,
              caseArtifact.solution.methodFactId,
            ].filter((factId) => factIds.has(factId))
          : [];
      return {
        ...character,
        knowledge: {
          factIds: uniqueIds([
            ...knownIds(character.knowledge.factIds, factIds),
            ...secretFactIds,
            ...lieRules.map((rule) => rule.factId),
            ...selfKnowledgeFactIds,
          ]),
          evidenceIds: knownIds(character.knowledge.evidenceIds, evidenceIds),
          claimIds: knownIds(character.knowledge.claimIds, claimIds),
        },
        secretFactIds,
        lieRules,
      };
    }),
    scenes: caseArtifact.scenes.map((scene) => ({
      ...scene,
      objects: scene.objects.map((object) => ({
        ...object,
        // discovery.objectId 是证据获取路径的主声明；同时利用它恢复模型遗漏或
        // 写错的物件反向索引，保证清理悬空 ID 后调查入口仍然存在。
        evidenceIds: uniqueIds([
          ...knownIds(object.evidenceIds, evidenceIds),
          ...(evidenceIdsByObjectId.get(object.id) ?? []),
        ]),
      })),
    })),
    timeline: caseArtifact.timeline.map((event) => ({
      ...event,
      characterIds: knownIds(event.characterIds, characterIds),
      factIds: knownIds(event.factIds, factIds),
    })),
    claims: caseArtifact.claims.map((claim) => ({
      ...claim,
      factIds: knownIds(claim.factIds, factIds),
    })),
    evidence: caseArtifact.evidence.map((evidence) => ({
      ...evidence,
      supportsFactIds: knownIds(evidence.supportsFactIds, factIds),
      contradictsClaimIds: knownIds(evidence.contradictsClaimIds, claimIds),
      implicatesCharacterIds: knownIds(
        evidence.implicatesCharacterIds,
        characterIds,
      ),
      excludesCharacterIds: knownIds(evidence.excludesCharacterIds, characterIds),
      discovery: evidence.discovery,
    })),
    unlockRules: caseArtifact.unlockRules,
    solution: {
      ...caseArtifact.solution,
      requiredEvidenceIds: knownIds(
        caseArtifact.solution.requiredEvidenceIds,
        evidenceIds,
      ),
      requiredTimelineEventIds: knownIds(
        caseArtifact.solution.requiredTimelineEventIds,
        timelineEventIds,
      ),
    },
  };
}

function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}
