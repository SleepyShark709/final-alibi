import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import { createModelCallAudit, modelCallAuditSchema } from "@/ai/model-audit";
import type { StructuredModelProvider } from "@/ai/model-provider";
import {
  caseArtifactSchema,
  type CaseArtifact,
} from "@/domain/case/case-artifact";
import {
  buildDeterministicDialogueShortcut,
  claimCanBeDisclosed,
  factCanBeDisclosed,
  getDialogueGroundingSources,
  getPublicDialogueIdentities,
  resolveDialogueQuestion,
  isProofOrTimeQuestion,
  isVerificationFollowUp,
  type GameSession,
} from "@/domain/game/game-runtime";

import { buildGroundedDialogueFallback } from "./dialogue-fallback";
import {
  buildCharacterMessages,
  buildDialogueGuardMessages,
} from "./dialogue-prompts";
import {
  characterResponseSchema,
  dialogueGuardSchema,
  type CharacterResponse,
  type DialogueGuard,
} from "./dialogue-schema";

const DialogueGraphState = new StateSchema({
  caseArtifact: caseArtifactSchema,
  session: z.custom<GameSession>(isGameSession),
  commandId: z.string().min(1),
  characterId: z.string().min(1),
  playerText: z.string().trim().min(1).max(2_000),
  attempt: z.number().int().nonnegative().default(0),
  draft: characterResponseSchema.nullable().default(null),
  guard: dialogueGuardSchema.nullable().default(null),
  shortcutResponse: characterResponseSchema.nullable().default(null),
  finalResponse: characterResponseSchema.nullable().default(null),
  modelCalls: z.array(modelCallAuditSchema).default([]),
});

export type DialogueGraphInput = {
  caseArtifact: CaseArtifact;
  session: GameSession;
  commandId: string;
  characterId: string;
  playerText: string;
  attempt?: number;
  draft?: CharacterResponse | null;
  guard?: DialogueGuard | null;
  finalResponse?: CharacterResponse | null;
  modelCalls?: import("@/ai/model-audit").ModelCallAudit[];
};

export interface DialogueGraphOptions {
  checkpointer?: BaseCheckpointSaver;
  maxDraftAttempts?: number;
}

