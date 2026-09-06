import { describe, expect, it } from "vitest";

import type { ModelMessage, StructuredModelProvider } from "@/ai/model-provider";
import { caseArtifactSchema, type CaseArtifact } from "@/domain/case/case-artifact";

import { blindSolveSupportsConclusion, createCaseGenerationGraph } from "./case-generation-graph";
import { buildBlindSolveInput } from "./generation-prompts";
import type { BlindSolveResult } from "./generation-schema";
import { makeGeneratedCaseArtifact } from "./testing/make-generated-case-artifact";
import { scriptEvidenceReview } from "./testing/scripted-evidence-review";

type Dossier = {
  suspects: Array<{ id: string; name: string }>;
  witnesses: Array<{ id: string; name: string }>;
  fullyDiscoveredEvidence: Array<{ id: string; name: string; description: string; dialogueUtterance?: string }>;
};

function sourceCase() {
  const source = makeGeneratedCaseArtifact("case_blind_protocol_challenge", "supporting-seed-0");
  return JSON.parse(JSON.stringify(source)
    .replaceAll(source.culpritId, "character_culprit")
    .replaceAll("evidence_housekeeper_testimony", "evidence_culprit_testimony")) as CaseArtifact;
}

function dossierFrom(messages: ModelMessage[]): Dossier {
  return JSON.parse(messages.find((message) => message.role === "user")!.content);
}

// 像模型一样从本次收到的公开姓名/证据名称选编号，不复用生产映射算法。
function answerFrom(draft: CaseArtifact, dossier: Dossier): BlindSolveResult {
  const name = draft.characters.find((person) => person.id === draft.culpritId)!.name;
  const culpritId = dossier.suspects.find((person) => person.name === name)!.id;
  const evidenceIds = dossier.fullyDiscoveredEvidence.map((evidence) => evidence.id);
  return {
    culpritId,
    evidenceIds,
    reasoning: `依据【${evidenceIds[0]}】及其余记录核实${culpritId}；动机、手法和其他人的排除须共同成立。`,
  };
}

