import type { CaseArtifact } from "@/domain/case/case-artifact";

/**
 * 纯确定性游戏状态机。这里不访问数据库、不调用模型：每个命令把冻结的案件账本和
 * 当前 session 转成下一份 session + 一个领域事件，持久化和并发控制由 GameRepository 负责。
 */
export type GameStatus = "investigating" | "closed";

export interface GameEvent {
  sequence: number;
  commandId: string;
  at: string;
  type:
    | "game_started"
    | "investigation"
    | "dialogue"
    | "hint_used"
    | "evidence_presented"
    | "case_report_submitted";
  summary: string;
  data: Record<string, string | number | boolean | string[] | null>;
}

export type CharacterDemeanor =
  | "calm"
  | "guarded"
  | "evasive"
  | "agitated"
  | "cooperative"
  | "defiant";

export interface CharacterRuntimeState {
  trust: number;
  pressure: number;
  alertness: number;
  exchangeCount: number;
  memorySummary: string;
}

export interface DialogueExchange {
  commandId: string;
  at: string;
  characterId: string;
  playerText: string;
  utterance: string;
  demeanor: CharacterDemeanor;
  disclosedClaimIds: string[];
  discoveredEvidenceIds: string[];
}

/**
 * 可序列化的玩家业务真相。它只保存玩家已经获得的状态，不能复制 CaseArtifact 的私密字段到这里。
 */
export interface GameSession {
  schemaVersion: 1;
  id: string;
  caseId: string;
  status: GameStatus;
  revision: number;
  startedAt: string;
  updatedAt: string;
  unlockedSceneIds: string[];
  unlockedCharacterIds: string[];
  discoveredEvidenceIds: string[];
  discoveredClaimIds: string[];
  presentedEvidenceByCharacter: Record<string, string[]>;
  characterStates: Record<string, CharacterRuntimeState>;
  dialogue: DialogueExchange[];
  hintLevelsByChainId: Record<string, number>;
  processedCommandIds: string[];
  events: GameEvent[];
  reportCommandId?: string;
  report?: CaseReportResult;
}

export interface StartGameOptions {
  sessionId?: string;
  now?: string;
}

export interface InvestigationCommand {
  commandId: string;
  text: string;
  sceneId?: string;
  objectId?: string;
  characterId?: string;
  now?: string;
}

export interface InvestigationOutcome {
  status: "discovered" | "already_discovered" | "locked" | "not_found" | "duplicate";
  discoveredEvidenceIds: string[];
  unlockedSceneIds: string[];
  unlockedCharacterIds: string[];
}

export interface HintCommand {
  commandId: string;
  targetFactId?: string;
  now?: string;
}

export interface HintOutcome {
  status: "revealed" | "exhausted" | "not_found" | "duplicate";
  hint?: string;
  level?: number;
  targetFactId?: string;
}

export interface PresentEvidenceCommand {
  commandId: string;
  characterId: string;
  evidenceId: string;
  now?: string;
}

export interface PresentEvidenceOutcome {
  status:
    | "presented"
    | "already_presented"
    | "character_locked"
    | "evidence_not_discovered"
    | "duplicate";
}

export interface ValidatedCharacterResponse {
  utterance: string;
  demeanor: CharacterDemeanor;
  disclosedClaimIds: string[];
  memorySummary: string;
  stateDelta: {
    trust: number;
    pressure: number;
    alertness: number;
  };
}

export interface DialogueCommand {
  commandId: string;
  characterId: string;
  playerText: string;
  response: ValidatedCharacterResponse;
  now?: string;
}

export interface DialogueOutcome {
  status: "responded" | "duplicate";
  response?: ValidatedCharacterResponse;
  discoveredEvidenceIds: string[];
  unlockedSceneIds: string[];
  unlockedCharacterIds: string[];
}

export interface CaseReportSubmission {
  culpritId: string;
  motiveFactId: string;
  methodFactId: string;
  evidenceIds: string[];
  timelineEventIds: string[];
  reasoning: string;
}

export interface CaseReportBreakdown {
  culprit: number;
  motive: number;
  method: number;
  evidence: number;
  timeline: number;
  hintPenalty: number;
}

export interface CaseReportResult {
  verdict: "solved" | "unsolved";
  score: number;
  breakdown: CaseReportBreakdown;
  submitted: CaseReportSubmission;
  correct: {
    culprit: boolean;
    motive: boolean;
    method: boolean;
    evidence: boolean;
    timeline: boolean;
  };
  missedEvidenceIds: string[];
  missedTimelineEventIds: string[];
  feedback?: {
    summary: string;
    strengths: string[];
    gaps: string[];
  };
}

