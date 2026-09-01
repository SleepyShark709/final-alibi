import { z } from "zod";

const entityIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "must be a lowercase snake_case identifier");

const nonEmptyTextSchema = z.string().trim().min(1);
const entityIdListSchema = z.array(entityIdSchema);

const portraitTagsSchema = z
  .object({
    gender: z.enum(["male", "female", "nonbinary"]),
    ageGroup: z.enum(["child", "young", "middle", "senior"]),
    temperament: z.array(nonEmptyTextSchema),
  })
  .strict();

const lieRuleSchema = z
  .object({
    factId: entityIdSchema,
    strategy: z.enum(["deny", "deflect", "minimize", "fabricate_cover"]),
    coverStatement: nonEmptyTextSchema,
  })
  .strict();

const characterSchema = z
  .object({
    id: entityIdSchema,
    name: nonEmptyTextSchema,
    roleTier: z.enum(["victim", "suspect", "witness", "referenced"]),
    occupation: nonEmptyTextSchema,
    publicProfile: nonEmptyTextSchema,
    privateProfile: nonEmptyTextSchema,
    portraitTags: portraitTagsSchema,
    knowledge: z
      .object({
        factIds: entityIdListSchema,
        evidenceIds: entityIdListSchema,
        claimIds: entityIdListSchema,
      })
      .strict(),
    secretFactIds: entityIdListSchema,
    lieRules: z.array(lieRuleSchema),
  })
  .strict();

const sceneObjectSchema = z
  .object({
    id: entityIdSchema,
    name: nonEmptyTextSchema,
    description: nonEmptyTextSchema,
    actionAliases: z.array(nonEmptyTextSchema).min(1),
    evidenceIds: entityIdListSchema,
  })
  .strict();

const sceneSchema = z
  .object({
    id: entityIdSchema,
    name: nonEmptyTextSchema,
    description: nonEmptyTextSchema,
    initiallyUnlocked: z.boolean(),
    objects: z.array(sceneObjectSchema),
  })
  .strict();

const factSchema = z
  .object({
    id: entityIdSchema,
    type: z.enum([
      "identity",
      "motive",
      "method",
      "opportunity",
      "alibi",
      "relationship",
      "context",
    ]),
    statement: nonEmptyTextSchema,
  })
  .strict();

const timelineEventSchema = z
  .object({
    id: entityIdSchema,
    timestamp: z.string().datetime({ offset: true }),
    sceneId: entityIdSchema,
    characterIds: entityIdListSchema,
    factIds: entityIdListSchema,
    description: nonEmptyTextSchema,
  })
  .strict();

const claimSchema = z
  .object({
    id: entityIdSchema,
    speakerId: entityIdSchema,
    kind: z.enum(["truth", "lie", "mistaken", "withheld"]),
    statement: nonEmptyTextSchema,
    factIds: entityIdListSchema,
  })
  .strict();

const evidenceDiscoverySchema = z
  .object({
    method: z.enum(["inspect", "search", "analyze", "query", "interview"]),
    sceneId: entityIdSchema.optional(),
    objectId: entityIdSchema.optional(),
    characterId: entityIdSchema.optional(),
    actionAliases: z.array(nonEmptyTextSchema).min(1),
    prerequisiteEvidenceIds: entityIdListSchema,
  })
  .strict();

const evidenceSchema = z
  .object({
    id: entityIdSchema,
    name: nonEmptyTextSchema,
    description: nonEmptyTextSchema,
    kind: z.enum(["physical", "digital", "testimony", "document", "forensic"]),
    supportsFactIds: entityIdListSchema,
    contradictsClaimIds: entityIdListSchema,
    implicatesCharacterIds: entityIdListSchema,
    excludesCharacterIds: entityIdListSchema,
    critical: z.boolean(),
    discovery: evidenceDiscoverySchema,
  })
  .strict();

const unlockRuleSchema = z
  .object({
    id: entityIdSchema,
    targetType: z.enum(["scene", "character", "evidence", "analysis"]),
    targetId: entityIdSchema,
    allEvidenceIds: entityIdListSchema,
    anyEvidenceIds: entityIdListSchema,
  })
  .strict();

const hintChainSchema = z
  .object({
    id: entityIdSchema,
    targetFactId: entityIdSchema,
    hints: z.tuple([
      nonEmptyTextSchema,
      nonEmptyTextSchema,
      nonEmptyTextSchema,
    ]),
  })
  .strict();

const solutionSchema = z
  .object({
    culpritId: entityIdSchema,
    motiveFactId: entityIdSchema,
    methodFactId: entityIdSchema,
    requiredEvidenceIds: entityIdListSchema,
    requiredTimelineEventIds: entityIdListSchema,
  })
  .strict();

/**
 * 案件的不可变“真相账本”。它描述客观事实、角色知识和解锁规则；
 * 玩家进行中的发现、对话与结案结果只能写入 GameSession，绝不能回写这里。
 */
export const caseArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: entityIdSchema,
    seed: nonEmptyTextSchema,
    title: nonEmptyTextSchema,
    briefing: nonEmptyTextSchema,
    setting: z
      .object({
        era: z.literal("contemporary"),
        place: nonEmptyTextSchema,
        occurredAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    victimId: entityIdSchema,
    culpritId: entityIdSchema,
    characters: z.array(characterSchema),
    scenes: z.array(sceneSchema),
    facts: z.array(factSchema),
    timeline: z.array(timelineEventSchema),
    claims: z.array(claimSchema),
    evidence: z.array(evidenceSchema),
    unlockRules: z.array(unlockRuleSchema),
    hintChains: z.array(hintChainSchema),
    solution: solutionSchema,
  })
  .strict();

export type CaseArtifact = z.infer<typeof caseArtifactSchema>;

/** 在所有外部边界校验并冻结真相账本，防止运行时意外改变已发布案件。 */
export function parseCaseArtifact(input: unknown): CaseArtifact {
  return deepFreeze(caseArtifactSchema.parse(input));
}

// 递归冻结是发布契约的一部分：同一 case id 的内容哈希必须始终对应同一真相。
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value);
}
