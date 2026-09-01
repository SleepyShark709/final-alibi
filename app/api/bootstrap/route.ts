import { NextResponse } from "next/server";

import { requireAccess } from "@/server/access";
import { jsonError } from "@/server/http-error";
import { ensureAnonymousPlayer } from "@/server/player-session";
import { getServerServices } from "@/server/services";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAccess();
    const services = await getServerServices();
    const playerId = await ensureAnonymousPlayer(services.repository);
    const lobby = await services.game.getLobby(playerId);
    return NextResponse.json({
      ...lobby,
      capabilities: {
        randomGeneration: Boolean(process.env.DEEPSEEK_API_KEY),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
