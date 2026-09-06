import { NextResponse } from "next/server";

import { requireAccess } from "@/server/access";
import { jsonError } from "@/server/http-error";
import { createPlayerProtocol } from "@/server/player-protocol";
import { requireAnonymousPlayer } from "@/server/player-session";
import { getServerServices } from "@/server/services";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    await requireAccess();
    const services = await getServerServices();
    const playerId = await requireAnonymousPlayer(services.repository);
    const { sessionId } = await context.params;
    const game = await services.repository.loadGame(playerId, sessionId);
    const review = await services.game.getReview(playerId, sessionId);
    return NextResponse.json(createPlayerProtocol(game.caseArtifact, game.session, await services.repository.getPlayerProtocolKey()).encode({ review }));
  } catch (error) {
    return jsonError(error);
  }
}