describe("independent blind protocol challenges", () => {
  it("hides author IDs without deleting public testimony or leaking the mapping seed", () => {
    const draft = sourceCase();
    const { messages } = buildBlindSolveInput(draft);
    const serialized = JSON.stringify(messages);
    for (const entity of [...draft.characters, ...draft.evidence]) expect(serialized).not.toContain(entity.id);
    expect(serialized).not.toContain(draft.seed);
    const dossier = dossierFrom(messages);
    for (const evidence of draft.evidence) {
      expect(dossier.fullyDiscoveredEvidence).toContainEqual(expect.objectContaining({
        name: evidence.name,
        description: evidence.description,
        ...(evidence.discovery.dialogueUtterance ? { dialogueUtterance: evidence.discovery.dialogueUtterance } : {}),
      }));
    }
  });

  it("repeats the same public request after source array reversal and hidden-answer changes", () => {
    const draft = sourceCase();
    const before = buildBlindSolveInput(draft).messages;
    const changed = structuredClone(draft);
    changed.characters.reverse();
    changed.evidence.reverse();
    changed.culpritId = changed.characters.find((person) => person.roleTier === "suspect" && person.id !== draft.culpritId)!.id;
    changed.solution.culpritId = changed.culpritId;
    expect(buildBlindSolveInput(changed).messages).toEqual(before);
    expect(buildBlindSolveInput(draft).messages).toEqual(before);
  });

  it("restores Chinese-adjacent references and preserves an undecided answer", () => {
    const draft = sourceCase();
    const input = buildBlindSolveInput(draft);
    const answer = answerFrom(draft, dossierFrom(input.messages));
    const restored = input.restoreResult(answer)!;
    expect(restored.culpritId).toBe(draft.culpritId);
    expect(restored.reasoning).toContain(`核实${draft.culpritId}；`);
    expect(restored.reasoning).toContain(`【${restored.evidenceIds[0]}】`);
    expect(blindSolveSupportsConclusion(draft, restored)).toBe(true);
    const undecided = input.restoreResult({ ...answer, culpritId: "" })!;
    expect(undecided.culpritId).toBe("");
    expect(blindSolveSupportsConclusion(draft, undecided)).toBe(false);
  });

  it("rejects witness IDs, cross-kind references, unknown IDs and raw IDs without dropping invalid citations", () => {
    const draft = sourceCase();
    const input = buildBlindSolveInput(draft);
    const dossier = dossierFrom(input.messages);
    const answer = answerFrom(draft, dossier);
    for (const culpritId of [dossier.witnesses[0]!.id, answer.evidenceIds[0]!, "person_unknown", draft.culpritId]) {
      expect(input.restoreResult({ ...answer, culpritId })).toBeNull();
    }
    for (const badId of [answer.culpritId, "exhibit_unknown", draft.evidence[0]!.id]) {
      expect(input.restoreResult({ ...answer, evidenceIds: [...answer.evidenceIds, badId] })).toBeNull();
    }
  });

  it("does not accept references from a previous seed or an evidence card no longer reachable", () => {
    const draft = sourceCase();
    const oldInput = buildBlindSolveInput(draft);
    const oldDossier = dossierFrom(oldInput.messages);
    const oldAnswer = answerFrom(draft, oldDossier);
    expect(buildBlindSolveInput({ ...draft, seed: "different-blind-challenge-seed" }).restoreResult(oldAnswer)).toBeNull();
    const blocked = structuredClone(draft);
    const evidence = blocked.evidence.find((item) => item.id === "evidence_camera_reflection")!;
    evidence.discovery.prerequisiteEvidenceIds = [evidence.id];
    const nextInput = buildBlindSolveInput(blocked);
    expect(dossierFrom(nextInput.messages).fullyDiscoveredEvidence.map((item) => item.name)).not.toContain(evidence.name);
    expect(nextInput.restoreResult(oldAnswer)).toBeNull();
  });

  it("keeps full-proof rejection after otherwise valid alias decoding", () => {
    const draft = sourceCase();
    const input = buildBlindSolveInput(draft);
    const dossier = dossierFrom(input.messages);
    const answer = answerFrom(draft, dossier);
    const neutralId = (id: string) => dossier.fullyDiscoveredEvidence.find((item) => item.name === draft.evidence.find((evidence) => evidence.id === id)!.name)!.id;
    const wrongPerson = dossier.suspects.find((person) => person.id !== answer.culpritId)!.id;
    const replyVariants = [
      { ...answer, culpritId: wrongPerson },
      { ...answer, evidenceIds: [answer.evidenceIds[0]!, answer.evidenceIds[0]!, answer.evidenceIds[0]!] },
      { ...answer, evidenceIds: ["evidence_transfer_ledger", "evidence_brass_bookend", "evidence_culprit_testimony"].map(neutralId) },
      ...[draft.solution.motiveFactId, draft.solution.methodFactId].map((factId) => ({
        ...answer,
        evidenceIds: draft.evidence.filter((evidence) => !evidence.supportsFactIds.includes(factId)).map((evidence) => neutralId(evidence.id)),
      })),
    ];
    for (const reply of replyVariants) {
      const restored = input.restoreResult(reply);
      expect(restored).not.toBeNull();
      expect(blindSolveSupportsConclusion(draft, restored!)).toBe(false);
    }
  });

  it.each(["title", "briefing", "profile", "evidence_description", "utterance"])(
    "does not expose known author references embedded in %s",
    (field) => {
      const draft = sourceCase();
      const text = `相关档案编号（${draft.culpritId}），核对记录【evidence_culprit_testimony】。`;
      if (field === "title") draft.title = text;
      if (field === "briefing") draft.briefing += text;
      if (field === "profile") draft.characters.find((person) => person.id === draft.culpritId)!.publicProfile += text;
      const interview = draft.evidence.find((item) => item.id === "evidence_culprit_testimony")!;
      if (field === "evidence_description") interview.description += text;
      if (field === "utterance") interview.discovery.dialogueUtterance += text;
      const serialized = JSON.stringify(buildBlindSolveInput(draft).messages);
      expect(serialized).not.toContain(draft.culpritId);
      expect(serialized).not.toContain(interview.id);
      expect(serialized).toContain("相关档案编号");
      expect(serialized).toContain("核对记录");
    },
  );

  it("preserves dossier field names when a valid author ID equals a protocol key", () => {
    const draft = sourceCase();
    draft.facts.push({ id: "name", type: "context", statement: "这个隐藏实体的内容不应进入公开卷宗。" });
    expect(caseArtifactSchema.safeParse(draft).success).toBe(true);
    const dossier = dossierFrom(buildBlindSolveInput(draft).messages);
    expect(dossier.suspects[0]).toHaveProperty("name");
    expect(dossier.fullyDiscoveredEvidence[0]).toHaveProperty("name");
    expect(dossier.suspects.map((person) => person.name).sort()).toEqual(
      draft.characters.filter((person) => person.roleTier === "suspect").map((person) => person.name).sort(),
    );
  });

  it("hides IDs embedded in prose without granting access to hidden facts or unreachable evidence", () => {
    const draft = sourceCase();
    const hiddenFactId = "fact_culprit_hid_the_weapon";
    const hiddenStatement = "私有真相内容绝不能因为编号被匿名化而补进公开卷宗。";
    draft.facts.push({ id: hiddenFactId, type: "context", statement: hiddenStatement });
    const blocked = draft.evidence.find((item) => item.id === "evidence_camera_reflection")!;
    blocked.discovery.prerequisiteEvidenceIds = [blocked.id];
    const visible = draft.evidence.find((item) => item.id === "evidence_culprit_testimony")!;
    visible.description += `另有材料索引（${blocked.id}）及记录（${hiddenFactId}）。`;
    const input = buildBlindSolveInput(draft);
    const serialized = JSON.stringify(input.messages);
    expect(serialized).not.toContain(hiddenFactId);
    expect(serialized).not.toContain(hiddenStatement);
    expect(serialized).not.toContain(blocked.id);
    const dossier = dossierFrom(input.messages);
    expect(dossier.fullyDiscoveredEvidence.map((item) => item.name)).not.toContain(blocked.name);
    const shown = dossier.fullyDiscoveredEvidence.find((item) => item.name === visible.name)!;
    const unavailableReference = shown.description.match(/材料索引（([^）]+)）/)![1]!;
    const answer = answerFrom(draft, dossier);
    expect(input.restoreResult({ ...answer, evidenceIds: [...answer.evidenceIds, unavailableReference] })).toBeNull();
  });

  it.each([false, true])("preserves raw model audit while %s denotes an invalid citation", async (invalid) => {
    const draft = sourceCase();
    let sentMessages: ModelMessage[] = [];
    let rawReply: BlindSolveResult | null = null;
    const provider: StructuredModelProvider = {
      async invokeStructured(request) {
        let value: unknown;
        if (request.schemaName === "case_artifact") value = draft;
        else if (request.schemaName === "case_opening_review" || request.schemaName === "case_evidence_review") value = { issues: [] };
        else if (request.schemaName === "blind_case_solution") {
          sentMessages = structuredClone(request.messages);
          rawReply = answerFrom(draft, dossierFrom(request.messages));
          if (invalid) rawReply.evidenceIds[0] = "exhibit_not_provided";
          value = rawReply;
        } else throw new Error(`Unexpected model task: ${request.schemaName}`);
        value = scriptEvidenceReview(request, value);
        return {
          value: request.schema.parse(value),
          model: "independent-challenge-mock",
          usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
          rawResponse: { content: JSON.stringify(value) },
        };
      },
    };
    const result = await createCaseGenerationGraph(provider, { maxArtifactAttempts: 1 }).invoke({
      request: { seed: draft.seed, theme: "封闭空间", difficulty: "standard" },
      attempt: 0, draft: null, validationIssues: [], blindSolve: null,
      finalArtifact: null, rejectionReason: null, formatRepairTargets: [], modelCalls: [],
    });
    expect(sentMessages.length).toBeGreaterThan(0);
    const audit = result.modelCalls.find((call) => call.task === "blind_solve")!;
    expect(audit.request).toEqual({ messages: sentMessages, invocationId: expect.stringMatching(/\S+/u) });
    expect(audit.response).toEqual({ content: JSON.stringify(rawReply) });
    if (invalid) {
      expect(result.finalArtifact).toBeNull();
      expect(result.blindSolve).toBeNull();
      expect(result.validationIssues).toContainEqual(expect.objectContaining({ code: "blind_solver_mismatch" }));
    } else {
      expect(result.finalArtifact?.id).toBe(draft.id);
      expect(result.blindSolve?.culpritId).toBe(draft.culpritId);
      expect(result.blindSolve?.reasoning).toContain(draft.culpritId);
    }
  });
});