export interface SubmitCaseReportCommand extends CaseReportSubmission {
  commandId: string;
  now?: string;
}

export interface SubmitCaseReportOutcome {
  status: "submitted" | "duplicate" | "already_closed";
  report: CaseReportResult;
}

/** 为一个已冻结案件创建初始调查状态和 sequence 0 的开始事件。 */
export function startGame(
  caseArtifact: CaseArtifact,
  options: StartGameOptions = {},
): GameSession {
  const now = options.now ?? new Date().toISOString();
  const characterUnlockTargets = new Set(
    caseArtifact.unlockRules
      .filter((rule) => rule.targetType === "character")
      .map((rule) => rule.targetId),
  );
  const sessionId =
    options.sessionId ?? `game_${crypto.randomUUID().replaceAll("-", "")}`;

  return {
    schemaVersion: 1,
    id: sessionId,
    caseId: caseArtifact.id,
    status: "investigating",
    revision: 0,
    startedAt: now,
    updatedAt: now,
    unlockedSceneIds: caseArtifact.scenes
      .filter((scene) => scene.initiallyUnlocked)
      .map((scene) => scene.id),
    unlockedCharacterIds: caseArtifact.characters
      .filter(
        (character) =>
          (character.roleTier === "suspect" || character.roleTier === "witness") &&
          !characterUnlockTargets.has(character.id),
      )
      .map((character) => character.id),
    discoveredEvidenceIds: [],
    discoveredClaimIds: [],
    presentedEvidenceByCharacter: {},
    characterStates: Object.fromEntries(
      caseArtifact.characters
        .filter((character) => character.roleTier !== "victim")
        .map((character) => [
          character.id,
          {
            trust: 45,
            pressure: 10,
            alertness: character.roleTier === "suspect" ? 25 : 10,
            exchangeCount: 0,
            memorySummary: "",
          },
        ]),
    ),
    dialogue: [],
    hintLevelsByChainId: {},
    processedCommandIds: [],
    events: [
      {
        sequence: 0,
        commandId: `start_${sessionId}`,
        at: now,
        type: "game_started",
        summary: `开始调查《${caseArtifact.title}》`,
        data: { caseId: caseArtifact.id },
      },
    ],
  };
}

