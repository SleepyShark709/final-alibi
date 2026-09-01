import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAccess } from "@/server/access";
import { jsonError } from "@/server/http-error";
import { requireAnonymousPlayer } from "@/server/player-session";
import { enforceRateLimit } from "@/server/rate-limit";
import { getServerServices } from "@/server/services";

export const runtime = "nodejs";
export const maxDuration = 120;

const dialogueSchema = z
  .object({
    commandId: z.string().min(1).max(160),
    expectedRevision: z.number().int().nonnegative(),
    characterId: z.string(),
    text: z.string().trim().min(1).max(2_000),
  })
  .strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    await requireAccess();
    const services = await getServerServices();
    const playerId = await requireAnonymousPlayer(services.repository);
    enforceRateLimit("dialogue:global", { limit: 300, windowMs: 60_000 });
    enforceRateLimit(`dialogue:${playerId}`, { limit: 60, windowMs: 60_000 });
    const { sessionId } = await context.params;
    const input = dialogueSchema.parse(await request.json());
    const result = await services.dialogue.talk({ playerId, sessionId, ...input });
    const view = await services.game.getGame(playerId, sessionId);
    return NextResponse.json({
      replayed: result.replayed,
      outcome: {
        status: result.outcome.status,
        response: result.outcome.response
          ? {
              utterance: result.outcome.response.utterance,
              demeanor: result.outcome.response.demeanor,
              disclosedClaimIds: result.outcome.response.disclosedClaimIds,
            }
          : undefined,
        discoveredEvidenceIds: result.outcome.discoveredEvidenceIds,
        unlockedSceneIds: result.outcome.unlockedSceneIds,
        unlockedCharacterIds: result.outcome.unlockedCharacterIds,
      },
      view,
    });
  } catch (error) {
    return jsonError(error);
  }
}
