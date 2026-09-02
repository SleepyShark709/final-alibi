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
      repairFeedback: state.guard?.feedback,
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

    // 已披露的 lie claim 或逐字采用 coverStatement 都是账本明确授权的说法。
    // 这类回复先通过确定性校验即可展示，不能再交给语义守卫用“客观真相”反推否决。
    if (
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
      maxTokens: 500,
    });

    return {
      guard: result.value,
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
  const forbiddenStatements = [
    ...caseArtifact.facts
      .filter((fact) => !character.knowledge.factIds.includes(fact.id))
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
    draft.disclosedClaimIds.length === 0 &&
    repeatsPreviousNoProgressResponse(session, characterId, normalizedUtterance)
  ) {
    violations.add("repeated_response");
  }
  return [...violations];
}

function repeatsPreviousNoProgressResponse(
  session: GameSession,
  characterId: string,
  normalizedUtterance: string,
) {
  if (normalizedUtterance.length < 8) return false;

  return session.dialogue
    .filter(
      (exchange) =>
        exchange.characterId === characterId &&
        exchange.disclosedClaimIds.length === 0 &&
        exchange.discoveredEvidenceIds.length === 0,
    )
    .slice(-3)
    .some((exchange) => {
      const previous = normalizeSemanticText(exchange.utterance);
      if (previous.length < 8) return false;
      return (
        normalizedUtterance === previous ||
        (normalizedUtterance.length >= 12 &&
          previous.length >= 12 &&
          (normalizedUtterance.includes(previous) ||
            previous.includes(normalizedUtterance)))
      );
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

  const declaredLie = draft.disclosedClaimIds.some((claimId) => {
    const claim = caseArtifact.claims.find((candidate) => candidate.id === claimId);
    return Boolean(
      claim &&
        claim.kind === "lie" &&
        claim.speakerId === character.id &&
        character.knowledge.claimIds.includes(claim.id) &&
        claimCanBeDisclosed(caseArtifact, session, character.id, claim.id),
    );
  });
  if (declaredLie) return true;

  const normalizedUtterance = normalizeSemanticText(draft.utterance);
  return character.lieRules.some((rule) => {
    const normalizedCover = normalizeSemanticText(rule.coverStatement);
    return (
      normalizedCover.length >= 8 &&
      normalizedUtterance.includes(normalizedCover)
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
