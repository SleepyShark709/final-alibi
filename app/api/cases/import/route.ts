import { NextResponse } from "next/server";
import { z } from "zod";

import { caseArtifactSchema } from "@/domain/case/case-artifact";
import { requireAccess } from "@/server/access";
import { jsonError } from "@/server/http-error";
import { requireAnonymousPlayer } from "@/server/player-session";
import { enforceRateLimit } from "@/server/rate-limit";
import { getServerServices } from "@/server/services";

export const runtime = "nodejs";

const caseBundleSchema = z
  .object({
    format: z.literal("spy-game-case"),
    version: z.literal(1),
    exportedAt: z.string().datetime().optional(),
    caseArtifact: caseArtifactSchema,
  })
  .strict();

export async function POST(request: Request) {
  try {
    await requireAccess();
    const services = await getServerServices();
    const playerId = await requireAnonymousPlayer(services.repository);
    enforceRateLimit("case-import:global", {
      limit: 60,
      windowMs: 60 * 60_000,
    });
    enforceRateLimit(`case-import:${playerId}`, {
      limit: 12,
      windowMs: 60 * 60_000,
    });
    const bundle = caseBundleSchema.parse(await request.json());
    const caseArtifact = await services.repository.registerCase(
      bundle.caseArtifact,
      "imported",
      {
        generationMetadata: {
          importedAt: new Date().toISOString(),
          bundleVersion: bundle.version,
        },
      },
    );
    return NextResponse.json({
      case: {
        id: caseArtifact.id,
        title: caseArtifact.title,
        briefing: caseArtifact.briefing,
        source: "imported" as const,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