export function recordDialogueTurn(
  caseArtifact: CaseArtifact,
  session: GameSession,
  command: DialogueCommand,
): { session: GameSession; outcome: DialogueOutcome } {
  // LLM guard 已做过检查；这里再次按账本重算可公开 claim 和可获得证据，形成最终写库前的防线。
  assertActiveCase(caseArtifact, session);
  if (session.processedCommandIds.includes(command.commandId)) {
    return {
      session,
      outcome: {
        status: "duplicate",
        discoveredEvidenceIds: [],
        unlockedSceneIds: [],
        unlockedCharacterIds: [],
      },
    };
  }

  const character = caseArtifact.characters.find(
    (candidate) => candidate.id === command.characterId,
  );
  if (!character || !session.unlockedCharacterIds.includes(command.characterId)) {
    throw new Error(`Character "${command.characterId}" is not available for dialogue`);
  }
  const allowedClaimIds = new Set(
    caseArtifact.claims
      .filter(
        (claim) =>
          claim.speakerId === character.id &&
          character.knowledge.claimIds.includes(claim.id) &&
          claimCanBeDisclosed(caseArtifact, session, character.id, claim.id),
      )
      .map((claim) => claim.id),
  );
  const invalidClaimId = command.response.disclosedClaimIds.find(
    (claimId) => !allowedClaimIds.has(claimId),
  );
  if (invalidClaimId) {
    throw new Error(
      `Character "${character.id}" cannot disclose claim "${invalidClaimId}"`,
    );
  }

  const newlyDiscoveredEvidenceIds = caseArtifact.evidence
    .filter(
      (evidence) =>
        evidence.discovery.method === "interview" &&
        evidence.discovery.characterId === character.id &&
        !session.discoveredEvidenceIds.includes(evidence.id) &&
        evidenceIsAvailable(caseArtifact, session, evidence.id) &&
        investigationIntentMatches(caseArtifact, evidence, {
          commandId: command.commandId,
          characterId: character.id,
          text: command.playerText,
        }, { allowInterview: true }),
    )
    .map((evidence) => evidence.id);
  const discoveredEvidenceIds = unique([
    ...session.discoveredEvidenceIds,
    ...newlyDiscoveredEvidenceIds,
  ]);
  const unlocks = resolveUnlocks(caseArtifact, session, discoveredEvidenceIds);
  const previousState = session.characterStates[character.id] ?? {
    trust: 45,
    pressure: 10,
    alertness: 25,
    exchangeCount: 0,
    memorySummary: "",
  };
  const nextCharacterState: CharacterRuntimeState = {
    trust: boundedPercent(previousState.trust + command.response.stateDelta.trust),
    pressure: boundedPercent(
      previousState.pressure + command.response.stateDelta.pressure,
    ),
    alertness: boundedPercent(
      previousState.alertness + command.response.stateDelta.alertness,
    ),
    exchangeCount: previousState.exchangeCount + 1,
    memorySummary: command.response.memorySummary.trim(),
  };
  const now = command.now ?? new Date().toISOString();
  const exchange: DialogueExchange = {
    commandId: command.commandId,
    at: now,
    characterId: character.id,
    playerText: command.playerText.trim(),
    utterance: command.response.utterance.trim(),
    demeanor: command.response.demeanor,
    disclosedClaimIds: unique(command.response.disclosedClaimIds),
    discoveredEvidenceIds: newlyDiscoveredEvidenceIds,
  };
  const nextSession = appendEvent(
    {
      ...session,
      discoveredEvidenceIds,
      discoveredClaimIds: unique([
        ...session.discoveredClaimIds,
        ...command.response.disclosedClaimIds,
      ]),
      unlockedSceneIds: unlocks.sceneIds,
      unlockedCharacterIds: unlocks.characterIds,
      characterStates: {
        ...session.characterStates,
        [character.id]: nextCharacterState,
      },
      dialogue: [...session.dialogue, exchange],
    },
    command.commandId,
    now,
    "dialogue",
    `${character.name}: ${exchange.utterance}`,
    {
      characterId: character.id,
      demeanor: exchange.demeanor,
      disclosedClaimIds: exchange.disclosedClaimIds,
      discoveredEvidenceIds: exchange.discoveredEvidenceIds,
      unlockedSceneIds: unlocks.newSceneIds,
      unlockedCharacterIds: unlocks.newCharacterIds,
    },
  );

  return {
    session: nextSession,
    outcome: {
      status: "responded",
      response: command.response,
      discoveredEvidenceIds: newlyDiscoveredEvidenceIds,
      unlockedSceneIds: unlocks.newSceneIds,
      unlockedCharacterIds: unlocks.newCharacterIds,
    },
  };
}

export function performInvestigation(
  caseArtifact: CaseArtifact,
  session: GameSession,
  command: InvestigationCommand,
): { session: GameSession; outcome: InvestigationOutcome } {
  // 自然语言/点击物件只是匹配入口；是否真的获得证据始终由 evidenceIsAvailable 决定。
  assertActiveCase(caseArtifact, session);
  if (session.processedCommandIds.includes(command.commandId)) {
    return {
      session,
      outcome: emptyInvestigationOutcome("duplicate"),
    };
  }

  const matchedEvidence = caseArtifact.evidence.filter((evidence) =>
    investigationIntentMatches(caseArtifact, evidence, command),
  );
  const availableEvidence = matchedEvidence.filter((evidence) =>
    evidenceIsAvailable(caseArtifact, session, evidence.id),
  );
  const newlyDiscoveredIds = availableEvidence
    .filter((evidence) => !session.discoveredEvidenceIds.includes(evidence.id))
    .map((evidence) => evidence.id);
  const alreadyDiscovered = matchedEvidence.some((evidence) =>
    session.discoveredEvidenceIds.includes(evidence.id),
  );
  const status: InvestigationOutcome["status"] =
    newlyDiscoveredIds.length > 0
      ? "discovered"
      : alreadyDiscovered
        ? "already_discovered"
        : matchedEvidence.length > 0
          ? "locked"
          : "not_found";
  const discoveredEvidenceIds = unique([
    ...session.discoveredEvidenceIds,
    ...newlyDiscoveredIds,
  ]);
  const unlocks = resolveUnlocks(caseArtifact, session, discoveredEvidenceIds);
  const now = command.now ?? new Date().toISOString();
  const nextSession = appendEvent(
    {
      ...session,
      discoveredEvidenceIds,
      unlockedSceneIds: unlocks.sceneIds,
      unlockedCharacterIds: unlocks.characterIds,
    },
    command.commandId,
    now,
    "investigation",
    investigationSummary(status, command.text, newlyDiscoveredIds),
    {
      text: command.text,
      status,
      discoveredEvidenceIds: newlyDiscoveredIds,
      unlockedSceneIds: unlocks.newSceneIds,
      unlockedCharacterIds: unlocks.newCharacterIds,
    },
  );

  return {
    session: nextSession,
    outcome: {
      status,
      discoveredEvidenceIds: newlyDiscoveredIds,
      unlockedSceneIds: unlocks.newSceneIds,
      unlockedCharacterIds: unlocks.newCharacterIds,
    },
  };
}

