import { createHash } from "node:crypto";

import type { BaseCheckpointSaver } from "@langchain/langgraph";

import { createDialogueGraph } from "@/ai/dialogue/dialogue-graph";
import type { ModelCallAudit } from "@/ai/model-audit";
import type { StructuredModelProvider } from "@/ai/model-provider";
import {
  claimCanBeDisclosed,
  evidenceIsAvailable,
  recordDialogueTurn,
  type DialogueOutcome,
  type ValidatedCharacterResponse,
} from "@/domain/game/game-runtime";
import type { CaseArtifact } from "@/domain/case/case-artifact";
import type { GameSession } from "@/domain/game/game-runtime";
import type { GameRepository } from "@/infrastructure/persistence/game-repository";

export interface TalkToCharacterInput {
  playerId: string;
  sessionId: string;
  commandId: string;
  expectedRevision: number;
  characterId: string;
  text: string;
  now?: string;
}

export class DialogueService {
  private readonly graph;

  constructor(
    private readonly repository: GameRepository,
    provider: StructuredModelProvider,
    checkpointer?: BaseCheckpointSaver,
  ) {
    this.graph = createDialogueGraph(provider, { checkpointer });
  }

  async talk(input: TalkToCharacterInput) {
    // executeGameCommand 保证 commandId 幂等；图的执行结果只有通过 runtime 再校验后才可能提交。
    return this.repository.executeGameCommand<DialogueOutcome>(
      {
        playerId: input.playerId,
        sessionId: input.sessionId,
        commandId: input.commandId,
        kind: "dialogue",
        expectedRevision: input.expectedRevision,
        request: {
          characterId: input.characterId,
          text: input.text,
        },
        now: input.now,
      },
      async (caseArtifact, session) => {
        if (!session.unlockedCharacterIds.includes(input.characterId)) {
          throw new Error(`Character "${input.characterId}" is not available`);
        }

        let response: ValidatedCharacterResponse;
        try {
          const graphResult = await this.graph.invoke(
            {
              caseArtifact,
              session,
              commandId: input.commandId,
              characterId: input.characterId,
              playerText: input.text,
              attempt: 0,
              draft: null,
              guard: null,
              finalResponse: null,
              modelCalls: [],
            },
            {
              configurable: {
                // 每条命令独占 checkpoint，避免跨回合恢复旧 attempt/draft 并污染重试或审计。
                thread_id: `${session.id}:character:${input.characterId}:command:${input.commandId}`,
              },
            },
          );
          if (!graphResult.finalResponse) {
            throw new Error("Dialogue graph completed without a safe response");
          }

          await this.persistModelCalls(
            graphResult.modelCalls,
            session.id,
            caseArtifact.id,
            input.commandId,
            input.now,
          );
          response = graphResult.finalResponse;
        } catch {
          response = buildDeterministicDialogueFallback(
            caseArtifact,
            session,
            input.characterId,
            input.text,
          );
        }

        return recordDialogueTurn(caseArtifact, session, {
          commandId: input.commandId,
          characterId: input.characterId,
          playerText: input.text,
          response,
          now: input.now,
        });
      },
    );
  }

  private async persistModelCalls(
    calls: ModelCallAudit[],
    sessionId: string,
    caseId: string,
    commandId: string,
    now?: string,
  ) {
    for (const call of calls) {
      const modelRunId = await this.repository.startModelRun({
        sessionId,
        caseId,
        commandId,
        graphName: "character_dialogue",
        nodeName: call.task,
        provider: "deepseek",
        model: call.model,
        promptHash: createHash("sha256")
          .update(JSON.stringify(call.request))
          .digest("hex"),
        request: call.request,
        now,
      });
      await this.repository.finishModelRun({
        id: modelRunId,
        response: call.response,
        inputTokens: call.inputTokens,
        cachedInputTokens: call.cachedInputTokens,
        outputTokens: call.outputTokens,
        estimatedCostMicrosCny: call.estimatedCostMicrosCny,
        now,
      });
    }
  }
}

export function buildDeterministicDialogueFallback(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  playerText: string,
): ValidatedCharacterResponse {
  // 无 Key、模型异常或审计写入失败时仍可游玩；此分支也必须遵守同一证据/证词可见性规则。
  const character = caseArtifact.characters.find(
    (candidate) => candidate.id === characterId,
  );
  if (!character) throw new Error(`Unknown character "${characterId}"`);
  const normalizedQuestion = normalizeDialogueText(playerText);
  const requestedEvidence = caseArtifact.evidence.find(
    (evidence) =>
      evidence.discovery.method === "interview" &&
      evidence.discovery.characterId === character.id &&
      evidence.discovery.actionAliases.some((alias) => {
        const normalizedAlias = normalizeDialogueText(alias);
        return (
          normalizedQuestion.includes(normalizedAlias) ||
          normalizedAlias.includes(normalizedQuestion)
        );
      }),
  );
  const matchingEvidence =
    requestedEvidence &&
    evidenceIsAvailable(caseArtifact, session, requestedEvidence.id)
      ? requestedEvidence
      : undefined;
  const allowedClaims = caseArtifact.claims.filter(
    (claim) =>
      claim.speakerId === character.id &&
      character.knowledge.claimIds.includes(claim.id) &&
      claimCanBeDisclosed(caseArtifact, session, character.id, claim.id),
  );
  const relatedClaims = matchingEvidence
    ? allowedClaims.filter((claim) =>
        claim.factIds.some((factId) => matchingEvidence.supportsFactIds.includes(factId)),
      )
    : [];
  const undisclosedClaim = requestedEvidence
    ? undefined
    : allowedClaims.find(
    (claim) => !session.discoveredClaimIds.includes(claim.id),
      );
  const claims = relatedClaims.length > 0 ? relatedClaims : undisclosedClaim ? [undisclosedClaim] : [];
  const utterance =
    matchingEvidence?.description ??
    claims[0]?.statement ??
    `${character.name}停顿了一下：“我能确定的，都已经告诉你了。”`;
  const previousMemory = session.characterStates[character.id]?.memorySummary ?? "";

  return {
    utterance,
    demeanor: claims.length > 0 ? "cooperative" : "guarded",
    disclosedClaimIds: claims.map((claim) => claim.id),
    memorySummary: [previousMemory, `侦探问及：${playerText.slice(0, 120)}`]
      .filter(Boolean)
      .join(" ")
      .slice(-1_200),
    stateDelta: { trust: claims.length > 0 ? 1 : 0, pressure: 0, alertness: 0 },
  };
}

function normalizeDialogueText(value: string) {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}
