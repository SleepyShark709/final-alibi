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

export const generationIssueSchema = z
  .object({
    code: z.string(),
    path: z.string(),
    message: z.string(),
  })
  .strict();
