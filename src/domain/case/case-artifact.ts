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
    // actionAliases 服务于调查面板；dialogueAliases 则是玩家在审讯框里实际会说的
    // 自然语言。它只服务于 interview；可选字段保证既有 schemaVersion 1 案件仍可
    // 读取，发布门禁会要求新生成的 interview 证据补齐它。
    dialogueAliases: z.array(nonEmptyTextSchema).max(8).optional(),
    // 访谈命中时可直接展示的一人称证词，避免关键进度完全依赖模型临场发挥。
    dialogueUtterance: nonEmptyTextSchema.optional(),
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

const settingSchema = z
  .object({
    era: z.literal("contemporary"),
    place: nonEmptyTextSchema,
    occurredAt: z.string().datetime({ offset: true }),
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
    setting: settingSchema,
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

/**
 * 生成失败后的局部修复协议。模型只能提交实际变动的字段，未出现的字段保留原值。
 * 这避免为了修一个悬空引用而重新输出整份案卷。
 */
const characterPatchSchema = characterSchema
  .partial()
  .extend({ id: entityIdSchema })
  .strict();
const scenePatchSchema = sceneSchema;
const sceneObjectPatchSchema = sceneObjectSchema
  .partial()
  .extend({ sceneId: entityIdSchema, id: entityIdSchema })
  .strict();
const factPatchSchema = factSchema.partial().extend({ id: entityIdSchema }).strict();
const timelinePatchSchema = timelineEventSchema
  .partial()
  .extend({ id: entityIdSchema })
  .strict();
const claimPatchSchema = claimSchema.partial().extend({ id: entityIdSchema }).strict();
const evidencePatchSchema = evidenceSchema
  .partial()
  .extend({ id: entityIdSchema })
  .strict();
const unlockRulePatchSchema = unlockRuleSchema
  .partial()
  .extend({ id: entityIdSchema })
  .strict();
const hintChainPatchSchema = hintChainSchema
  .partial()
  .extend({ id: entityIdSchema })
  .strict();

export const caseArtifactRepairPatchSchema = z
  .object({
    title: nonEmptyTextSchema.optional(),
    briefing: nonEmptyTextSchema.optional(),
    setting: settingSchema.optional(),
    victimId: entityIdSchema.optional(),
    culpritId: entityIdSchema.optional(),
    characters: z.array(characterPatchSchema).max(4).optional(),
    // 局部修复也需要能纠正“生成过多配角”。严格限制为已有的 witness/referenced，
    // 防止修复模型意外删掉受害者或嫌疑人而把案件结构整体打散。
    removeCharacterIds: entityIdListSchema
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "must not contain duplicate character ids",
      })
      .optional(),
    scenes: z.array(scenePatchSchema).max(4).optional(),
    sceneObjects: z.array(sceneObjectPatchSchema).max(8).optional(),
    facts: z.array(factPatchSchema).max(8).optional(),
    timeline: z.array(timelinePatchSchema).max(8).optional(),
    claims: z.array(claimPatchSchema).max(8).optional(),
    evidence: z.array(evidencePatchSchema).max(8).optional(),
    unlockRules: z.array(unlockRulePatchSchema).max(8).optional(),
    hintChains: z.array(hintChainPatchSchema).max(8).optional(),
    solution: solutionSchema.partial().strict().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "must include at least one repair field",
  });

export type CaseArtifactRepairPatch = z.infer<
  typeof caseArtifactRepairPatchSchema
>;

export function applyCaseArtifactRepairPatch(
  caseArtifact: CaseArtifact,
  patch: CaseArtifactRepairPatch,
): CaseArtifact {
  const characters = applyCharacterPatches(caseArtifact, patch);

  return caseArtifactSchema.parse({
    ...caseArtifact,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.briefing === undefined ? {} : { briefing: patch.briefing }),
    ...(patch.setting === undefined ? {} : { setting: patch.setting }),
    ...(patch.victimId === undefined ? {} : { victimId: patch.victimId }),
    ...(patch.culpritId === undefined ? {} : { culpritId: patch.culpritId }),
    characters,
    scenes: applySceneObjectPatches(
      mergeRecordsById(caseArtifact.scenes, patch.scenes),
      patch.sceneObjects,
    ),
    facts: mergeRecordsById(caseArtifact.facts, patch.facts),
    timeline: mergeRecordsById(caseArtifact.timeline, patch.timeline),
    claims: mergeRecordsById(caseArtifact.claims, patch.claims),
    evidence: mergeRecordsById(caseArtifact.evidence, patch.evidence),
    unlockRules: mergeRecordsById(caseArtifact.unlockRules, patch.unlockRules),
    hintChains: mergeRecordsById(caseArtifact.hintChains, patch.hintChains),
    solution: patch.solution
      ? { ...caseArtifact.solution, ...patch.solution }
      : caseArtifact.solution,
  });
}

function applyCharacterPatches(
  caseArtifact: CaseArtifact,
  patch: CaseArtifactRepairPatch,
): CaseArtifact["characters"] {
  const removedCharacterIds = new Set(patch.removeCharacterIds ?? []);
  if (removedCharacterIds.size === 0) {
    return mergeRecordsById(caseArtifact.characters, patch.characters);
  }

  const charactersById = new Map(
    caseArtifact.characters.map((character) => [character.id, character]),
  );
  const invalidRemovalIds = [...removedCharacterIds].filter((characterId) => {
    const character = charactersById.get(characterId);
    return !character || (character.roleTier !== "witness" && character.roleTier !== "referenced");
  });
  if (invalidRemovalIds.length > 0) {
    throw new Error(
      `repair patches can only remove existing supporting characters: ${invalidRemovalIds.join(", ")}`,
    );
  }

  return mergeRecordsById(caseArtifact.characters, patch.characters).filter(
    (character) => !removedCharacterIds.has(character.id),
  );
}

function mergeRecordsById<T extends { id: string }>(
  records: readonly T[],
  patches: ReadonlyArray<{ id: string } & Partial<T>> | undefined,
): T[] {
  if (!patches || patches.length === 0) return [...records];
  const patchesById = new Map(patches.map((patch) => [patch.id, patch]));
  const knownIds = new Set(records.map((record) => record.id));
  return [
    ...records.map((record) => {
      const patch = patchesById.get(record.id);
      return patch ? { ...record, ...patch } : record;
    }),
    // 新记录只在最终 caseArtifactSchema.parse 通过后才会被接纳；这里保留补丁的
    // 具体字段以支持“数量不足时新增完整实体”的修复。
    ...patches
      .filter((patch) => !knownIds.has(patch.id))
      .map((patch) => patch as T),
  ];
}

function applySceneObjectPatches(
  scenes: CaseArtifact["scenes"],
  patches: CaseArtifactRepairPatch["sceneObjects"],
) {
  if (!patches || patches.length === 0) return scenes;
  return scenes.map((scene) => {
    const objectPatches = patches
      .filter((patch) => patch.sceneId === scene.id)
      .map(({ sceneId: _sceneId, ...patch }) => patch);
    if (objectPatches.length === 0) return scene;
    return {
      ...scene,
      objects: mergeRecordsById(scene.objects, objectPatches),
    };
  });
}

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
