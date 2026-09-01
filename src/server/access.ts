import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

import { HttpError } from "./http-error";

const accessCookieName = "spy_game_access";

export function accessPasswordIsConfigured() {
  return Boolean(process.env.ACCESS_PASSWORD);
}

export async function requireAccess() {
  if (await accessIsGranted()) return;
  throw new HttpError(401, "access_required", "请输入访问口令后继续。");
}

export async function accessIsGranted() {
  if (!accessPasswordIsConfigured()) return true;
  const cookieStore = await cookies();
  const received = cookieStore.get(accessCookieName)?.value;
  const expected = accessCookieValue();
  return Boolean(received && safeEqual(received, expected));
}

export function verifyAccessPassword(password: string) {
  const expected = process.env.ACCESS_PASSWORD;
  return Boolean(expected && safeEqual(password, expected));
}

export async function grantAccess() {
  const cookieStore = await cookies();
  cookieStore.set(accessCookieName, accessCookieValue(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

function accessCookieValue() {
  const password = process.env.ACCESS_PASSWORD ?? "local-open-access";
  return createHmac("sha256", password)
    .update("spy-game-shared-access-v1")
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
