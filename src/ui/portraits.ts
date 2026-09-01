import type { CaseArtifact } from "@/domain/case/case-artifact";

type PortraitTags = CaseArtifact["characters"][number]["portraitTags"];

interface PortraitAsset {
  id: number;
  gender: PortraitTags["gender"];
  ageGroup: PortraitTags["ageGroup"];
}

const portraitAssets: PortraitAsset[] = [
  asset(1, "male", "young"),
  asset(2, "female", "young"),
  asset(3, "male", "middle"),
  asset(4, "female", "middle"),
  asset(5, "male", "senior"),
  asset(6, "male", "young"),
  asset(7, "female", "middle"),
  asset(8, "male", "middle"),
  asset(9, "female", "young"),
  asset(10, "male", "middle"),
  asset(11, "female", "young"),
  asset(12, "female", "senior"),
  asset(13, "male", "young"),
  asset(14, "female", "young"),
  asset(15, "male", "middle"),
  asset(16, "female", "middle"),
  asset(17, "male", "child"),
  asset(18, "female", "child"),
  asset(19, "male", "middle"),
  asset(20, "female", "young"),
  asset(21, "male", "middle"),
  asset(22, "male", "middle"),
  asset(23, "male", "middle"),
  asset(24, "female", "young"),
];

export function assignPortraits(
  characters: Array<{ id: string; portraitTags: PortraitTags }>,
  seed: string,
) {
  const unused = new Set(portraitAssets.map((portrait) => portrait.id));
  return Object.fromEntries(
    characters.map((character) => {
      const exact = portraitAssets.filter(
        (portrait) =>
          unused.has(portrait.id) &&
          portrait.gender === character.portraitTags.gender &&
          portrait.ageGroup === character.portraitTags.ageGroup,
      );
      const sameGender = portraitAssets.filter(
        (portrait) =>
          unused.has(portrait.id) &&
          portrait.gender === character.portraitTags.gender,
      );
      const candidates = exact.length > 0 ? exact : sameGender.length > 0 ? sameGender : portraitAssets.filter((portrait) => unused.has(portrait.id));
      const selected = candidates[stableHash(`${seed}:${character.id}`) % candidates.length];
      if (!selected) throw new Error("Portrait pool is exhausted");
      unused.delete(selected.id);
      return [character.id, portraitUrl(selected.id)];
    }),
  );
}

export function portraitUrl(id: number) {
  return `/portraits/portrait-${String(id).padStart(2, "0")}.webp`;
}

function asset(
  id: number,
  gender: PortraitAsset["gender"],
  ageGroup: PortraitAsset["ageGroup"],
): PortraitAsset {
  return { id, gender, ageGroup };
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
