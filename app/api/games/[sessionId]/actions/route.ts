import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAccess } from "@/server/access";
import { HttpError, jsonError } from "@/server/http-error";
import { requireAnonymousPlayer } from "@/server/player-session";
import { enforceRateLimit } from "@/server/rate-limit";
import { getServerServices } from "@/server/services";

export const runtime = "nodejs";

const baseCommand = {
  commandId: z.string().min(1).max(160),
  expectedRevision: z.number().int().nonnegative(),
};
const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...baseCommand,
      type: z.literal("investigate"),
      text: z.string().trim().min(1).max(2_000),
      sceneId: z.string().optional(),
      objectId: z.string().optional(),
      characterId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...baseCommand,
      type: z.literal("hint"),
      targetFactId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...baseCommand,
      type: z.literal("present_evidence"),
      characterId: z.string(),
      evidenceId: z.string(),
    })
    .strict(),
  z
    .object({
      ...baseCommand,
      type: z.literal("submit_report"),
      culpritId: z.string().trim().min(1).max(160),
      motiveFactId: z.string(),
      methodFactId: z.string(),
      evidenceIds: z.array(z.string()).min(2).max(20),
      timelineEventIds: z.array(z.string()).max(20),
      reasoning: z.string().trim().min(10).max(4_000),
    })
    .strict(),
  z
    .object({
      ...baseCommand,
      type: z.literal("start_confrontation"),
      suspectId: z.string().trim().min(1).max(160),
    })
    .strict(),
  z
    .object({
      ...baseCommand,
      type: z.literal("resolve_confrontation"),
      culpritId: z.string().trim().min(1).max(160),
      motiveFactId: z.string(),
      methodFactId: z.string(),
      evidenceIds: z.array(z.string()).min(2).max(100),
      timelineEventIds: z.array(z.string()).max(100),
      reasoning: z.string().trim().min(10).max(4_000),
    })
    .strict(),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    await requireAccess();
    const services = await getServerServices();
    const playerId = await requireAnonymousPlayer(services.repository);
    enforceRateLimit("game-action:global", { limit: 1_500, windowMs: 60_000 });
    enforceRateLimit(`game-action:${playerId}`, { limit: 240, windowMs: 60_000 });
    const { sessionId } = await context.params;
    const input = actionSchema.parse(await request.json());

    if (input.type === "investigate") {
      return NextResponse.json(
        await services.game.investigate({ playerId, sessionId, ...input }),
      );
    }
    if (input.type === "hint") {
      return NextResponse.json(
        await services.game.useHint({ playerId, sessionId, ...input }),
      );
    }
    if (input.type === "present_evidence") {
      return NextResponse.json(
        await services.game.showEvidence({ playerId, sessionId, ...input }),
      );
    }
    if (input.type === "submit_report") {
      return NextResponse.json(
        await services.game.submitReport({ playerId, sessionId, ...input }),
      );
    }
    if (input.type === "start_confrontation") {
      return NextResponse.json(
        await services.game.startConfrontation({ playerId, sessionId, ...input }),
      );
    }
    if (input.type === "resolve_confrontation") {
      return NextResponse.json(
        await services.game.resolveConfrontation({ playerId, sessionId, ...input }),
      );
    }
    throw new HttpError(400, "unknown_action", "未知行动。");
  } catch (error) {
    return jsonError(error);
  }
}
