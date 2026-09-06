import { describe, expect, it } from "vitest";

import type { CaseArtifact } from "@/domain/case/case-artifact";
import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";

import { buildCaseRepairMessages } from "./generation-prompts";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";

describe("generation repair proof summary", () => {
  it("distinguishes existing exclusions outside the required chain from absent proof", () => {
    const draft = makeDraft();
    const innocentId = "character_shen_lan";
    const existingIds = draft.evidence.filter((item) => item.excludesCharacterIds.includes(innocentId)).map((item) => item.id);
    expect(existingIds.length).toBeGreaterThan(0);
    draft.solution.requiredEvidenceIds = draft.solution.requiredEvidenceIds.filter((id) => !existingIds.includes(id));

    const summary = summaryFor(draft);
    expect(summary.full).toMatchObject({ status: "unique", candidateIds: [draft.culpritId] });
    expect(summary.required).toMatchObject({ status: "ambiguous", candidateIds: expect.arrayContaining([draft.culpritId, innocentId]) });
    expect(summary.exclusions).toContainEqual(expect.objectContaining({
      characterId: innocentId,
      existingEvidenceIds: existingIds,
      fullEvidenceIds: existingIds,
      requiredEvidenceIds: [],
      requiredGap: "outside_required",
    }));
  });

  it("reports a missing exclusion when the entire draft has none for a remaining suspect", () => {
    const draft = makeDraft();
    const innocentId = "character_shen_lan";
    for (const evidence of draft.evidence) {
      evidence.excludesCharacterIds = evidence.excludesCharacterIds.filter((id) => id !== innocentId);
    }

    const summary = summaryFor(draft);
    expect(summary.full).toMatchObject({ status: "ambiguous", candidateIds: expect.arrayContaining([draft.culpritId, innocentId]) });
    expect(summary.exclusions).toContainEqual({
      characterId: innocentId, existingEvidenceIds: [], fullEvidenceIds: [],
      requiredEvidenceIds: [], zeroInterviewEvidenceIds: [], requiredGap: "missing",
    });
  });

  it("reports missing motive support without falsely asking for an existing culprit implication", () => {
    const draft = makeDraft();
    for (const evidence of draft.evidence) {
      evidence.supportsFactIds = evidence.supportsFactIds.filter((id) => id !== draft.solution.motiveFactId);
    }

    const summary = summaryFor(draft);
    expect(summary.full).toMatchObject({
      status: "unsupported", candidateIds: [draft.culpritId],
      missingSupportFactIds: [draft.solution.motiveFactId], missingImplicationCharacterIds: [],
    });
    expect(summary.required.missingSupportFactIds).toEqual([draft.solution.motiveFactId]);
    expect(summary.required.missingImplicationCharacterIds).toEqual([]);
    const issue = validatePublishableCaseArtifact(draft).issues.find((item) => item.code === "incomplete_solution")!;
    expect(issue.message).toContain(`missing supportsFactIds: ${draft.solution.motiveFactId}`);
    expect(issue.message).not.toContain("missing implicatesCharacterIds");
    expect(issue.message).not.toContain("also require evidence implicating");
  });

  it("reports a truly missing implication without falsely asking for supported motive or method facts", () => {
    const draft = makeDraft();
    for (const evidence of draft.evidence) {
      evidence.implicatesCharacterIds = evidence.implicatesCharacterIds.filter((id) => id !== draft.culpritId);
    }

    expect(summaryFor(draft).full).toMatchObject({
      status: "unsupported", missingSupportFactIds: [], missingImplicationCharacterIds: [draft.culpritId],
    });
    const issue = validatePublishableCaseArtifact(draft).issues.find((item) => item.code === "incomplete_solution")!;
    expect(issue.message).toContain(`missing implicatesCharacterIds: ${draft.culpritId}`);
    expect(issue.message).not.toContain("missing supportsFactIds");
  });

  it("keeps a record obtained through an interview out of the zero-interview proof", () => {
    const draft = makeDraft();
    const record = draft.evidence.find((item) => item.discovery.method !== "interview" && item.excludesCharacterIds.length > 0)!;
    const innocentId = record.excludesCharacterIds[0]!;
    const interview = draft.evidence.find((item) => item.id === "evidence_housekeeper_testimony")!;
    for (const evidence of draft.evidence) {
      if (evidence.id !== record.id) evidence.excludesCharacterIds = evidence.excludesCharacterIds.filter((id) => id !== innocentId);
    }
    interview.discovery.dialogueUtterance += "我可以提供这份记录的备份调阅授权。";
    record.description = `经罗芳提供备份调阅授权，实际取得记录。${record.description}`;
    record.discovery.prerequisiteEvidenceIds = [interview.id];

    const summary = summaryFor(draft);
    expect(summary.full.status).toBe("unique");
    expect(summary.zeroInterview).toMatchObject({ status: "ambiguous", candidateIds: expect.arrayContaining([innocentId]) });
    expect(summary.exclusions).toContainEqual(expect.objectContaining({
      characterId: innocentId, existingEvidenceIds: [record.id], fullEvidenceIds: [record.id], zeroInterviewEvidenceIds: [],
    }));
  });
});

function makeDraft() {
  return structuredClone(makeGeneratedCaseArtifact("case_repair_summary", "supporting-seed-0"));
}

function summaryFor(draft: CaseArtifact) {
  const messages = buildCaseRepairMessages({
    request: { seed: draft.seed, theme: "现代宅邸", difficulty: "standard" },
    draft,
    issues: validatePublishableCaseArtifact(draft).issues,
  });
  return JSON.parse(messages[1]!.content).repairSnapshot.proofSummary;
}