export function createDialogueGraph(
  provider: StructuredModelProvider,
  options: DialogueGraphOptions = {},
) {
  // 单次对话采用“生成 -> 确定性校验 -> 模型守卫 -> 有界重试/安全兜底”，模型从不直接写游戏状态。
  const maxDraftAttempts = options.maxDraftAttempts ?? 3;

  const generate: typeof DialogueGraphState.Node = async (state) => {
    const shortcutResponse = buildDeterministicDialogueShortcut(
      state.caseArtifact,
      state.session,
      state.characterId,
      state.playerText,
    );
    if (shortcutResponse) {
      return {
        draft: null,
        guard: null,
        shortcutResponse,
      };
    }

    const messages = buildCharacterMessages({
      caseArtifact: state.caseArtifact,
      session: state.session,
      characterId: state.characterId,
      playerText: state.playerText,
      repairFeedback: state.guard
        ? `${state.guard.violationCodes.join(", ")}：${state.guard.feedback}`
        : undefined,
      rejectedDraft: state.guard ? state.draft ?? undefined : undefined,
    });
    const result = await provider.invokeStructured({
      tier: "flash",
      schema: characterResponseSchema,
      schemaName: "character_response",
      messages,
      temperature: state.attempt === 0 ? 0.55 : 0.2,
      maxTokens: 900,
    });

    return {
      attempt: state.attempt + 1,
      draft: result.value,
      guard: null,
      shortcutResponse: null,
      modelCalls: [
        ...state.modelCalls,
        createModelCallAudit("character_response", "flash", messages, result),
      ],
    };
  };

  const guard: typeof DialogueGraphState.Node = async (state) => {
    if (!state.draft) {
      return {
        guard: {
          safe: false,
          violationCodes: ["role_break"],
          feedback: "候选回复为空，请重新生成完整的角色回复。",
        },
      };
    }

    // 先跑无需模型即可证明的越权检查，避免把明显不安全的草稿再次交给模型。
    const deterministicViolations = validateDraftDeterministically(
      state.caseArtifact,
      state.session,
      state.characterId,
      state.playerText,
      state.draft,
    );
    if (deterministicViolations.length > 0) {
      return {
        guard: {
          safe: false,
          violationCodes: deterministicViolations,
          feedback: `确定性校验失败：${deterministicViolations.join(", ")}`,
        },
      };
    }

    // 只有整句逐字采用授权谎言才免于语义审查；引用合法 claim 不能为新增细节背书。
    if (
      !isVerificationFollowUp(state.playerText) &&
      hasAuthorizedLieResponse(
        state.caseArtifact,
        state.session,
        state.characterId,
        state.draft,
      )
    ) {
      return {
        guard: { safe: true, violationCodes: [], feedback: "" },
      };
    }

    const messages = buildDialogueGuardMessages({
      caseArtifact: state.caseArtifact,
      session: state.session,
      characterId: state.characterId,
      playerText: state.playerText,
      candidate: state.draft,
    });
    const result = await provider.invokeStructured({
      tier: "flash",
      schema: dialogueGuardSchema,
      schemaName: "dialogue_guard",
      messages,
      temperature: 0,
      maxTokens: 1_200,
    });

    const groundingFailure = result.value.safe && validateGuardGrounding(
      state.caseArtifact, state.session, state.characterId, state.playerText, state.draft, result.value,
    );
    return {
      guard: groundingFailure
        ? { ...result.value, safe: false, violationCodes: ["unsupported_claim"] as DialogueGuard["violationCodes"], feedback: groundingFailure }
        : result.value,
      modelCalls: [
        ...state.modelCalls,
        createModelCallAudit("dialogue_guard", "flash", messages, result),
      ],
    };
  };

  const finalize: typeof DialogueGraphState.Node = (state) => ({
    finalResponse: state.shortcutResponse ?? state.draft,
  });

  const fallback: typeof DialogueGraphState.Node = (state) => {
    console.warn("[dialogue-fallback] semantic guard exhausted", {
      characterId: state.characterId,
      attempts: state.attempt,
      violationCodes: state.guard?.violationCodes ?? [],
    });
    return {
      finalResponse: buildGroundedDialogueFallback(
        state.caseArtifact,
        state.session,
        state.characterId,
        state.playerText,
      ),
    };
  };

  return new StateGraph(DialogueGraphState)
    .addNode("generate", generate)
    .addNode("review_draft", guard)
    .addNode("finalize", finalize)
    .addNode("fallback", fallback)
    .addEdge(START, "generate")
    .addConditionalEdges(
      "generate",
      (state) => (state.shortcutResponse ? "finalize" : "review_draft"),
      {
        finalize: "finalize",
        review_draft: "review_draft",
      },
    )
    .addConditionalEdges(
      "review_draft",
      (state) => {
        if (state.guard?.safe) return "finalize";
        return state.attempt < maxDraftAttempts ? "retry" : "fallback";
      },
      {
        finalize: "finalize",
        retry: "generate",
        fallback: "fallback",
      },
    )
    .addEdge("finalize", END)
    .addEdge("fallback", END)
    .compile({ checkpointer: options.checkpointer });
}

