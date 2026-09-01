import { cookies } from "next/headers";

import type { GameRepository } from "@/infrastructure/persistence/game-repository";

import { HttpError } from "./http-error";

const playerCookieName = "spy_game_player";

export async function ensureAnonymousPlayer(repository: GameRepository) {
  const cookieStore = await cookies();
  const existingToken = cookieStore.get(playerCookieName)?.value;
  if (existingToken) {
    const playerId = await repository.authenticateAnonymousPlayer(existingToken);
    if (playerId) return playerId;
  }

  const identity = await repository.createAnonymousIdentity();
  cookieStore.set(playerCookieName, identity.accessToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return identity.playerId;
}

export async function requireAnonymousPlayer(repository: GameRepository) {
  const cookieStore = await cookies();
  const token = cookieStore.get(playerCookieName)?.value;
  if (!token) throw new HttpError(401, "player_required", "请重新载入游戏。");
  const playerId = await repository.authenticateAnonymousPlayer(token);
  if (!playerId) throw new HttpError(401, "player_required", "本地玩家身份已失效。");
  return playerId;
}
