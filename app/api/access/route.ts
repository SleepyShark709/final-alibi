import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  accessIsGranted,
  accessPasswordIsConfigured,
  grantAccess,
  verifyAccessPassword,
} from "@/server/access";
import { HttpError, jsonError } from "@/server/http-error";
import { enforceRateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    required: accessPasswordIsConfigured(),
    granted: await accessIsGranted(),
  });
}

const accessRequestSchema = z.object({ password: z.string().min(1).max(200) }).strict();

export async function POST(request: NextRequest) {
  try {
    enforceRateLimit("access:global", {
      limit: 200,
      windowMs: 15 * 60_000,
    });
    enforceRateLimit(`access:${clientAddress(request)}`, {
      limit: 10,
      windowMs: 15 * 60_000,
    });
    if (!accessPasswordIsConfigured()) {
      return NextResponse.json({ granted: true });
    }
    const input = accessRequestSchema.parse(await request.json());
    if (!verifyAccessPassword(input.password)) {
      throw new HttpError(401, "invalid_access_password", "访问口令不正确。");
    }
    await grantAccess();
    return NextResponse.json({ granted: true });
  } catch (error) {
    return jsonError(error);
  }
}

function clientAddress(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "local"
  );
}
