import { describe, expect, it } from "vitest";

import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { getPlayerCaseView, startGame } from "@/domain/game/game-runtime";

import { createPlayerProtocol } from "./player-protocol";

const protocolKey = "player-display-order-regression-key";

function opening(artifact = tutorialCase) {
  const session = startGame(artifact);
  const protocol = createPlayerProtocol(artifact, session, protocolKey);
  return { protocol, view: protocol.encode(getPlayerCaseView(artifact, session)) };
}

describe("player character display order", () => {
  it("does not reveal author order or change when the hidden answer changes", () => {
    const { view } = opening();
    const changed = structuredClone(tutorialCase);
    changed.characters.reverse();
    changed.culpritId = changed.characters.find((person) => person.roleTier === "suspect" && person.id !== tutorialCase.culpritId)!.id;
    changed.solution.culpritId = changed.culpritId;
    const second = opening(changed).view;
    expect(second.characters.map((person) => person.id)).toEqual(view.characters.map((person) => person.id));
    expect(second.reportOptions.suspects.map((person) => person.id)).toEqual(view.reportOptions.suspects.map((person) => person.id));
    expect(opening().view.characters).toEqual(view.characters);
  });

  it("does not put an author-first culprit in a fixed player-facing position across cases", () => {
    const positions = new Set<number>();
    for (let index = 0; index < 16; index += 1) {
      const artifact = structuredClone(tutorialCase);
      artifact.seed = `player-order-regression-${index}`;
      artifact.characters.sort((left, right) => Number(right.id === artifact.culpritId) - Number(left.id === artifact.culpritId));
      const { protocol, view } = opening(artifact);
      const culpritAlias = protocol.encode({ characterId: artifact.culpritId }).characterId;
      positions.add(view.reportOptions.suspects.findIndex((person) => person.id === culpritAlias));
      const visibleSuspects = view.characters.filter((person) => person.roleTier === "suspect").map((person) => person.id);
      expect(view.reportOptions.suspects.filter((person) => visibleSuspects.includes(person.id)).map((person) => person.id)).toEqual(visibleSuspects);
    }
    expect(positions.has(-1)).toBe(false);
    expect(positions.size).toBeGreaterThan(1);
  });

  it("preserves evidence acquisition order", () => {
    const { protocol } = opening();
    const evidence = [...tutorialCase.evidence].reverse().map(({ id, name }) => ({ id, name }));
    expect(protocol.encode({ evidence }).evidence.map((entry) => entry.name)).toEqual(evidence.map((entry) => entry.name));
  });
});