export function requestHint(
  caseArtifact: CaseArtifact,
  session: GameSession,
  command: HintCommand,
): { session: GameSession; outcome: HintOutcome } {
  assertActiveCase(caseArtifact, session);
  if (session.processedCommandIds.includes(command.commandId)) {
    return { session, outcome: { status: "duplicate" } };
  }

  const discoveredFactIds = new Set(
    caseArtifact.evidence
      .filter((evidence) => session.discoveredEvidenceIds.includes(evidence.id))
      .flatMap((evidence) => evidence.supportsFactIds),
  );
  const hintChain = command.targetFactId
    ? caseArtifact.hintChains.find(
        (candidate) => candidate.targetFactId === command.targetFactId,
      )
    : caseArtifact.hintChains.find(
        (candidate) => !discoveredFactIds.has(candidate.targetFactId),
      ) ?? caseArtifact.hintChains[0];
  const currentLevel = hintChain
    ? (session.hintLevelsByChainId[hintChain.id] ?? 0)
    : 0;
  const status: HintOutcome["status"] = !hintChain
    ? "not_found"
    : currentLevel >= hintChain.hints.length
      ? "exhausted"
      : "revealed";
  const hint = status === "revealed" ? hintChain?.hints[currentLevel] : undefined;
  const hintLevelsByChainId =
    status === "revealed" && hintChain
      ? { ...session.hintLevelsByChainId, [hintChain.id]: currentLevel + 1 }
      : session.hintLevelsByChainId;
  const now = command.now ?? new Date().toISOString();
  const nextSession = appendEvent(
    { ...session, hintLevelsByChainId },
    command.commandId,
    now,
    "hint_used",
    hint ?? "没有更多提示",
    {
      status,
      level: status === "revealed" ? currentLevel + 1 : currentLevel,
      targetFactId: hintChain?.targetFactId ?? null,
    },
  );

  return {
    session: nextSession,
    outcome: {
      status,
      hint,
      level: hintChain ? currentLevel + (status === "revealed" ? 1 : 0) : undefined,
      targetFactId: hintChain?.targetFactId,
    },
  };
}

export function presentEvidence(
  caseArtifact: CaseArtifact,
  session: GameSession,
  command: PresentEvidenceCommand,
): { session: GameSession; outcome: PresentEvidenceOutcome } {
  assertActiveCase(caseArtifact, session);
  if (session.processedCommandIds.includes(command.commandId)) {
    return { session, outcome: { status: "duplicate" } };
  }

  const alreadyPresented =
    session.presentedEvidenceByCharacter[command.characterId]?.includes(
      command.evidenceId,
    ) ?? false;
  const status: PresentEvidenceOutcome["status"] = !session.unlockedCharacterIds.includes(
    command.characterId,
  )
    ? "character_locked"
    : !session.discoveredEvidenceIds.includes(command.evidenceId)
      ? "evidence_not_discovered"
      : alreadyPresented
        ? "already_presented"
        : "presented";
  const presentedEvidenceByCharacter =
    status === "presented"
      ? {
          ...session.presentedEvidenceByCharacter,
          [command.characterId]: unique([
            ...(session.presentedEvidenceByCharacter[command.characterId] ?? []),
            command.evidenceId,
          ]),
        }
      : session.presentedEvidenceByCharacter;
  const now = command.now ?? new Date().toISOString();
  const nextSession = appendEvent(
    { ...session, presentedEvidenceByCharacter },
    command.commandId,
    now,
    "evidence_presented",
    `${command.characterId}: ${status}`,
    {
      status,
      characterId: command.characterId,
      evidenceId: command.evidenceId,
    },
  );

  return { session: nextSession, outcome: { status } };
}

