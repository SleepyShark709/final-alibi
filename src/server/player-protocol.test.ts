import { describe, expect, it } from "vitest";

import { tutorialCase } from "@/content/tutorial/tutorial-case";
import { getPlayerCaseView, startGame } from "@/domain/game/game-runtime";

import { createPlayerProtocol } from "./player-protocol";

const protocolKey = "independent-unit-player-protocol-key";

describe("player entity protocol", () => {
  it("keeps aliases stable across progress, entity order and hidden-answer changes", () => {
    const artifact = structuredClone(tutorialCase);
    const session = startGame(artifact);
    const first = createPlayerProtocol(artifact, session, protocolKey);
    const changed = structuredClone(artifact);
    changed.characters.reverse();
    changed.evidence.reverse();
    changed.culpritId = changed.characters.find((person) => person.roleTier === "suspect" && person.id !== artifact.culpritId)!.id;
    changed.solution.culpritId = changed.culpritId;
    const second = createPlayerProtocol(changed, { ...session, discoveredEvidenceIds: artifact.evidence.map((evidence) => evidence.id) }, protocolKey);
    const references = { characterId: artifact.culpritId, evidenceIds: artifact.evidence.map((evidence) => evidence.id) };
    expect(first.encode(references)).toEqual(second.encode(references));
    const view = first.encode(getPlayerCaseView(artifact, session));
    expect(view.session.id).toBe(session.id);
    expect(view.session.revision).toBe(session.revision);
    expect(view.case.id).toBe(artifact.id);
    expect(JSON.stringify(view)).not.toContain(artifact.culpritId);
    expect(JSON.stringify(view)).not.toContain(artifact.seed);
  });

  it("changes only complete known ID values and prose references, preserving keys and command identity", () => {
    const artifact = structuredClone(tutorialCase);
    artifact.facts.push({ id: "name", type: "context", statement: "隐藏事实不应被补入视图。" });
    const session = startGame(artifact, { sessionId: artifact.culpritId });
    const protocol = createPlayerProtocol(artifact, session, protocolKey);
    const alias = protocol.encode({ id: artifact.culpritId }).id;
    const value = {
      name: "正常叙事与姓名不变",
      session: { id: session.id, revision: 7 },
      commandId: artifact.culpritId,
      text: `核实${artifact.culpritId}；（${artifact.culpritId}）与${artifact.culpritId}_extra以及prefix_${artifact.culpritId}、1${artifact.culpritId}、_${artifact.culpritId}。`,
    };
    expect(protocol.encode(value)).toEqual({
      ...value,
      text: `核实${alias}；（${alias}）与${artifact.culpritId}_extra以及prefix_${artifact.culpritId}、1${artifact.culpritId}、_${artifact.culpritId}。`,
    });
    expect(protocol.decodeText(`核实${alias}；`)).toBe(`核实${artifact.culpritId}；`);
  });

  it("preserves ordinary words and historical event enums while encoding their explicit references", () => {
    const artifact = structuredClone(tutorialCase);
    artifact.facts.push(...["investigation", "closed"].map((id) => ({ id, type: "context" as const, statement: "隐藏的协议同名实体。" })));
    const protocol = createPlayerProtocol(artifact, startGame(artifact), protocolKey);
    const alias = protocol.encode({ id: artifact.culpritId }).id;
    const event = { type: "investigation", commandId: artifact.culpritId, summary: `仍在核对${artifact.culpritId}。`,
      data: { characterId: artifact.culpritId, status: "closed", text: `closed 只是普通词；核实${artifact.culpritId}。` } };
    expect(protocol.encode({ review: { playerEvents: [event] } })).toEqual({ review: { playerEvents: [{
      ...event, summary: `仍在核对${alias}。`, data: { ...event.data, characterId: alias, text: `closed 只是普通词；核实${alias}。` },
    }] } });
    expect(protocol.decodeText(event.data.text.replaceAll(artifact.culpritId, alias))).toBe(event.data.text);
  });

  it.each(["li_culprit", "murderer_chen", "admin_02"])("keeps non-protocol prose literal while allowing the same entity through its structural alias: %s", (id) => {
    const artifact = JSON.parse(JSON.stringify(tutorialCase).replaceAll(tutorialCase.culpritId, id)) as typeof tutorialCase;
    const protocol = createPlayerProtocol(artifact, startGame(artifact), protocolKey);
    const command = { characterId: id, text: `请核实 ${id}。` };
    const encoded = protocol.encode(command);
    expect(encoded.characterId).not.toBe(id);
    expect(encoded.text).toBe(command.text);
    expect(protocol.decodeCommand(encoded)).toEqual(command);
  });

  it("rejects original, hidden, wrong-kind and other-case references without revealing which exists", () => {
    const artifact = structuredClone(tutorialCase);
    const session = startGame(artifact);
    const protocol = createPlayerProtocol(artifact, session, protocolKey);
    const other = { ...artifact, id: "case_other_protocol", seed: "other_protocol_seed" };
    const otherProtocol = createPlayerProtocol(other, startGame(other), protocolKey);
    const hiddenEvidence = artifact.evidence.find((evidence) => !session.discoveredEvidenceIds.includes(evidence.id))!;
    const invalid = [artifact.culpritId, "person_unknown", otherProtocol.encode({ id: artifact.culpritId }).id, protocol.encode({ id: hiddenEvidence.id }).id];
    for (const characterId of invalid) {
      expect(() => protocol.decodeCommand({ characterId })).toThrow("引用的选项已失效");
    }
    expect(() => protocol.decodeCommand({ evidenceId: protocol.encode({ id: hiddenEvidence.id }).id })).toThrow("引用的选项已失效");
    expect(() => protocol.decodeText(`核实${artifact.culpritId}`)).toThrow("引用的选项已失效");
    expect(() => protocol.decodeText(`查看${protocol.encode({ id: hiddenEvidence.id }).id}`)).toThrow("引用的选项已失效");
    const current = protocol.encode({ characterId: artifact.culpritId, commandId: artifact.culpritId, expectedRevision: 0 });
    expect(protocol.decodeCommand(current)).toEqual({ characterId: artifact.culpritId, commandId: artifact.culpritId, expectedRevision: 0 });
  });
});
