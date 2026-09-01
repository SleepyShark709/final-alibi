import { describe, expect, it } from "vitest";

import { tutorialCase } from "@/content/tutorial/tutorial-case";

import { assignPortraits } from "./portraits";

describe("portrait assignment", () => {
  it("is deterministic and never duplicates a portrait within one case", () => {
    const first = assignPortraits(tutorialCase.characters, tutorialCase.seed);
    const second = assignPortraits(tutorialCase.characters, tutorialCase.seed);
    const urls = Object.values(first);

    expect(first).toEqual(second);
    expect(new Set(urls).size).toBe(tutorialCase.characters.length);
    expect(urls.every((url) => /^\/portraits\/portrait-\d{2}\.webp$/.test(url))).toBe(
      true,
    );
  });
});
