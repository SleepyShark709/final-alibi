import { describe, expect, it } from "vitest";

import { tutorialCase } from "@/content/tutorial/tutorial-case";

import { performInvestigation, startGame } from "./game-runtime";

describe("scene-scoped investigation", () => {
  it("can request records without a location while searching the current scene", () => {
    const session = {
      ...startGame(tutorialCase),
      discoveredEvidenceIds: ["evidence_broken_watch", "evidence_teacup_residue"],
    };
    const result = performInvestigation(tutorialCase, session, {
      commandId: "query_from_study",
      sceneId: "scene_study",
      text: "查询修复室记录",
    });

    expect(result.outcome.discoveredEvidenceIds).toContain("evidence_paint_curing_record");
  });

  it("cannot collect a study object while searching the kitchen", () => {
    const result = performInvestigation(tutorialCase, startGame(tutorialCase), {
      commandId: "search_wrong_scene",
      sceneId: "scene_kitchen",
      text: "翻找书桌抽屉",
    });

    expect(result.outcome.discoveredEvidenceIds).toEqual([]);
  });

  it("still enforces prerequisites on records without a location", () => {
    const artifact = structuredClone(tutorialCase);
    artifact.evidence.find((evidence) => evidence.id === "evidence_paint_curing_record")!
      .discovery.prerequisiteEvidenceIds = ["evidence_smart_lock_log"];
    const result = performInvestigation(artifact, startGame(artifact), {
      commandId: "query_locked_records",
      sceneId: "scene_study",
      text: "查询修复室记录",
    });

    expect(result.outcome.discoveredEvidenceIds).toEqual([]);
  });
});