function validateDraftDeterministically(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  playerText: string,
  draft: CharacterResponse,
): DialogueGuard["violationCodes"] {
  // 不仅检查 claim id，还检查回复是否逐字复述角色未知或尚未解锁的事实/证词。
  const character = caseArtifact.characters.find(
    (candidate) => candidate.id === characterId,
  );
  if (!character) return ["role_break"];

  const allowedClaimIds = new Set(
    caseArtifact.claims
      .filter(
        (claim) =>
          claim.speakerId === character.id &&
          character.knowledge.claimIds.includes(claim.id) &&
          claimCanBeDisclosed(caseArtifact, session, character.id, claim.id),
      )
      .map((claim) => claim.id),
  );
  const violations = new Set<DialogueGuard["violationCodes"][number]>();
  if (draft.disclosedClaimIds.some((claimId) => !allowedClaimIds.has(claimId))) {
    violations.add("unsupported_claim");
  }
  if (
    /(system\s*prompt|character_context|privateprofile|culpritid|提示词|系统指令|fact_|evidence_|claim_)/iu.test(
      draft.utterance,
    )
  ) {
    violations.add("role_break");
  }
  const normalizedUtterance = normalizeSemanticText(draft.utterance);
  // 对话和 memorySummary 只是表达历史，不能成为新事实的授权来源。
  const authorizedStatements = getDialogueGroundingSources(caseArtifact, session, characterId)
    .map((source) => normalizeSemanticText(source.statement));
  const noWitness = /(?:只有|仅有|就)我(?:一|1)个人|(?:我|自己)(?:是)?(?:一个人|独自|单独)|(?:没有人|没人|无人).{0,12}(?:作证|证明|确认|看见|见到|看到|一起|陪同|在场)/u;
  if (
    noWitness.test(normalizedUtterance) &&
    !authorizedStatements.some((statement) => noWitness.test(statement))
  ) {
    violations.add("unsupported_claim");
  }
  // 加班不自动授权具体工作内容；新增可核验活动须在账本中有对应动作。
  const activities = claimedActivities(draft.utterance);
  if (activities.some((activity) => !authorizedStatements.some((statement) => statement.includes(activity)))) {
    violations.add("unsupported_claim");
  }
  const durationPattern = /(?<![那这第每])(?:\d+|[零〇一二两三四五六七八九十百千]+)(?:年|个月|月|天|小时|分钟)(?:多|余|左右|整)?/gu;
  const durations = draft.utterance.match(durationPattern) ?? [];
  if (durations.some((duration) => !authorizedStatements.some((statement) =>
    normalizeChineseNumbers(statement).includes(normalizeChineseNumbers(duration)),
  ))) {
    violations.add("unsupported_claim");
  }
  if (
    isProofOrTimeQuestion(playerText) &&
    hasAuthorizedLieResponse(caseArtifact, session, characterId, draft) &&
    !/证明|作证|见证|看见|看到|见到|陪|一起|独自|单独|没有人|没人|无人|监控|门禁|记录/u.test(draft.utterance)
  ) {
    violations.add("repeated_response");
  }
  const forbiddenStatements = [
    ...caseArtifact.facts
      .filter((fact) => !factCanBeDisclosed(caseArtifact, session, characterId, fact.id))
      .map((fact) => fact.statement),
    ...caseArtifact.claims
      .filter(
        (claim) =>
          claim.speakerId === character.id &&
          character.knowledge.claimIds.includes(claim.id) &&
          !claimCanBeDisclosed(caseArtifact, session, character.id, claim.id),
      )
      .map((claim) => claim.statement),
  ];
  if (
    forbiddenStatements.some((statement) => {
      const normalized = normalizeSemanticText(statement);
      return normalized.length >= 8 && normalizedUtterance.includes(normalized);
    })
  ) {
    violations.add("knowledge_leak");
  }
  if (
    repeatsPreviousResponse(session, characterId, normalizedUtterance)
  ) {
    violations.add("repeated_response");
  }
  return [...violations];
}

