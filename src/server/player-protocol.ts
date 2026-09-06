import { createHmac } from "node:crypto";

import type { CaseArtifact } from "@/domain/case/case-artifact";
import { getPlayerCaseView, type GameSession } from "@/domain/game/game-runtime";

import { HttpError } from "./http-error";

type EntityKind = "character" | "evidence" | "fact" | "scene" | "object" | "timeline" | "claim" | "rule" | "hint";

const prefixes: Record<EntityKind, string> = {
  character: "person", evidence: "exhibit", fact: "fact", scene: "scene", object: "object",
  timeline: "event", claim: "claim", rule: "rule", hint: "hint",
};
const identifierPattern = /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]*/gu;
const referenceNamespacePattern = /^(?:person|character|suspect|victim|witness|culprit|exhibit|evidence|fact|scene|object|event|timeline|claim|rule|unlock|hint|analysis)_[a-z0-9_]+$/u;
const proseFields = new Set([
  "title", "briefing", "place", "name", "occupation", "publicProfile", "privateProfile", "statement", "description",
  "playerText", "utterance", "text", "reasoning", "memorySummary", "hint", "rebuttal", "confession", "summary",
  "strengths", "gaps", "primaryAction",
]);

/** 仅转换玩家协议；案卷、命令和存档始终保留原始 ID。 */
export function createPlayerProtocol(caseArtifact: CaseArtifact, session: GameSession, protocolKey: string) {
  const view = getPlayerCaseView(caseArtifact, session);
  const groups: Record<EntityKind, Array<{ id: string }>> = {
    character: caseArtifact.characters,
    evidence: caseArtifact.evidence,
    fact: caseArtifact.facts,
    scene: caseArtifact.scenes,
    object: caseArtifact.scenes.flatMap((scene) => scene.objects),
    timeline: caseArtifact.timeline,
    claim: caseArtifact.claims,
    rule: caseArtifact.unlockRules,
    hint: caseArtifact.hintChains,
  };
  const aliases = new Map<string, string>();
  const originals = new Map<string, { id: string; kind: EntityKind }>();
  for (const [kind, entities] of Object.entries(groups) as Array<[EntityKind, Array<{ id: string }>]>) {
    for (const { id } of entities) {
      const digest = createHmac("sha256", protocolKey)
        .update(JSON.stringify(["player-protocol-v2", caseArtifact.id, caseArtifact.seed, kind, id]))
        .digest("hex").slice(0, 20);
      const alias = `${prefixes[kind]}_${digest}`;
      aliases.set(id, alias);
      originals.set(alias, { id, kind });
    }
  }

  const ids = (entities: Array<{ id: string }>) => entities.map((entity) => entity.id);
  const visible: Record<EntityKind, Set<string>> = {
    character: new Set(ids([...view.characters, ...view.reportOptions.suspects, ...(view.case.victim ? [view.case.victim] : [])])),
    evidence: new Set(ids(view.evidence)),
    fact: new Set(ids(view.deductions)),
    scene: new Set(ids(view.scenes)),
    object: new Set(ids(view.scenes.flatMap((scene) => scene.objects))),
    timeline: new Set(ids(view.reportOptions.timelineEvents)),
    claim: new Set(ids(view.claims)),
    rule: new Set(),
    hint: new Set(),
  };
  const commandReferences: Record<string, { kind: EntityKind; permitted: ReadonlySet<string> }> = {
    characterId: { kind: "character", permitted: new Set(ids(view.characters)) },
    sceneId: { kind: "scene", permitted: visible.scene },
    objectId: { kind: "object", permitted: visible.object },
    targetFactId: { kind: "fact", permitted: visible.fact },
    suspectId: { kind: "character", permitted: new Set(ids(view.reportOptions.suspects)) },
    culpritId: { kind: "character", permitted: new Set(ids(view.reportOptions.suspects)) },
    motiveFactId: { kind: "fact", permitted: new Set(ids(view.reportOptions.motiveFacts)) },
    methodFactId: { kind: "fact", permitted: new Set(ids(view.reportOptions.methodFacts)) },
    evidenceId: { kind: "evidence", permitted: visible.evidence },
    evidenceIds: { kind: "evidence", permitted: visible.evidence },
    timelineEventIds: { kind: "timeline", permitted: visible.timeline },
  };
  const invalidReference = () => new HttpError(400, "invalid_player_reference", "引用的选项已失效，请刷新案卷后重试。");

  function encode<T>(value: T): T {
    const transform = (item: unknown, key = "", parentKey = ""): unknown => {
      if (key === "commandId" || key === "sessionId" || key === "caseId" || (key === "id" && (parentKey === "session" || parentKey === "case"))) return item;
      if (typeof item === "string") {
        const field = key || parentKey;
        if (field === "id" || /Ids?$/u.test(field)) return aliases.get(item) ?? item;
        if (proseFields.has(field) || /(?:Name|Names|Statement|Statements)$/u.test(field)) {
          // 与入站使用相同的引用语法，避免把玩家猜测的普通词回显为隐藏实体别名。
          return item.replace(identifierPattern, (identifier) => referenceNamespacePattern.test(identifier) ? aliases.get(identifier) ?? identifier : identifier);
        }
        return item;
      }
      if (Array.isArray(item)) {
        const entries = item.map((entry) => transform(entry, "", key));
        if ((key === "characters" || key === "suspects") && entries.every(
          (entry): entry is { id: string; roleTier?: string } => Boolean(
            entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string" && entry.id.startsWith("person_"),
          ),
        )) {
          const roleOrder: Record<string, number> = { victim: 0, suspect: 1, witness: 2 };
          // 隐藏生成时的排列习惯；同一案卷内的顺序随服务端别名保持稳定。
          return entries.sort((left, right) =>
            (roleOrder[left.roleTier ?? ""] ?? 3) - (roleOrder[right.roleTier ?? ""] ?? 3)
            || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
          );
        }
        return entries;
      }
      if (item && typeof item === "object") {
        return Object.fromEntries(Object.entries(item).map(([field, entry]) => [field, transform(entry, field, key)]));
      }
      return item;
    };
    return transform(value) as T;
  }

  function decodeEntityId(alias: string, kind: EntityKind, permitted: ReadonlySet<string> = visible[kind]) {
    const original = originals.get(alias);
    if (!original || original.kind !== kind || !permitted.has(original.id)) throw invalidReference();
    return original.id;
  }

  function decodeText(text: string) {
    return text.replace(identifierPattern, (identifier) => {
      const original = originals.get(identifier);
      if (original) return decodeEntityId(identifier, original.kind);
      // 协议命名空间内的原 ID 和未知引用同样拒绝；admin_02 等普通案内文本不受影响。
      if (referenceNamespacePattern.test(identifier)) throw invalidReference();
      return identifier;
    });
  }

  function decodeCommand<T extends Record<string, unknown>>(input: T): T {
    return Object.fromEntries(Object.entries(input).map(([field, value]) => {
      const reference = commandReferences[field];
      if (reference && value !== undefined) {
        const decode = (id: string) => decodeEntityId(id, reference.kind, reference.permitted);
        return [field, Array.isArray(value) ? (value as string[]).map(decode) : decode(value as string)];
      }
      return [field, (field === "text" || field === "reasoning") && typeof value === "string" ? decodeText(value) : value];
    })) as T;
  }

  return { encode, decodeEntityId, decodeText, decodeCommand };
}
