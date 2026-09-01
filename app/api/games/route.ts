import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAccess } from "@/server/access";
import { jsonError } from "@/server/http-error";
import { requireAnonymousPlayer } from "@/server/player-session";
import { enforceRateLimit } from "@/server/rate-limit";
import { getServerServices } from "@/server/services";

export const runtime = "nodejs";

const createGameSchema = z.object({ caseId: z.string().min(1) }).strict();

export async function POST(request: Request) {
  try {
    await requireAccess();
    const services = await getServerServices();
    const playerId = await requireAnonymousPlayer(services.repository);
    enforceRateLimit("game-create:global", {
      limit: 200,
      windowMs: 10 * 60_000,
    });
    enforceRateLimit(`game-create:${playerId}`, {
      limit: 20,
      windowMs: 10 * 60_000,
    });
    const input = createGameSchema.parse(await request.json());
    const view = await services.game.startGame(playerId, input.caseId);
    return NextResponse.json({ view }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