function validateGuardGrounding(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  playerText: string,
  draft: CharacterResponse,
  guard: DialogueGuard,
): string | undefined {
  const sources = getDialogueGroundingSources(caseArtifact, session, characterId);
  const character = caseArtifact.characters.find((person) => person.id === characterId)!;
  const victim = caseArtifact.characters.find((person) => person.id === caseArtifact.victimId)!;
  const question = resolveDialogueQuestion(session, characterId, playerText);
  const utterance = normalizeSemanticText(draft.utterance);
  const checks = guard.groundingChecks ?? [];
  const containsQuote = (statement: string, quote: string) => {
    const start = statement.indexOf(quote);
    return quote.length >= 4 && start >= 0 &&
      (start === 0 || /[。！？；\n]/u.test(statement[start - 1])) &&
      (start + quote.length === statement.length || /[。！？；]$/u.test(quote));
  };
  if (checks.some((check) => !utterance.includes(normalizeSemanticText(check.candidateText)) ||
    !sources.some((source) => containsQuote(source.statement, check.sourceText.trim())))) {
    return "事实依据引用无效。请仅保留允许来源明确支持的回复内容，不要新增细节。";
  }
  const unsupported = draft.utterance.split(/[。！？；，,:：]/u).map((clause) => clause.trim()).find((clause) => {
    const normalized = normalizeSemanticText(clause);
    if (!normalized) return false;
    if (isNonFactualClause(clause, question)) return false;
    if (sources.some((source) => !source.contextOnly && supportedClause(clause, source.statement, character.name, victim.name))) return false;
    return !checks.some((check) => {
      const candidate = normalizeSemanticText(check.candidateText);
      if (!candidate.includes(normalized)) return false;
      return sources.some((source) => containsQuote(source.statement, check.sourceText.trim()) &&
        (source.contextOnly
          ? supportedPublicIdentity(caseArtifact, characterId, question, clause, check.sourceText)
          : supportedClause(clause, check.sourceText, character.name, victim.name)));
    });
  });
  return unsupported ? `候选片段“${unsupported}”改变或补充了来源没有明确支持的内容。请直接采用对应授权命题，保留主体、时点、否定与限定；删除额外经历，不要扩大或改写事实。` : undefined;
}

function isNonFactualClause(clause: string, question: string) {
  const topic = clause.match(/^(?:你|您)(?:问|追问)的是(.+)$/u)?.[1];
  if (topic && normalizeSemanticText(question).includes(normalizeSemanticText(topic))) return true;
  // 豁免必须覆盖整个子句，不能借“关于”或“无法确认”带入未经授权的事实。
  return /^(?:(?:关于|就你问的)(?:这段行踪|这个问题|这一点|这件事)|这一点|时间这一点)$/u.test(clause) ||
    /^(?:我)?(?:目前|现在|暂时|仍然|也)?(?:(?:无法|不能|不敢|难以|没法)(?:确认|确定|提供|解释|补充)|(?:解释|确认|确定|补充|提供)不了)(?:(?:更多|具体|可以核实的)?(?:信息|情况|细节|时间|人证|人证信息|证明信息|证明人))?$/u.test(clause) ||
    /^(?:我)?(?:目前|现在|暂时|仍然|也)?(?:记不清|说不准|没把握|不知道你在说什么|没有(?:更多|具体)?(?:信息|情况|细节))$/u.test(clause) ||
    /^(?:(?:你|您)(?:可以|能)|请|建议你)(?:再)?(?:核对|核查|查看)(?:(?:已经|已)(?:拿到|取得|发现)的|现有的?|手头的?)(?:证据|信息|记录)$/u.test(clause);
}

function canonicalFactClause(value: string, characterName: string, victimName: string) {
  const namesResolved = normalizeSemanticText(value)
    .replaceAll(characterName, "我")
    .replaceAll(victimName, "死者")
    .replaceAll("受害者", "死者");
  return normalizeChineseNumbers(namesResolved)
    .replace(/^(?:我的说法(?:仍)?是|我能说明的是|我说的是)/u, "")
    .replace(/没有/gu, "没")
    .replace(/看见|见到/gu, "看到")
    .replace(/确实|的确/gu, "")
    .replace(/^((?:那天|当天|当晚|那晚|当时|案发时)(?:晚上|夜里|前后)?)我/u, "我$1");
}

function supportedClause(candidate: string, source: string, characterName: string, victimName: string) {
  const normalized = canonicalFactClause(candidate, characterName, victimName);
  return source.split(/[。！？；，,:：]/u).some((clause) => {
    // 只接受完整命题的受控书写变化；任意删字会改变主体、数值或限定范围。
    return normalized === canonicalFactClause(clause, characterName, victimName);
  });
}