export function submitCaseReport(
  caseArtifact: CaseArtifact,
  session: GameSession,
  command: SubmitCaseReportCommand,
): { session: GameSession; outcome: SubmitCaseReportOutcome } {
  // 结案不可逆，评分完全确定性；玩家猜出的未发现事实或未形成完整链条的时间线不会计分。
  assertCaseMatches(caseArtifact, session);
  if (
    session.status === "closed" &&
    session.report &&
    session.reportCommandId === command.commandId
  ) {
    return {
      session,
      outcome: { status: "duplicate", report: session.report },
    };
  }
  if (session.status === "closed" && session.report) {
    return {
      session,
      outcome: { status: "already_closed", report: session.report },
    };
  }

  const submitted: CaseReportSubmission = {
    culpritId: command.culpritId,
    motiveFactId: command.motiveFactId,
    methodFactId: command.methodFactId,
    evidenceIds: unique(command.evidenceIds),
    timelineEventIds: unique(command.timelineEventIds),
    reasoning: command.reasoning.trim(),
  };
  const suspectIds = new Set(
    caseArtifact.characters
      .filter((character) => character.roleTier === "suspect")
      .map((character) => character.id),
  );
  if (!suspectIds.has(submitted.culpritId)) {
    throw new Error("an early accusation requires a named suspect");
  }
  if (submitted.reasoning.length < 10) {
    throw new Error("an early accusation requires a reasoned statement");
  }
  const countedEvidenceIds = submitted.evidenceIds.filter((id) =>
    session.discoveredEvidenceIds.includes(id),
  );
  if (countedEvidenceIds.length < 2) {
    throw new Error("an early accusation requires at least two discovered evidence items");
  }
  const discoveredFactIds = new Set(
    caseArtifact.evidence
      .filter((evidence) => session.discoveredEvidenceIds.includes(evidence.id))
      .flatMap((evidence) => evidence.supportsFactIds),
  );
  const hasCompleteEvidenceChain = caseArtifact.solution.requiredEvidenceIds.every(
    (id) => session.discoveredEvidenceIds.includes(id),
  );
  const validTimelineEventIds = new Set(
    caseArtifact.timeline.map((event) => event.id),
  );
  const countedTimelineEventIds = hasCompleteEvidenceChain
    ? submitted.timelineEventIds.filter((id) => validTimelineEventIds.has(id))
    : [];
  const missedEvidenceIds = caseArtifact.solution.requiredEvidenceIds.filter(
    (id) => !countedEvidenceIds.includes(id),
  );
  const missedTimelineEventIds = caseArtifact.solution.requiredTimelineEventIds.filter(
    (id) => !countedTimelineEventIds.includes(id),
  );
  const correct = {
    culprit: submitted.culpritId === caseArtifact.solution.culpritId,
    motive:
      discoveredFactIds.has(submitted.motiveFactId) &&
      submitted.motiveFactId === caseArtifact.solution.motiveFactId,
    method:
      discoveredFactIds.has(submitted.methodFactId) &&
      submitted.methodFactId === caseArtifact.solution.methodFactId,
    evidence: missedEvidenceIds.length === 0,
    timeline: missedTimelineEventIds.length === 0,
  };
  const hintPenalty = Math.min(
    15,
    Object.values(session.hintLevelsByChainId).reduce((total, level) => total + level, 0) *
      2,
  );
  const breakdown: CaseReportBreakdown = {
    culprit: correct.culprit ? 40 : 0,
    motive: correct.motive ? 15 : 0,
    method: correct.method ? 15 : 0,
    evidence: Math.round(
      20 *
        ratio(
          caseArtifact.solution.requiredEvidenceIds.length - missedEvidenceIds.length,
          caseArtifact.solution.requiredEvidenceIds.length,
        ),
    ),
    timeline: Math.round(
      10 *
        ratio(
          caseArtifact.solution.requiredTimelineEventIds.length -
            missedTimelineEventIds.length,
          caseArtifact.solution.requiredTimelineEventIds.length,
        ),
    ),
    hintPenalty,
  };
  // 提前结案以“是否正确锁定真凶”为胜负条件；其余项目只决定卷宗完整度与得分。
  // 这保留一次性指认的风险，同时允许玩家在证据尚未完全闭环时结束案件。
  const solved = correct.culprit;
  const completeDossier = Object.values(correct).every(Boolean);
  const report: CaseReportResult = {
    verdict: solved ? "solved" : "unsolved",
    score: Math.max(
      0,
      breakdown.culprit +
        breakdown.motive +
        breakdown.method +
        breakdown.evidence +
        breakdown.timeline -
        breakdown.hintPenalty,
    ),
    breakdown,
    submitted,
    correct,
    missedEvidenceIds,
    missedTimelineEventIds,
  };
  const now = command.now ?? new Date().toISOString();
  const nextSession = appendEvent(
    {
      ...session,
      status: "closed",
      reportCommandId: command.commandId,
      report,
    },
    command.commandId,
    now,
    "case_report_submitted",
    solved
      ? completeDossier
        ? "案件侦破，卷宗完整"
        : "提前结案，已锁定真凶"
      : "结案报告存在错误",
    { verdict: report.verdict, score: report.score, completeDossier },
  );

  return {
    session: nextSession,
    outcome: { status: "submitted", report },
  };
}

