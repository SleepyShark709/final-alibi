import { z } from "zod";

export const caseGenerationRequestSchema = z
  .object({
    seed: z.string().trim().min(4).max(120),
    theme: z.string().trim().min(1).max(200).default("现代都市中的封闭空间案件"),
    locationHint: z.string().trim().max(120).optional(),
    difficulty: z.enum(["easy", "standard", "hard"]).default("standard"),
  })
  .strict();

export type CaseGenerationRequest = z.infer<typeof caseGenerationRequestSchema>;

export const blindSolveResultSchema = z
  .object({
    culpritId: z.string(),
    evidenceIds: z.array(z.string()).min(2).max(12),
    reasoning: z.string().trim().min(20).max(2_000),
  })
  .strict();

export type BlindSolveResult = z.infer<typeof blindSolveResultSchema>;

export const openingReviewSchema = z.object({
  issues: z.array(z.object({
    kind: z.enum(["hidden_conflict", "identity_shortcut", "early_testimony", "ordinary_lead"]),
    path: z.string().trim().min(1),
    quote: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  }).strict()).max(6),
}).strict();

export const publicWindowSchema = z.object({
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }),
  startSourceIds: z.array(z.string()).min(1).max(4),
  endSourceIds: z.array(z.string()).min(1).max(4),
}).strict();

export type PublicWindow = z.infer<typeof publicWindowSchema>;

/** 图内保留已审公开依据，供下一次局部修复使用；不属于案件或模型输出格式。 */
export const publicWindowReviewSchema = z.object({
  window: publicWindowSchema.nullable(),
  sources: z.array(z.object({
    id: z.string(), path: z.string(), text: z.string(), evidenceId: z.string().optional(),
  }).strict()),
  temporalEvidenceIds: z.array(z.string()),
}).strict();

export type PublicWindowReview = z.infer<typeof publicWindowReviewSchema>;

export const evidenceReviewSchema = z.object({
  results: z.array(z.object({
    obligationId: z.string(),
    verdict: z.enum(["supported", "unsupported", "uncertain"]),
    citations: z.array(z.object({
      sourceId: z.string(),
      aspects: z.array(z.enum(["basis", "identity", "location", "window"])).min(1).max(4),
    }).strict()).max(4),
    publicWindow: publicWindowSchema.optional(),
    coverage: publicWindowSchema.optional(),
    reason: z.string().trim().min(1).max(240),
  }).strict()),
}).strict();

export type EvidenceReviewResult = z.infer<typeof evidenceReviewSchema>;

export const generationIssueSchema = z
  .object({
    code: z.string(),
    path: z.string(),
    message: z.string(),
  })
  .strict();
