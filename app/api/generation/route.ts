import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAccess } from "@/server/access";
import { HttpError, jsonError } from "@/server/http-error";
import { requireAnonymousPlayer } from "@/server/player-session";
import { enforceRateLimit } from "@/server/rate-limit";
import { getServerServices } from "@/server/services";

export const runtime = "nodejs";

const generationSchema = z
  .object({
    seed: z.string().trim().min(4).max(120).optional(),
    theme: z.string().trim().min(1).max(200),
    locationHint: z.string().trim().max(120).optional(),
    difficulty: z.enum(["easy", "standard", "hard"]),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    await requireAccess();
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new HttpError(
        503,
        "model_not_configured",
        "尚未配置 DeepSeek API Key，当前可以游玩教程案件。",
      );
    }
    const services = await getServerServices();
    const playerId = await requireAnonymousPlayer(services.repository);
    enforceRateLimit("generation:global", {
      limit: 20,
      windowMs: 60 * 60_000,
    });
    enforceRateLimit(`generation:${playerId}`, {
      limit: 3,
      windowMs: 60 * 60_000,
    });
    const input = generationSchema.parse(await request.json());
    const queued = await services.generation.enqueue(playerId, input);
    return NextResponse.json(queued, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}