export function getPlayerCaseView(
  caseArtifact: CaseArtifact,
  session: GameSession,
) {
  // 这是唯一面向普通玩家的投影：绝不能把真凶、私密档案、未发现证据或完整时间线直接透出。
  assertCaseMatches(caseArtifact, session);
  const victim = caseArtifact.characters.find(
    (character) => character.id === caseArtifact.victimId,
  );
  const discoveredFactIds = new Set(
    caseArtifact.evidence
      .filter((evidence) => session.discoveredEvidenceIds.includes(evidence.id))
      .flatMap((evidence) => evidence.supportsFactIds),
  );
  const hasCompleteEvidenceChain = caseArtifact.solution.requiredEvidenceIds.every(
    (evidenceId) => session.discoveredEvidenceIds.includes(evidenceId),
  );

  return {
    session: {
      id: session.id,
      status: session.status,
      revision: session.revision,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      hintCount: Object.values(session.hintLevelsByChainId).reduce(
        (total, level) => total + level,
        0,
      ),
      report: session.report,
    },
    case: {
      id: caseArtifact.id,
      title: caseArtifact.title,
      briefing: caseArtifact.briefing,
      setting: caseArtifact.setting,
      victim: victim ? publicCharacter(victim) : null,
    },
    characters: caseArtifact.characters
      .filter((character) => session.unlockedCharacterIds.includes(character.id))
      .map((character) => ({
        ...publicCharacter(character),
        presentedEvidenceIds:
          session.presentedEvidenceByCharacter[character.id] ?? [],
      })),
    scenes: caseArtifact.scenes
      .filter((scene) => session.unlockedSceneIds.includes(scene.id))
      .map((scene) => ({
        id: scene.id,
        name: scene.name,
        description: scene.description,
        objects: scene.objects.map((object) => ({
          id: object.id,
          name: object.name,
          description: object.description,
        })),
      })),
    evidence: caseArtifact.evidence
      .filter((evidence) => session.discoveredEvidenceIds.includes(evidence.id))
      .map((evidence) => ({
        id: evidence.id,
        name: evidence.name,
        description: evidence.description,
        kind: evidence.kind,
      })),
    claims: caseArtifact.claims.filter((claim) =>
      session.discoveredClaimIds.includes(claim.id),
    ),
    dialogue: session.dialogue.map((exchange) => ({
      commandId: exchange.commandId,
      at: exchange.at,
      characterId: exchange.characterId,
      playerText: exchange.playerText,
      utterance: exchange.utterance,
      demeanor: exchange.demeanor,
      disclosedClaimIds: exchange.disclosedClaimIds,
      discoveredEvidenceIds: exchange.discoveredEvidenceIds,
    })),
    deductions: caseArtifact.facts
      .filter((fact) => discoveredFactIds.has(fact.id))
      .map((fact) => ({ id: fact.id, type: fact.type, statement: fact.statement })),
    reportOptions: {
      suspects: caseArtifact.characters
        .filter((character) => character.roleTier === "suspect")
        .map(publicCharacter),
      motiveFacts: caseArtifact.facts
        .filter((fact) => fact.type === "motive" && discoveredFactIds.has(fact.id))
        .map((fact) => ({ id: fact.id, statement: fact.statement })),
      methodFacts: caseArtifact.facts
        .filter((fact) => fact.type === "method" && discoveredFactIds.has(fact.id))
        .map((fact) => ({ id: fact.id, statement: fact.statement })),
      timelineEvents: hasCompleteEvidenceChain
        ? caseArtifact.timeline.map((event) => ({
            id: event.id,
            timestamp: event.timestamp,
            description: redactTimelineForPlayer(caseArtifact, event.description),
          }))
        : [],
      hasCompleteEvidenceChain,
    },
  };
}

export function getCaseReview(caseArtifact: CaseArtifact, session: GameSession) {
  assertCaseMatches(caseArtifact, session);
  if (session.status !== "closed" || !session.report) {
    return null;
  }
  const characterNameById = new Map(
    caseArtifact.characters.map((character) => [character.id, character.name]),
  );
  const factById = new Map(caseArtifact.facts.map((fact) => [fact.id, fact]));

  return {
    culprit: caseArtifact.characters.find(
      (character) => character.id === caseArtifact.solution.culpritId,
    ),
    motive: factById.get(caseArtifact.solution.motiveFactId),
    method: factById.get(caseArtifact.solution.methodFactId),
    timeline: caseArtifact.timeline,
    lies: caseArtifact.claims
      .filter((claim) => claim.kind === "lie")
      .map((claim) => ({
        ...claim,
        speakerName: characterNameById.get(claim.speakerId) ?? claim.speakerId,
      })),
    evidence: caseArtifact.evidence.map((evidence) => ({
      ...evidence,
      discovered: session.discoveredEvidenceIds.includes(evidence.id),
    })),
    playerEvents: session.events,
    report: session.report,
  };
}