function supportedPublicIdentity(caseArtifact: CaseArtifact, characterId: string, question: string, candidate: string, quote: string) {
  const character = caseArtifact.characters.find((person) => person.id === characterId)!;
  const victim = caseArtifact.characters.find((person) => person.id === caseArtifact.victimId)!;
  const subjects = [
    { text: "我", id: characterId }, { text: character.name, id: characterId },
    { text: victim.name, id: victim.id }, { text: "死者", id: victim.id }, { text: "受害者", id: victim.id },
    ...(/死者|受害者/u.test(question) || question.includes(victim.name) ? [{ text: "他", id: victim.id }, { text: "她", id: victim.id }] : []),
  ];
  const normalized = normalizeSemanticText(candidate);
  return subjects.some((subject) => ["的职业是", "担任", "是", "为", "任"].some((verb) => {
    if (!normalized.startsWith(subject.text + verb)) return false;
    const identity = normalized.slice(subject.text.length + verb.length);
    return getPublicDialogueIdentities(caseArtifact, characterId).some((fact) => fact.characterId === subject.id &&
      normalizeSemanticText(quote).includes(normalizeSemanticText(fact.declaration)) &&
      identity.replace(/^小区/u, "") === normalizeSemanticText(fact.identity).replace(/^小区/u, ""));
  }));
}

function normalizeChineseNumbers(value: string) {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
  return value.replace(/[零〇一二两三四五六七八九十百千]+/gu, (number) => {
    if (![...number].some((character) => units[character])) return [...number].map((character) => digits[character]).join("");
    let total = 0;
    let digit = 0;
    for (const character of number) {
      if (units[character]) { total += (digit || 1) * units[character]; digit = 0; }
      else digit = digits[character];
    }
    return String(total + digit);
  });
}

function claimedActivities(utterance: string) {
  return utterance.split(/[。！？；]/u).flatMap((sentence) =>
    Array.from(sentence.matchAll(/整理|核对|核算|查阅|填写|编写|做账|对账|记账|打电话|通话|开会|会面|见面|交接/gu))
      .filter((match) => {
        const prefix = sentence.slice(0, match.index).split(/[，,]/u).at(-1) ?? "";
        // 指向侦探的核验建议及否定句不是角色声称已经做过的活动。
        return !/(?:你|您|侦探).{0,8}(?:可以|能|去|应该|再)|(?:请|建议|不妨|需要|可以|没有|没|未|不曾).{0,6}$/u.test(prefix);
      })
      .map((match) => match[0]),
  );
}

function repeatsPreviousResponse(
  session: GameSession,
  characterId: string,
  normalizedUtterance: string,
) {
  if (normalizedUtterance.length < 8) return false;

  return session.dialogue
    .filter((exchange) => exchange.characterId === characterId)
    .slice(-3)
    .some((exchange) => {
      const previous = normalizeSemanticText(exchange.utterance);
      if (previous.length < 8) return false;
      return normalizedUtterance === previous;
    });
}

function hasAuthorizedLieResponse(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  draft: CharacterResponse,
) {
  const character = caseArtifact.characters.find(
    (candidate) => candidate.id === characterId,
  );
  if (!character) return false;

  const normalizedUtterance = normalizeSemanticText(draft.utterance);
  const declaredLie = draft.disclosedClaimIds.some((claimId) => {
    const claim = caseArtifact.claims.find((candidate) => candidate.id === claimId);
    return Boolean(
      claim &&
        claim.kind === "lie" &&
        normalizeSemanticText(claim.statement) === normalizedUtterance &&
        claim.speakerId === character.id &&
        character.knowledge.claimIds.includes(claim.id) &&
        claimCanBeDisclosed(caseArtifact, session, character.id, claim.id),
    );
  });
  if (declaredLie) return true;

  return character.lieRules.some((rule) => {
    const normalizedCover = normalizeSemanticText(rule.coverStatement);
    return (
      normalizedCover.length >= 8 &&
      normalizedUtterance === normalizedCover
    );
  });
}

function normalizeSemanticText(value: string) {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function isGameSession(value: unknown): value is GameSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "id" in value &&
    typeof value.id === "string"
  );
}
