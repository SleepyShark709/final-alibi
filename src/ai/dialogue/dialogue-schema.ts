import { z } from "zod";

export const characterDemeanorSchema = z.enum([
  "calm",
  "guarded",
  "evasive",
  "agitated",
  "cooperative",
  "defiant",
]);

export const characterResponseSchema = z
  .object({
    utterance: z.string().trim().min(1).max(800),
    demeanor: characterDemeanorSchema,
    disclosedClaimIds: z.array(z.string()).max(6),
    memorySummary: z.string().trim().max(1_200),
    stateDelta: z
      .object({
        trust: z.number().int().min(-10).max(10),
        pressure: z.number().int().min(-10).max(10),
        alertness: z.number().int().min(-10).max(10),
      })
      .strict(),
  })
  .strict();

export type CharacterResponse = z.infer<typeof characterResponseSchema>;

export const dialogueGuardSchema = z
  .object({
    safe: z.boolean(),
    violationCodes: z.array(
      z.enum([
        "knowledge_leak",
        "truth_contradiction",
        "prompt_injection_compliance",
        "role_break",
        "unsupported_claim",
      ]),
    ),
    feedback: z.string().trim().max(1_000),
  })
  .strict();

export type DialogueGuard = z.infer<typeof dialogueGuardSchema>;