function investigationIntentMatches(
  caseArtifact: CaseArtifact,
  evidence: CaseArtifact["evidence"][number],
  command: InvestigationCommand,
  options: { allowInterview?: boolean } = {},
): boolean {
  // A testimony must come from an actual dialogue turn. Even a correctly guessed
  // alias in the free-form search box must not turn into a shortcut around a witness.
  if (evidence.discovery.method === "interview" && !options.allowInterview) {
    return false;
  }
  if (command.sceneId && evidence.discovery.sceneId !== command.sceneId) {
    return false;
  }
  if (command.objectId && evidence.discovery.objectId !== command.objectId) {
    return false;
  }
  if (command.characterId && evidence.discovery.characterId !== command.characterId) {
    return false;
  }
  if (command.objectId) {
    return true;
  }

  const input = normalizeAction(command.text);
  if (input.length < 2) {
    return false;
  }
  const aliases = [...evidence.discovery.actionAliases];
  if (evidence.discovery.objectId) {
    const object = caseArtifact.scenes
      .flatMap((scene) => scene.objects)
      .find((candidate) => candidate.id === evidence.discovery.objectId);
    if (object) aliases.push(object.name);
  }

  return aliases.some((alias) => {
    const normalizedAlias = normalizeAction(alias);
    return (
      input.includes(normalizedAlias) ||
      normalizedAlias.includes(input) ||
      actionKeywordsOverlap(input, normalizedAlias)
    );
  });
}

export function evidenceIsAvailable(
  caseArtifact: CaseArtifact,
  session: GameSession,
  evidenceId: string,
): boolean {
  // 同一判定同时服务于搜证、对话证词与 fallback，避免任何入口绕过前置证据和解锁规则。
  const evidence = caseArtifact.evidence.find((candidate) => candidate.id === evidenceId);
  if (!evidence) return false;
  const discovered = new Set(session.discoveredEvidenceIds);
  const targetRules = caseArtifact.unlockRules.filter(
    (rule) => rule.targetType === "evidence" && rule.targetId === evidenceId,
  );
  const targetUnlocked =
    targetRules.length === 0 || targetRules.some((rule) => ruleSatisfied(rule, discovered));

  return (
    targetUnlocked &&
    evidence.discovery.prerequisiteEvidenceIds.every((id) => discovered.has(id)) &&
    (!evidence.discovery.sceneId ||
      session.unlockedSceneIds.includes(evidence.discovery.sceneId)) &&
    (!evidence.discovery.characterId ||
      session.unlockedCharacterIds.includes(evidence.discovery.characterId))
  );
}

export function claimCanBeDisclosed(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  claimId: string,
): boolean {
  // 证词可说不等于角色知道：关联的 interview 证据尚未可得时，角色必须保持沉默。
  const character = caseArtifact.characters.find(
    (candidate) => candidate.id === characterId,
  );
  const claim = caseArtifact.claims.find((candidate) => candidate.id === claimId);
  if (
    !character ||
    !claim ||
    claim.speakerId !== character.id ||
    !character.knowledge.claimIds.includes(claim.id)
  ) {
    return false;
  }

  const linkedInterviewEvidence = caseArtifact.evidence.filter(
    (evidence) =>
      evidence.discovery.method === "interview" &&
      evidence.discovery.characterId === character.id &&
      evidence.supportsFactIds.some((factId) => claim.factIds.includes(factId)),
  );
  return (
    linkedInterviewEvidence.length === 0 ||
    linkedInterviewEvidence.some(
      (evidence) =>
        session.discoveredEvidenceIds.includes(evidence.id) ||
        evidenceIsAvailable(caseArtifact, session, evidence.id),
    )
  );
}

