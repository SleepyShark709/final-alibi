import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { startGame } from "@/domain/game/game-runtime";
import { createDatabase, type DatabaseHandle } from "@/infrastructure/db/database";
import { serverSecrets } from "@/infrastructure/db/schema";
import { GameRepository } from "@/infrastructure/persistence/game-repository";

import { createPlayerProtocol } from "./player-protocol";

describe("persistent player protocol key", () => {
  let directory: string;
  let database: DatabaseHandle;
  let url: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "final-alibi-protocol-key-"));
    url = `file:${path.join(directory, "test.sqlite")}`;
    database = await createDatabase({ url });
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("creates only one random key under concurrent initialization and preserves it on reopen", async () => {
    const keys = await Promise.all(Array.from({ length: 4 }, () => new GameRepository(database).getPlayerProtocolKey()));
    expect(new Set(keys).size).toBe(1);
    expect(Buffer.from(keys[0]!, "base64url").length).toBe(32);
    expect(await database.db.select({ name: serverSecrets.name }).from(serverSecrets)).toEqual([{ name: "player_protocol_hmac_v1" }]);
    const session = startGame(tutorialCase);
    const before = createPlayerProtocol(tutorialCase, session, keys[0]!).encode({ id: tutorialCase.culpritId });
    database.close();
    database = await createDatabase({ url });
    const restored = await new GameRepository(database).getPlayerProtocolKey();
    expect(createPlayerProtocol(tutorialCase, session, restored).encode({ id: tutorialCase.culpritId })).toEqual(before);
  });

  it("uses an independent secret in another database, even with identical public case inputs", async () => {
    const other = await createDatabase({ url: `file:${path.join(directory, "other.sqlite")}` });
    try {
      const firstKey = await new GameRepository(database).getPlayerProtocolKey();
      const otherKey = await new GameRepository(other).getPlayerProtocolKey();
      const session = startGame(tutorialCase);
      const first = createPlayerProtocol(tutorialCase, session, firstKey).encode({ id: tutorialCase.culpritId });
      const second = createPlayerProtocol(tutorialCase, session, otherKey).encode({ id: tutorialCase.culpritId });
      expect(first).not.toEqual(second);
      expect(JSON.stringify(first)).not.toContain(firstKey);
    } finally {
      other.close();
    }
  });
});
