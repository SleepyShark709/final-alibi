import { describe, expect, it } from "vitest";

import { tutorialCase } from "@/content/tutorial/tutorial-case";

import { getPlayerCaseView, recordDialogueTurn, requestHint, startGame } from "./game-runtime";

describe("player boundary challenges", () => {
  it("keeps a discovered lie as an unclassified statement in the player view", () => {
    const claim = tutorialCase.claims.find((candidate) => candidate.id === "claim_li_alibi")!;
    const session = recordDialogueTurn(
      tutorialCase,
      startGame(tutorialCase, { sessionId: "challenge_public_claim" }),
      {
        commandId: "hear_alibi",
        characterId: claim.speakerId,
        playerText: "案发那晚你在哪里？",
        response: {
          utterance: claim.statement,
          demeanor: "guarded",
          disclosedClaimIds: [claim.id],
          memorySummary: "侦探听取了我的不在场说法。",
          stateDelta: { trust: 0, pressure: 0, alertness: 0 },
        },
      },
    ).session;

    const visibleClaim = getPlayerCaseView(tutorialCase, session).claims.find(
      (candidate) => candidate.id === claim.id,
    );
    expect(visibleClaim).toEqual({ id: claim.id, speakerId: claim.speakerId, statement: claim.statement });
    expect(claim.kind).toBe("lie");
    expect(claim.factIds.length).toBeGreaterThan(0);
  });

  it("moves to other unfinished hint chains and stops charging after all hints are exhausted", () => {
    let session = startGame(tutorialCase, { sessionId: "challenge_hint_rotation" });
    const expectedHints = tutorialCase.hintChains.flatMap((chain) => chain.hints);
    const shown: string[] = [];

    for (let index = 0; index < expectedHints.length; index += 1) {
      const result = requestHint(tutorialCase, session, { commandId: `hint_${index}` });
      expect(result.outcome.status).toBe("revealed");
      shown.push(result.outcome.hint!);
      session = result.session;
    }

    expect([...shown].sort()).toEqual([...expectedHints].sort());
    const levels = { ...session.hintLevelsByChainId };
    const final = requestHint(tutorialCase, session, { commandId: "no_more_hints" });
    expect(final.outcome.status).toBe("exhausted");
    expect(final.outcome.hint).toBeUndefined();
    expect(final.session.hintLevelsByChainId).toEqual(levels);
  });
});