function resolveUnlocks(
  caseArtifact: CaseArtifact,
  session: GameSession,
  discoveredEvidenceIds: string[],
) {
  const discovered = new Set(discoveredEvidenceIds);
  const sceneIds = new Set(session.unlockedSceneIds);
  const characterIds = new Set(session.unlockedCharacterIds);
  let changed = true;

  while (changed) {
    changed = false;
    for (const rule of caseArtifact.unlockRules) {
      if (!ruleSatisfied(rule, discovered)) continue;
      if (rule.targetType === "scene" && !sceneIds.has(rule.targetId)) {
        sceneIds.add(rule.targetId);
        changed = true;
      }
      if (rule.targetType === "character" && !characterIds.has(rule.targetId)) {
        characterIds.add(rule.targetId);
        changed = true;
      }
    }
  }

  return {
    sceneIds: [...sceneIds],
    characterIds: [...characterIds],
    newSceneIds: [...sceneIds].filter((id) => !session.unlockedSceneIds.includes(id)),
    newCharacterIds: [...characterIds].filter(
      (id) => !session.unlockedCharacterIds.includes(id),
    ),
  };
}

function ruleSatisfied(
  rule: CaseArtifact["unlockRules"][number],
  discovered: ReadonlySet<string>,
) {
  return (
    rule.allEvidenceIds.every((id) => discovered.has(id)) &&
    (rule.anyEvidenceIds.length === 0 ||
      rule.anyEvidenceIds.some((id) => discovered.has(id)))
  );
}

function appendEvent(
  session: GameSession,
  commandId: string,
  at: string,
  type: GameEvent["type"],
  summary: string,
  data: GameEvent["data"],
): GameSession {
  // 仓储会断言“一条命令恰好推进一个 revision 并追加一个同 commandId 的事件”。
  return {
    ...session,
    revision: session.revision + 1,
    updatedAt: at,
    processedCommandIds: [...session.processedCommandIds, commandId],
    events: [
      ...session.events,
      {
        sequence: session.events.length,
        commandId,
        at,
        type,
        summary,
        data,
      },
    ],
  };
}

function assertCaseMatches(caseArtifact: CaseArtifact, session: GameSession) {
  if (session.caseId !== caseArtifact.id) {
    throw new Error(
      `Game session "${session.id}" belongs to case "${session.caseId}", not "${caseArtifact.id}"`,
    );
  }
}

function assertActiveCase(caseArtifact: CaseArtifact, session: GameSession) {
  assertCaseMatches(caseArtifact, session);
  if (session.status !== "investigating") {
    throw new Error(`Game session "${session.id}" is already closed`);
  }
}

function emptyInvestigationOutcome(
  status: InvestigationOutcome["status"],
): InvestigationOutcome {
  return {
    status,
    discoveredEvidenceIds: [],
    unlockedSceneIds: [],
    unlockedCharacterIds: [],
  };
}

function investigationSummary(
  status: InvestigationOutcome["status"],
  text: string,
  evidenceIds: string[],
) {
  return status === "discovered"
    ? `${text}: 发现 ${evidenceIds.join(", ")}`
    : `${text}: ${status}`;
}

function publicCharacter(character: CaseArtifact["characters"][number]) {
  return {
    id: character.id,
    name: character.name,
    roleTier: character.roleTier,
    occupation: character.occupation,
    publicProfile: character.publicProfile,
    portraitTags: character.portraitTags,
  };
}

function redactTimelineForPlayer(
  caseArtifact: CaseArtifact,
  description: string,
) {
  // 完整证据链达成后才展示时间线；仍将人名泛化，避免它替玩家直接指认嫌疑人。
  return caseArtifact.characters.reduce((redacted, character) => {
    const replacement =
      character.roleTier === "victim"
        ? "受害者"
        : character.roleTier === "suspect"
          ? "某位嫌疑人"
          : "一名证人";
    return redacted.replaceAll(character.name, replacement);
  }, description);
}

function normalizeAction(value: string) {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function actionKeywordsOverlap(input: string, alias: string) {
  const inputKeywords = new Set(stripActionFillers(input));
  const aliasKeywords = new Set(stripActionFillers(alias));
  if (inputKeywords.size === 0 || aliasKeywords.size === 0) return false;

  const commonCount = [...aliasKeywords].filter((value) =>
    inputKeywords.has(value),
  ).length;
  return commonCount >= 2 && commonCount / aliasKeywords.size >= 0.5;
}

function stripActionFillers(value: string) {
  const phrases = [
    "有没有",
    "帮我",
    "我想",
    "我要",
    "一下",
    "看看",
    "询问",
    "追问",
    "问问",
    "检查",
    "查看",
    "调查",
    "核实",
    "调取",
    "搜索",
    "搜查",
    "分析",
    "到底",
    "是否",
  ];
  let stripped = value;
  for (const phrase of phrases) stripped = stripped.replaceAll(phrase, "");
  return [...stripped].filter((character) => !"的了把在和与请你我他她它是".includes(character));
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function boundedPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
