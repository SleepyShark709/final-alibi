import type { CaseArtifact } from "@/domain/case/case-artifact";
import { solveCaseWithEvidenceIds } from "@/domain/case/case-solver";
import { publicCharacterProfile } from "@/domain/case/public-information";
import {
  findInitiallyDiscoverableSceneEvidenceIds,
  findReachableEvidenceIds,
} from "@/domain/case/evidence-reachability";

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
    | "confrontation_started"
    | "confrontation_rebutted"
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

export interface ConfrontationState {
  suspectId: string;
  rebuttal: string;
  confession?: string;
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
  confrontation?: ConfrontationState;
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

export interface StartConfrontationCommand {
  commandId: string;
  suspectId: string;
  now?: string;
}

export interface StartConfrontationOutcome {
  status: "started" | "duplicate";
  confrontation?: ConfrontationState;
}

export interface ResolveConfrontationCommand extends CaseReportSubmission {
  commandId: string;
  now?: string;
}

export interface ResolveConfrontationOutcome {
  status: "confessed" | "rebutted" | "duplicate";
  rebuttal?: string;
  confession?: string;
  report?: CaseReportResult;
}

/** 结案后向玩家公开的客观事实；调查中绝不能使用这个投影。 */
export interface DeclassifiedFact {
  id: string;
  type: CaseArtifact["facts"][number]["type"];
  statement: string;
}

export interface DeclassifiedClaim {
  id: string;
  speakerId: string;
  speakerName: string;
  kind: CaseArtifact["claims"][number]["kind"];
  statement: string;
  facts: DeclassifiedFact[];
}

export interface CaseReviewEvidenceReference {
  id: string;
  name: string;
}

export interface CaseReviewUnlockRequirement {
  targetType: CaseArtifact["unlockRules"][number]["targetType"];
  targetName: string;
  allEvidence: CaseReviewEvidenceReference[];
  anyEvidence: CaseReviewEvidenceReference[];
}

export interface CaseReviewAcquisition {
  method: CaseArtifact["evidence"][number]["discovery"]["method"];
  primaryAction: string;
  scene?: { id: string; name: string };
  object?: { id: string; name: string };
  character?: { id: string; name: string; occupation: string };
  prerequisiteEvidence: CaseReviewEvidenceReference[];
  unlockRequirements: CaseReviewUnlockRequirement[];
}

export interface CaseReviewFollowUp {
  characterId: string;
  characterName: string;
  claimId?: string;
  claimStatement?: string;
  factStatements: string[];
}

export interface DeclassifiedEvidence {
  id: string;
  name: string;
  description: string;
  kind: CaseArtifact["evidence"][number]["kind"];
  critical: boolean;
  discovered: boolean;
  includedInReport: boolean;
  requiredForSolution: boolean;
  supportsFacts: DeclassifiedFact[];
  contradictsClaims: DeclassifiedClaim[];
  implicatesCharacters: Array<{ id: string; name: string }>;
  excludesCharacters: Array<{ id: string; name: string }>;
  acquisition: CaseReviewAcquisition;
  followUps: CaseReviewFollowUp[];
}

export interface DeclassifiedCharacter {
  id: string;
  name: string;
  roleTier: CaseArtifact["characters"][number]["roleTier"];
  occupation: string;
  publicProfile: string;
  privateProfile: string;
  secrets: DeclassifiedFact[];
  lieRules: Array<{
    strategy: CaseArtifact["characters"][number]["lieRules"][number]["strategy"];
    coverStatement: string;
    fact: DeclassifiedFact;
  }>;
}

export interface CaseReview {
  culprit?: CaseArtifact["characters"][number];
  motive?: CaseArtifact["facts"][number];
  method?: CaseArtifact["facts"][number];
  facts: DeclassifiedFact[];
  characters: DeclassifiedCharacter[];
  claims: DeclassifiedClaim[];
  timeline: CaseArtifact["timeline"];
  lies: DeclassifiedClaim[];
  evidence: DeclassifiedEvidence[];
  playerEvents: GameEvent[];
  confession?: string;
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

  const questionMatchedEvidence = findMatchedInterviewEvidence(
    caseArtifact,
    session,
    character.id,
    command.playerText,
  );
  const responseMatchedEvidence = findResponseDisclosedInterviewEvidence(
    caseArtifact,
    session,
    character.id,
    command.response.utterance,
  );
  // 玩家问题可以触发预先声明的访谈证据；但如果模型已经给出了足够具体、可与
  // 账本逐字核验的证言，回答本身才是更可靠的事实来源。两条路径最多选一条，
  // 让本轮台词与实际新增线索始终一一对应。
  const newlyDiscoveredEvidenceIds = [
    responseMatchedEvidence[0] ?? questionMatchedEvidence[0],
  ]
    .filter(
      (evidence): evidence is CaseArtifact["evidence"][number] =>
        Boolean(evidence) && !session.discoveredEvidenceIds.includes(evidence.id),
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

/**
 * 将自由文本审讯映射到当前角色可给出的访谈证据。新案件优先使用明确的
 * dialogueAliases；旧案件缺少该字段时，仅对“看见谁/目击谁”这类高置信问法
 * 做窄兼容，避免一句泛泛追问意外解锁整条证据链。
 */
export function findMatchedInterviewEvidence(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  playerText: string,
): CaseArtifact["evidence"] {
  const normalizedQuestion = normalizeInterviewIntent(playerText);
  if (normalizedQuestion.length < 2) return [];

  const availableEvidence = caseArtifact.evidence.filter(
    (evidence) =>
      evidence.discovery.method === "interview" &&
      evidence.discovery.characterId === characterId &&
      evidenceIsAvailable(caseArtifact, session, evidence.id),
  );
  const directMatches = availableEvidence.filter((evidence) =>
    interviewIntentMatches(caseArtifact, evidence, normalizedQuestion),
  );
  // 一句 NPC 台词只能对应一条新证言；即使旧案的宽泛 actionAliases 意外重叠，也
  // 不能在屏幕上只说一件事、状态里却同时解锁多条证据。
  const nextDirectMatch =
    directMatches.find(
      (evidence) => !session.discoveredEvidenceIds.includes(evidence.id),
    ) ?? directMatches[0];
  if (nextDirectMatch) return [nextDirectMatch];

  const legacyEvidence = availableEvidence.filter(
    (evidence) =>
      (evidence.discovery.dialogueAliases?.length ?? 0) === 0 &&
      !session.discoveredEvidenceIds.includes(evidence.id),
  );
  // 旧存档里的证人已明确表示害怕时，玩家的安抚是合理的推进动作。只有角色
  // 恰好还有一条未标注口语触发器的访谈证据时才放行，避免泛泛安慰误解锁多条线索。
  return legacyEvidence.length === 1 &&
    isReassuringWitnessFollowUp(normalizedQuestion) &&
    hasStalledWitnessDisclosure(session, characterId)
    ? legacyEvidence
    : [];
}

/**
 * 回答已经明确说出账本中某条证言时，不能再因为玩家措辞没有命中 alias 而把
 * 线索丢掉。这里不使用模型二次判断，只比较角色、可达性与足够长的事实文本锚点。
 */
function findResponseDisclosedInterviewEvidence(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  utterance: string,
): CaseArtifact["evidence"] {
  const normalizedUtterance = normalizeDialogueText(utterance);
  if (normalizedUtterance.length < 8) return [];

  const candidates = caseArtifact.evidence
    .filter(
      (evidence) =>
        evidence.discovery.method === "interview" &&
        evidence.discovery.characterId === characterId &&
        !session.discoveredEvidenceIds.includes(evidence.id) &&
        evidenceIsAvailable(caseArtifact, session, evidence.id),
    )
    .map((evidence) => ({
      evidence,
      score: interviewEvidenceDisclosureScore(
        caseArtifact,
        evidence,
        characterId,
        normalizedUtterance,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  return candidates[0] ? [candidates[0].evidence] : [];
}

/**
 * 早期版本把“回答已明确披露的证词”漏写成了未取得。读取历史 session 时根据
 * 已保存的对话逐条补回这类证据；不改评分或报告提交内容，且下一次正常命令会把
 * 校正后的状态随新 revision 持久化。
 */
export function reconcileDisclosedInterviewEvidence(
  caseArtifact: CaseArtifact,
  session: GameSession,
): GameSession {
  assertCaseMatches(caseArtifact, session);
  const discoveredEvidenceIds = [...session.discoveredEvidenceIds];

  for (const exchange of session.dialogue) {
    const evidence = findResponseDisclosedInterviewEvidence(
      caseArtifact,
      { ...session, discoveredEvidenceIds },
      exchange.characterId,
      exchange.utterance,
    )[0];
    if (evidence && !discoveredEvidenceIds.includes(evidence.id)) {
      discoveredEvidenceIds.push(evidence.id);
    }
  }

  const unlocks = resolveUnlocks(caseArtifact, session, discoveredEvidenceIds);
  const evidenceChanged =
    discoveredEvidenceIds.length !== session.discoveredEvidenceIds.length;
  const unlocksChanged =
    unlocks.sceneIds.length !== session.unlockedSceneIds.length ||
    unlocks.characterIds.length !== session.unlockedCharacterIds.length;
  return evidenceChanged || unlocksChanged
    ? {
        ...session,
        discoveredEvidenceIds,
        unlockedSceneIds: unlocks.sceneIds,
        unlockedCharacterIds: unlocks.characterIds,
      }
    : session;
}

function interviewEvidenceDisclosureScore(
  caseArtifact: CaseArtifact,
  evidence: CaseArtifact["evidence"][number],
  characterId: string,
  normalizedUtterance: string,
) {
  const sourceStatements = [
    evidence.discovery.dialogueUtterance,
    evidence.description,
    ...evidence.supportsFactIds.flatMap((factId) => {
      const fact = caseArtifact.facts.find((candidate) => candidate.id === factId);
      return fact ? [fact.statement] : [];
    }),
  ].filter((statement): statement is string => Boolean(statement));
  return sourceStatements.reduce((bestScore, statement) => {
    const normalizedStatement = normalizeDialogueText(statement);
    if (normalizedStatement.length < 8) return bestScore;
    const sharedCharacterName = caseArtifact.characters.some(
      (character) =>
        character.id !== characterId &&
        statement.includes(character.name) &&
        normalizedUtterance.includes(normalizeDialogueText(character.name)),
    );
    const sharedBigrams = sharedDialogueBigramCount(
      normalizedUtterance,
      normalizedStatement,
    );
    // 六个连续字足以区分“我看到了一些事”这样的模糊拖延与具体证词；若存在
    // 共同出现的案件人物，则四个双字词重叠也可识别自然的同义改写。
    const score = hasSharedDialogueSpan(
      normalizedUtterance,
      normalizedStatement,
      6,
    )
      ? 100 + sharedBigrams
      : sharedCharacterName && sharedBigrams >= 4
        ? 10 + sharedBigrams
        : 0;
    return Math.max(bestScore, score);
  }, 0);
}

function sharedDialogueBigramCount(first: string, second: string) {
  const firstBigrams = dialogueBigrams(first);
  const secondBigrams = dialogueBigrams(second);
  let count = 0;
  for (const bigram of firstBigrams) {
    if (secondBigrams.has(bigram)) count += 1;
  }
  return count;
}

function hasSharedDialogueSpan(first: string, second: string, minLength: number) {
  const [shorter, longer] =
    first.length <= second.length ? [first, second] : [second, first];
  for (let index = 0; index <= shorter.length - minLength; index += 1) {
    if (longer.includes(shorter.slice(index, index + minLength))) return true;
  }
  return false;
}

function isReassuringWitnessFollowUp(normalizedQuestion: string) {
  return /说出来|别怕|不用怕|没关系|放心|安全|保护|保证/u.test(
    normalizedQuestion,
  );
}

function hasStalledWitnessDisclosure(session: GameSession, characterId: string) {
  return session.dialogue
    .filter(
      (exchange) =>
        exchange.characterId === characterId &&
        exchange.disclosedClaimIds.length === 0 &&
        exchange.discoveredEvidenceIds.length === 0,
    )
    .slice(-3)
    .some((exchange) =>
      /害怕|不敢|不想回答|说出来.*麻烦|不能说|不方便/u.test(
        exchange.utterance,
      ),
    );
}

function interviewIntentMatches(
  caseArtifact: CaseArtifact,
  evidence: CaseArtifact["evidence"][number],
  normalizedQuestion: string,
) {
  const aliases = [
    ...(evidence.discovery.dialogueAliases ?? []),
    ...evidence.discovery.actionAliases,
  ];
  if (
    aliases.some((alias) => {
      const normalizedAlias = normalizeInterviewIntent(alias);
      return (
        normalizedAlias.length >= 2 &&
        (normalizedQuestion.includes(normalizedAlias) ||
          normalizedAlias.includes(normalizedQuestion) ||
          actionKeywordsOverlap(normalizedQuestion, normalizedAlias))
      );
    })
  ) {
    return true;
  }

  return legacyWitnessQuestionMatches(
    caseArtifact,
    evidence,
    normalizedQuestion,
  );
}

function legacyWitnessQuestionMatches(
  caseArtifact: CaseArtifact,
  evidence: CaseArtifact["evidence"][number],
  normalizedQuestion: string,
) {
  // 只为上线前已保存的案件提供兼容：玩家明确问“看到了谁/什么”，而证词或
  // 支撑事实也明确是目击内容时才命中。新生成案件必须依赖 dialogueAliases。
  if (
    (evidence.discovery.dialogueAliases?.length ?? 0) > 0 ||
    !/看到/u.test(normalizedQuestion) ||
    !/谁|人|其他|什么/u.test(normalizedQuestion)
  ) {
    return false;
  }
  const factStatements = evidence.supportsFactIds.flatMap((factId) => {
    const fact = caseArtifact.facts.find((candidate) => candidate.id === factId);
    return fact ? [fact.statement] : [];
  });
  return /看到/u.test(
    normalizeInterviewIntent([evidence.description, ...factStatements].join(" ")),
  );
}

function normalizeInterviewIntent(value: string) {
  return normalizeDialogueText(value)
    .replaceAll("看见", "看到")
    .replaceAll("见到", "看到")
    .replaceAll("目击", "看到")
    .replace(/[吗么呢吧]/gu, "");
}

function buildInterviewEvidenceResponse(input: {
  character: CaseArtifact["characters"][number];
  evidence: CaseArtifact["evidence"][number];
  previousMemory: string;
  playerText: string;
}): ValidatedCharacterResponse {
  return {
    utterance: interviewEvidenceUtterance(input.character, input.evidence),
    demeanor: "cooperative",
    // 访谈证据由 recordDialogueTurn 的同一匹配器解锁，而不是让模型把 fact id
    // 伪装成 claim id。这样能同时避免 schema 失败和“说了却没拿到证据”。
    disclosedClaimIds: [],
    memorySummary: [
      input.previousMemory,
      `侦探问及：${input.playerText.slice(0, 120)}`,
    ]
      .filter(Boolean)
      .join(" ")
      .slice(-1_200),
    stateDelta: { trust: 0, pressure: 0, alertness: 0 },
  };
}

function interviewEvidenceUtterance(
  character: CaseArtifact["characters"][number],
  evidence: CaseArtifact["evidence"][number],
) {
  if (evidence.discovery.dialogueUtterance) {
    return evidence.discovery.dialogueUtterance;
  }

  // 旧 artifact 只有第三人称 evidence.description；尽量转换为角色可说的一人称，
  // 同时不改写其事实内容。新 artifact 经过发布门禁后不会走到这里。
  if (evidence.description.startsWith(character.name)) {
    const statement = evidence.description
      .slice(character.name.length)
      .replace(/^在追问下/u, "")
      .replace(/^(?:称|说|表示)/u, "");
    return `我${statement}`;
  }
  return evidence.description;
}

/**
 * 模型或语义守卫不可用时的玩家可见回复。
 * 只从当前可披露证词、可取得访谈证据和角色已授权的遮掩说法中取材，且不因为
 * 系统降级改变角色数值，以免把内部失败变成玩家可利用的嫌疑信号。
 */
export function buildGroundedDialogueFallback(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  playerText: string,
): ValidatedCharacterResponse {
  const character = caseArtifact.characters.find(
    (candidate) => candidate.id === characterId,
  );
  if (!character) throw new Error(`Unknown character "${characterId}"`);

  const questionToAnswer = resolveDialogueQuestion(session, characterId, playerText);

  const matchingEvidence = findMatchedInterviewEvidence(
    caseArtifact,
    session,
    character.id,
    questionToAnswer,
  )[0];
  const previousMemory = session.characterStates[character.id]?.memorySummary ?? "";
  if (matchingEvidence) {
    return buildInterviewEvidenceResponse({
      character,
      evidence: matchingEvidence,
      previousMemory,
      playerText,
    });
  }
  const allowedClaims = caseArtifact.claims.filter(
    (claim) =>
      claim.speakerId === character.id &&
      character.knowledge.claimIds.includes(claim.id) &&
      claimCanBeDisclosed(caseArtifact, session, character.id, claim.id),
  );
  const reply = selectGroundedDialogueReply({
    caseArtifact,
    character,
    session,
    playerText: questionToAnswer,
    matchingEvidence,
    allowedClaims,
  });
  return {
    ...reply,
    memorySummary: [previousMemory, `侦探问及：${playerText.slice(0, 120)}`]
      .filter(Boolean)
      .join(" ")
      .slice(-1_200),
    stateDelta: { trust: 0, pressure: 0, alertness: 0 },
  };
}

/**
 * 首次指控与访谈证据可按账本回答；账本缺少的证明或时间细节直接说明无法确认，
 * 避免模型把“没有记载”编成“当时无人见证”，再通过历史对话固化这个说法。
 */
export function buildDeterministicDialogueShortcut(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  playerText: string,
): ValidatedCharacterResponse | null {
  const character = caseArtifact.characters.find(
    (candidate) => candidate.id === characterId,
  );
  if (!character) throw new Error(`Unknown character "${characterId}"`);
  playerText = resolveDialogueQuestion(session, characterId, playerText);

  if (dialogueBackgroundTopic(playerText) === "tenure" &&
    !getDialogueGroundingSources(caseArtifact, session, characterId).some((source) =>
      matchesBackgroundTopic("tenure", source.statement) && /[\d零〇一二两三四五六七八九十百]+(?:年|月)|刚入职|刚到任/u.test(source.statement),
    )) {
    return {
      utterance: "具体的工作年限，我现在无法确认，得核对一下。",
      demeanor: "guarded", disclosedClaimIds: [], memorySummary: "侦探追问工作年限；没有可确认的任职时长。",
      stateDelta: { trust: 0, pressure: 0, alertness: 0 },
    };
  }

  if (isSpecificActivityQuestion(playerText)) {
    const reply = selectGroundedWorkDetail(caseArtifact, session, characterId, playerText);
    if (!reply.disclosedClaimIds.length && reply.utterance.includes("无法确认")) {
      return { ...reply, memorySummary: "侦探追问具体工作内容；没有可确认的细节。", stateDelta: { trust: 0, pressure: 0, alertness: 0 } };
    }
    return null;
  }

  const matchingLieRule = findQuestionMatchedLieRule(
    caseArtifact,
    character,
    playerText,
  );
  if (
    matchingLieRule &&
    !session.dialogue.some(
      (exchange) =>
        exchange.characterId === character.id &&
        normalizeDialogueText(exchange.utterance) ===
          normalizeDialogueText(matchingLieRule.coverStatement),
    )
  ) {
    const previousMemory = session.characterStates[character.id]?.memorySummary ?? "";
    return {
      utterance: matchingLieRule.coverStatement,
      demeanor: "guarded",
      disclosedClaimIds: matchingAuthorizedClaimIds(
        caseArtifact, session, character.id, matchingLieRule.coverStatement,
      ),
      memorySummary: [previousMemory, `侦探问及：${playerText.slice(0, 120)}`]
        .filter(Boolean)
        .join(" ")
        .slice(-1_200),
      stateDelta: { trust: 0, pressure: 0, alertness: 0 },
    };
  }

  const matchingEvidence = findMatchedInterviewEvidence(
    caseArtifact,
    session,
    character.id,
    playerText,
  )[0];
  if (matchingEvidence) {
    return buildInterviewEvidenceResponse({
      character,
      evidence: matchingEvidence,
      previousMemory: session.characterStates[character.id]?.memorySummary ?? "",
      playerText,
    });
  }

  if (isVerificationFollowUp(playerText)) {
    const followUp = buildGroundedFollowUp({
      caseArtifact, character, playerText,
      allowedClaims: caseArtifact.claims.filter((claim) =>
        claimCanBeDisclosed(caseArtifact, session, character.id, claim.id),
      ),
    }, session);
    if (followUp) {
      return {
        ...followUp.response,
        memorySummary: `侦探追问：${playerText.slice(0, 120)}；按现有证明的完整内容回答。`,
        stateDelta: { trust: 0, pressure: 0, alertness: 0 },
      };
    }
  }

  return null;
}

function selectGroundedDialogueReply(input: {
  caseArtifact: CaseArtifact;
  character: CaseArtifact["characters"][number];
  session?: GameSession;
  playerText: string;
  matchingEvidence?: CaseArtifact["evidence"][number];
  allowedClaims: CaseArtifact["claims"];
}) {
  if (input.session && isSpecificActivityQuestion(input.playerText)) {
    return selectGroundedWorkDetail(input.caseArtifact, input.session, input.character.id, input.playerText);
  }
  const followUp = input.session && buildGroundedFollowUp(input, input.session);
  if (followUp) return followUp.response;

  const relatedClaims = input.matchingEvidence
    ? input.allowedClaims.filter((claim) =>
        claim.factIds.some((factId) =>
          input.matchingEvidence?.supportsFactIds.includes(factId),
        ),
      )
    : [];
  const backgroundTopic = dialogueBackgroundTopic(input.playerText);
  const sources = input.session ? getDialogueGroundingSources(input.caseArtifact, input.session, input.character.id) : [];
  const previousReply = input.session?.dialogue.findLast((exchange) => exchange.characterId === input.character.id)?.utterance ?? "";
  const people = [
    ...input.caseArtifact.characters.map((character) => character.name),
    ...sources.flatMap((source) => Array.from(source.statement.matchAll(/(?:^|[。！？；，,]|我[和跟])([\p{Script=Han}]{2,8}?)(?=在|于|曾|看见|看到|见到|是|和我|跟我)/gu), (match) => match[1])),
  ];
  const namedPeople = people.filter((name) => input.playerText.includes(name));
  const referencedPeople = namedPeople.length > 0 ? namedPeople
    : /他|她|那人|这个人/u.test(input.playerText) ? people.filter((name) => previousReply.includes(name)) : [];
  const topicQuestion = normalizeDialogueText(`${input.playerText} ${referencedPeople.join(" ")}`);
  const matchesTopic = (statement: string) => matchesBackgroundTopic(backgroundTopic, statement) &&
    (!backgroundTopic || referencedPeople.length === 0 || referencedPeople.some((name) => statement.includes(name)));
  const selectedClaim =
    relatedClaims[0] ??
    input.allowedClaims
      .map((claim) => ({
        claim,
        score: dialogueTopicOverlapScore(
          topicQuestion,
          claim.statement,
        ),
      }))
      .filter(({ claim, score }) => score >= (backgroundTopic ? 1 : 2) && matchesTopic(claim.statement))
      .sort((left, right) => right.score - left.score)[0]?.claim ??
    (!backgroundTopic && /(?:那天|当天|案发|当时|那晚|当晚).{0,12}(?:干嘛|干什么|做什么|做了什么|在做|哪里|哪儿)/u.test(input.playerText)
      ? input.allowedClaims.find((claim) => /在|离开|上过|加班/u.test(claim.statement))
      : undefined);
  const selectedFact = input.session && !selectedClaim
    ? sources
        .filter((source) => !source.contextOnly && !source.claimId && matchesTopic(source.statement))
        .map((source) => ({ source, score: dialogueTopicOverlapScore(topicQuestion, source.statement) }))
        .filter(({ score }) => score >= (backgroundTopic ? 1 : 2))
        .sort((left, right) => right.score - left.score)[0]?.source
    : undefined;
  // 直接指控角色隐瞒的事实时，优先让其按案件账本中的 cover statement 应对；
  // 不把模型失败表现成一句机械的拒答，也不随机选择不相干的谎言。
  const matchingLieRule = input.matchingEvidence
    ? undefined
    : findQuestionMatchedLieRule(
        input.caseArtifact,
        input.character,
        input.playerText,
      );
  const utterance =
    input.matchingEvidence?.description ??
    matchingLieRule?.coverStatement ??
    selectedClaim?.statement ??
    selectedFact?.statement ??
    (backgroundTopic === "relationship" && /死者|受害者/u.test(input.playerText)
      ? publicIdentityReply(input.caseArtifact, input.character.id)
      : undefined) ??
    (backgroundTopic === "tenure"
      ? "具体的工作年限，我现在无法确认，得核对一下。"
      : backgroundTopic === "relationship"
        ? `我的身份是${input.character.occupation}；关于你问的具体来往，我现在没有可以确认的补充。`
        : "关于你问的情况，我目前没有可以确认的补充。");
  const demeanor: CharacterDemeanor = input.matchingEvidence
    ? "cooperative"
    : matchingLieRule || selectedClaim?.kind === "lie"
      ? "guarded"
      : selectedClaim || selectedFact
        ? "cooperative"
        : "evasive";

  return {
    utterance: input.session && input.session.dialogue.findLast((exchange) => exchange.characterId === input.character.id)?.utterance === utterance
      ? `这一点我能说明的仍是：${utterance}`
      : utterance,
    demeanor,
    disclosedClaimIds: matchingLieRule
      ? input.session
        ? matchingAuthorizedClaimIds(input.caseArtifact, input.session, input.character.id, matchingLieRule.coverStatement)
        : []
      : selectedClaim
        ? [selectedClaim.id]
        : [],
  };
}

function isSpecificActivityQuestion(question: string) {
  return /(?:具体|详细).{0,8}(?:做|干|工作|忙)|工作内容|做些什么|在忙什么|在做什么工作/u.test(question);
}

function selectGroundedWorkDetail(caseArtifact: CaseArtifact, session: GameSession, characterId: string, question: string) {
  const previous = session.dialogue.findLast((exchange) => exchange.characterId === characterId);
  const topic = normalizeDialogueText(`${question} ${previous?.utterance ?? ""}`);
  const detail = getDialogueGroundingSources(caseArtifact, session, characterId)
    .filter((source) => !source.contextOnly)
    .filter((source) => source.statement.split(/[。！？；，,]/u).some((clause) => {
      const text = normalizeDialogueText(clause);
      // 单独的加班地点、证明或未去现场的否认不能回答具体做了什么；不按有限动词表推断工作内容。
      return text.length >= 4 && !/(?:加班|工作|值班|办公室|公司)[着了过]?$/u.test(text) &&
        !/为证|(?:能|可以).{0,8}(?:证明|作证)|(?:没有|没|从未).{0,8}(?:去|进|离开|上过|下过)/u.test(text) &&
        dialogueTopicOverlapScore(topic, text) >= 2;
    }))
    .map((source) => ({ source, score: dialogueTopicOverlapScore(topic, source.statement) }))
    .sort((left, right) => right.score - left.score)[0]?.source;
  const utterance = detail?.statement ?? "那晚的具体工作内容，我现在无法确认，不能随口给你一个说法。";
  return {
    utterance: previous?.utterance === utterance ? `具体工作这一点，我能说明的仍是：${utterance}` : utterance,
    demeanor: "guarded" as const,
    disclosedClaimIds: detail?.claimId ? [detail.claimId] : [],
  };
}

function matchingAuthorizedClaimIds(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  statement: string,
) {
  return caseArtifact.claims
    .filter((claim) =>
      normalizeDialogueText(claim.statement) === normalizeDialogueText(statement) &&
      claimCanBeDisclosed(caseArtifact, session, characterId, claim.id),
    )
    .map((claim) => claim.id);
}

export function getDialogueGroundingSources(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
): Array<{ statement: string; factIds: string[]; claimId: string; contextOnly?: boolean }> {
  const character = caseArtifact.characters.find((candidate) => candidate.id === characterId);
  if (!character) return [];
  const victim = caseArtifact.characters.find((candidate) => candidate.id === caseArtifact.victimId);
  return [
    ...caseArtifact.claims
      .filter((claim) => claimCanBeDisclosed(caseArtifact, session, characterId, claim.id))
      .map((claim) => ({ statement: claim.statement, factIds: claim.factIds, claimId: claim.id })),
    ...character.lieRules.map((rule) => ({ statement: rule.coverStatement, factIds: [rule.factId], claimId: "" })),
    ...caseArtifact.facts
      .filter((fact) => factCanBeDisclosed(caseArtifact, session, characterId, fact.id))
      .map((fact) => ({ statement: fact.statement, factIds: [fact.id], claimId: "" })),
    ...caseArtifact.evidence
      .filter((evidence) => dialogueEvidenceCanBeDisclosed(caseArtifact, session, characterId, evidence.id))
      .flatMap((evidence) => [`${evidence.name}：${evidence.description}`, evidence.discovery.dialogueUtterance]
        .filter((statement): statement is string => Boolean(statement))
        .map((statement) => ({ statement, factIds: evidence.supportsFactIds, claimId: "" }))),
    { statement: publicCharacterProfile(character), factIds: [], claimId: "", contextOnly: true },
    { statement: `${character.name}的职业是${character.occupation}。`, factIds: [], claimId: "", contextOnly: true },
    { statement: caseArtifact.briefing, factIds: [], claimId: "", contextOnly: true },
    ...(victim ? [
      { statement: publicCharacterProfile(victim), factIds: [], claimId: "", contextOnly: true },
      { statement: `${victim.name}的职业是${victim.occupation}。`, factIds: [], claimId: "", contextOnly: true },
    ] : []),
  ];
}

export function getPublicDialogueIdentities(caseArtifact: CaseArtifact, characterId: string) {
  const character = caseArtifact.characters.find((candidate) => candidate.id === characterId);
  const victim = caseArtifact.characters.find((candidate) => candidate.id === caseArtifact.victimId);
  if (!character || !victim) return [];
  const people = [character, victim];
  const identities = people.map((person) => ({
    characterId: person.id, identity: person.occupation,
    sourceText: `${person.name}的职业是${person.occupation}。`,
    declaration: `${person.name}的职业是${person.occupation}`,
  }));
  for (const sourceText of [caseArtifact.briefing, ...people.map(publicCharacterProfile)]) {
    for (const declaration of sourceText.split(/[。！？；，,]/u).map((part) => part.trim())) {
      for (const person of people) {
        for (const subject of person.id === victim.id ? [person.name, "死者", "受害者"] : [person.name]) {
          for (const verb of ["的职业是", "担任", "生前是", "是", "为"]) {
            if (!declaration.startsWith(subject + verb)) continue;
            const identity = declaration.slice(subject.length + verb.length).trim();
            if (identity) identities.push({ characterId: person.id, identity, sourceText, declaration });
          }
        }
      }
    }
  }
  return identities;
}

function publicIdentityReply(caseArtifact: CaseArtifact, characterId: string) {
  const character = caseArtifact.characters.find((candidate) => candidate.id === characterId);
  const victim = caseArtifact.characters.find((candidate) => candidate.id === caseArtifact.victimId);
  if (!character || !victim) return undefined;
  const identities = getPublicDialogueIdentities(caseArtifact, characterId).filter((identity) => identity.characterId === victim.id);
  const identity = identities.find((candidate) => candidate.identity !== victim.occupation) ?? identities[0];
  return `我是${character.occupation}；${victim.name}是${identity.identity}。`;
}

function buildGroundedFollowUp(
  input: {
    caseArtifact: CaseArtifact;
    character: CaseArtifact["characters"][number];
    playerText: string;
    allowedClaims: CaseArtifact["claims"];
  },
  session: GameSession,
) {
  const question = normalizeDialogueText(resolveDialogueQuestion(session, input.character.id, input.playerText));
  if (!isVerificationFollowUp(question)) return null;
  const history = session.dialogue
    .filter((exchange) => exchange.characterId === input.character.id)
    .slice(-8);
  const priorClaimIds = history.findLast(
    (exchange) => exchange.disclosedClaimIds.length > 0,
  )?.disclosedClaimIds ?? [];
  const priorClaims = input.allowedClaims.filter((claim) => priorClaimIds.includes(claim.id));
  const disclosedClaimIds = [
    ...history.flatMap((exchange) => exchange.disclosedClaimIds),
    ...history.flatMap((exchange) => matchingAuthorizedClaimIds(input.caseArtifact, session, input.character.id, exchange.utterance)),
  ];
  const priorTopic = priorClaims.map((claim) => claim.statement).join(" ") ||
    history.at(-1)?.utterance || "";
  const contradiction = input.caseArtifact.evidence.find(
    (evidence) =>
      session.presentedEvidenceByCharacter[input.character.id]?.includes(evidence.id) &&
      evidence.contradictsClaimIds.some((id) => disclosedClaimIds.includes(id)) &&
      (question.includes(normalizeDialogueText(evidence.name)) || /矛盾|对不上|不符|解释/u.test(question)),
  );
  if (contradiction) {
    return {
      hasGroundedDetail: true,
      response: {
        utterance: `你出示的${contradiction.name}和我刚才的说法有冲突，这一点我现在还解释不了。`,
        demeanor: "guarded" as const,
        disclosedClaimIds: [],
      },
    };
  }

  const asksTime = isEventTimeQuestion(question);
  const asksWitnessTime = asksTime && /见|看|证人|作证|见证/u.test(question);
  const proofDetail = /证明|作证|见证|看见|看到|见到|陪|一起|独自|单独|没有人|没人|无人|监控|门禁|记录/u;
  const timeDetail = /\d{1,2}[:：点时]|[零〇一二两三四五六七八九十]{1,3}[点时]|具体时间|记不清/u;
  const sources = getDialogueGroundingSources(input.caseArtifact, session, input.character.id);
  const namedWitnesses = [
    ...input.caseArtifact.characters.map((character) => character.name),
    ...sources.flatMap((source) => Array.from(source.statement.matchAll(/(?:^|[。！？；，,])([\p{Script=Han}]{2,8}?)(?=在|于|曾|看见|看到|见到|能|可以)/gu), (match) => match[1])),
    ...Array.from(question.matchAll(/(?:老|小)[\p{Script=Han}]/gu), (match) => match[0]),
  ].filter((name) => question.includes(name));
  const candidates = sources
    .filter((source) => !source.contextOnly)
    .filter((source) =>
      (namedWitnesses.length > 0 && namedWitnesses.some((name) => source.statement.includes(name))) ||
      priorClaimIds.includes(source.claimId) ||
      priorClaims.some((prior) => prior.factIds.some((id) => source.factIds.includes(id))) ||
      dialogueTopicOverlapScore(normalizeDialogueText(priorTopic), source.statement) >= 3 ||
      (!priorTopic && dialogueTopicOverlapScore(question, source.statement) >= 2),
    )
    // 时间与否定可能在逗号/分号后，必须保留完整命题，不能把“没有见到”切成一次目击。
    .map((source) => ({ source, statement: source.statement }))
    .filter(({ statement }) => namedWitnesses.length === 0 || namedWitnesses.some((name) => statement.includes(name)))
    .filter(({ statement }) => asksTime
      ? timeDetail.test(statement) && (!asksWitnessTime || /看见|看到|见到|作证|见证/u.test(statement))
      : proofDetail.test(statement))
    .sort((left, right) =>
      Number(/证明|作证|见证/u.test(right.statement)) - Number(/证明|作证|见证/u.test(left.statement)) ||
      dialogueTopicOverlapScore(question, right.statement) - dialogueTopicOverlapScore(question, left.statement),
    );
  const detail = candidates[0];
  const recordProof = detail?.statement.match(/监控(?:录像)?|门禁(?:记录)?|录像|通话记录|记录/u)?.[0];
  const asksWholePeriod = /整晚|整夜|整个晚上|全程|一直|始终|没离开|未离开/u.test(question);
  if (!asksTime && asksWholePeriod && detail) {
    const continuous = /整晚|整夜|整个晚上|全程|一直|始终/u.test(detail.statement);
    const original = /[。！？!?]$/u.test(detail.statement.trim()) ? detail.statement.trim() : `${detail.statement.trim()}。`;
    const repeated = history.at(-1)?.utterance.includes(original);
    return {
      hasGroundedDetail: true,
      response: {
        utterance: continuous
          ? repeated && recordProof
            ? `整晚的情况，你可以核对${recordProof}；具体的证明人，我现在无法确认。`
            : `${original}${recordProof ? `具体人证我无法确认，你可以核对${recordProof}。` : ""}`
          : `${original}这只能说明其中那个时点，不能作为整晚都在场的证明。`,
        demeanor: "guarded" as const,
        disclosedClaimIds: detail.source.claimId ? [detail.source.claimId] : [],
      },
    };
  }
  if (!asksTime && /谁|人证|证人/u.test(question) && recordProof &&
    !/看见|看到|见到|见证|作证|一起|陪|独自|单独|没有人|没人|无人/u.test(detail!.statement)) {
    const repeated = history.some((exchange) => /具体谁|具体见证人/u.test(exchange.utterance));
    return {
      hasGroundedDetail: false,
      response: {
        utterance: repeated
          ? `具体见证人我确实说不准；你可以先核对${recordProof}。`
          : `我说的证明是${recordProof}；具体谁能替我作证，我现在无法确认。`,
        demeanor: "guarded" as const,
        disclosedClaimIds: [],
      },
    };
  }
  const detailStatement = detail && (/[。！？!?]$/u.test(detail.statement.trim()) ? detail.statement.trim() : `${detail.statement.trim()}。`);
  const alternatives = detail
    ? asksTime
      ? [`关于你问的时间，${detailStatement}`, `时间这一点，我能说明的是：${detailStatement}`]
      : [`就你问的证明，${detailStatement}`, `关于证明，我能说明的仍是：${detailStatement}`]
    : asksTime
      ? ["具体几点，我没有能确认的信息，不能给你一个确定的时间。", "你追问的这个时间，我目前还是无法确认。"]
      : /监控|门禁|录像|记录/u.test(question) && !/谁|人证|证人|见证/u.test(question)
        ? ["能核实这段行踪的记录，我目前无法确认。", "具体能查到哪份记录，还需要核对，我现在说不准。"]
      : /谁|人证|证人|作证|证明|见证|他|她/u.test(question)
        ? ["关于这段行踪，我目前提供不了可以核实的人证信息。", "具体谁能作证，我还是无法确认，不能随便指个人。"]
        : ["你要核实的这个细节，我目前没有可以确认的信息。", "这一点还需要核实，我现在无法补充确定的细节。"];
  const utterance = alternatives.find((candidate) => !history.some((exchange) => exchange.utterance === candidate)) ??
    alternatives.find((candidate) => history.at(-1)?.utterance !== candidate) ?? alternatives[0];
  return {
    hasGroundedDetail: Boolean(detail),
    response: {
      utterance,
      demeanor: "guarded" as const,
      disclosedClaimIds: detail?.source.claimId ? [detail.source.claimId] : [],
    },
  };
}

function findQuestionMatchedLieRule(
  caseArtifact: CaseArtifact,
  character: CaseArtifact["characters"][number],
  playerText: string,
) {
  const normalizedQuestion = normalizeDialogueText(playerText);
  if (normalizedQuestion.length < 2 || isVerificationFollowUp(normalizedQuestion) || dialogueBackgroundTopic(normalizedQuestion)) return undefined;
  const directChallenge = isDirectChallenge(normalizedQuestion);

  return character.lieRules
    .map((rule) => {
      const fact = caseArtifact.facts.find((candidate) => candidate.id === rule.factId);
      return {
        rule,
        score: Math.max(
          dialogueTopicOverlapScore(normalizedQuestion, fact?.statement ?? ""),
          dialogueTopicOverlapScore(normalizedQuestion, rule.coverStatement),
        ),
      };
    })
    .filter(({ score }) => score >= 2 || (directChallenge && score >= 1))
    .sort((left, right) => right.score - left.score)[0]?.rule;
}

function isDirectChallenge(normalizedQuestion: string) {
  return /为什么|怎么|凭什么|证据|证明|撒谎|虚报|欠|钱|账|费用|下药|杀|进入|离开|看到|承认|没有|没|不是/u.test(
    normalizedQuestion,
  );
}

export function isVerificationFollowUp(question: string) {
  if (isRoutineWorkQuestion(question)) return false;
  return isProofOrTimeQuestion(question) || /核实|矛盾|对不上|不符|出示|(?:证据|记录|监控).{0,8}(?:显示|表明|解释)/u.test(question);
}

export function isProofOrTimeQuestion(question: string) {
  if (isRoutineWorkQuestion(question)) return false;
  return /证明|谁.{0,8}(?:见|看|知道)|作证|证人|见证|人证|(?:有没有|有无|有什么).{0,4}(?:监控|门禁|记录)|(?:什么|哪些|哪份|哪条|查|调取|提供).{0,6}(?:监控|门禁|录像|记录)|(?:监控|门禁|录像|记录).{0,6}(?:拍到|显示|查到|核实|调取)/u.test(question) || isEventTimeQuestion(question);
}

function isRoutineWorkQuestion(question: string) {
  return /平时|平常|日常|通常|工作上|工作职责/u.test(question) &&
    !/案发|那晚|当晚|那天|当天|当时|行踪|不在场/u.test(question);
}

function isEventTimeQuestion(question: string) {
  // 任职年限和人物关系属于背景问题，不能仅凭“多久”或代词转成案发证明。
  if (/关系|认识|来往|相处|工龄|工作年限|任职|入职|开始.{0,8}(?:工作|上班)/u.test(question)) return false;
  return /几点|何时|什么时候|什么时间|哪个时间|(?:当晚|那晚|案发|当时|那天).{0,16}(?:多久|多长时间)|(?:待|停留|逗留|在场|离开).{0,6}(?:多久|多长时间)/u.test(question);
}

function dialogueBackgroundTopic(question: string): "tenure" | "relationship" | undefined {
  if (/工龄|工作年限|(?:上班|工作|任职|入职|干了).{0,8}(?:多久|多长|几年|多少年)|(?:多久|几年|多少年).{0,8}(?:上班|工作|任职|入职)/u.test(question)) return "tenure";
  if (/关系|认识|来往|相处|交情/u.test(question)) return "relationship";
}

function matchesBackgroundTopic(topic: ReturnType<typeof dialogueBackgroundTopic>, statement: string) {
  if (topic === "tenure") return /工龄|入职|任职|工作.{0,6}[零〇一二两三四五六七八九十百\d]+年|(?:任|做|从事).{0,16}(?:年|月)|(?:上班|工作).{0,6}(?:年|月)|(?:年|月).{0,6}(?:上班|工作)/u.test(statement);
  if (topic === "relationship") return /关系|朋友|同事|同学|亲戚|夫妻|父女|母女|认识|来往|相处|邻居|合伙|女儿|儿子|妻子|丈夫|雇主/u.test(statement);
  return true;
}

export function resolveDialogueQuestion(session: GameSession, characterId: string, playerText: string) {
  const repeatQuestion = /^(?:请|那)?(?:再问一次|再说一遍|再讲一遍|重复一遍|重复一下|重说一遍)[吧呢吗]?$/u;
  if (!repeatQuestion.test(normalizeDialogueText(playerText))) return playerText;
  return session.dialogue.findLast((exchange) =>
    exchange.characterId === characterId && !repeatQuestion.test(normalizeDialogueText(exchange.playerText)),
  )?.playerText ?? playerText;
}

function dialogueTopicOverlapScore(question: string, source: string) {
  const questionBigrams = dialogueBigrams(question);
  const sourceBigrams = dialogueBigrams(normalizeDialogueText(source));
  let score = 0;
  for (const bigram of questionBigrams) {
    if (sourceBigrams.has(bigram)) score += 1;
  }
  return score;
}

function dialogueBigrams(value: string) {
  const bigrams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    bigrams.add(value.slice(index, index + 2));
  }
  return bigrams;
}

function normalizeDialogueText(value: string) {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

const legacyDialogueRefusalPattern =
  /(?:沉默片刻\s*[：:]\s*)?[“"]?这个问题[，,]?\s*(?:我)?(?:现在)?不想回答[。！!]?["”]?/u;

function isLegacyDialogueRefusal(utterance: string) {
  return legacyDialogueRefusalPattern.test(utterance);
}

function legacyDialogueReplacement(
  caseArtifact: CaseArtifact,
  exchange: DialogueExchange,
  previouslyVisibleClaimIds: ReadonlySet<string>,
) {
  const character = caseArtifact.characters.find(
    (candidate) => candidate.id === exchange.characterId,
  );
  if (!character) return exchange.utterance;

  const previouslyVisibleClaims = caseArtifact.claims.filter(
    (claim) =>
      claim.speakerId === character.id &&
      previouslyVisibleClaimIds.has(claim.id),
  );
  return selectGroundedDialogueReply({
    caseArtifact,
    character,
    playerText: exchange.playerText,
    allowedClaims: previouslyVisibleClaims,
  }).utterance;
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
        (candidate) =>
          !discoveredFactIds.has(candidate.targetFactId) &&
          (session.hintLevelsByChainId[candidate.id] ?? 0) < candidate.hints.length,
      ) ?? caseArtifact.hintChains.find(
        (candidate) => (session.hintLevelsByChainId[candidate.id] ?? 0) < candidate.hints.length,
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

export function startConfrontation(
  caseArtifact: CaseArtifact,
  session: GameSession,
  command: StartConfrontationCommand,
): { session: GameSession; outcome: StartConfrontationOutcome } {
  assertCaseMatches(caseArtifact, session);
  if (session.processedCommandIds.includes(command.commandId)) {
    return {
      session,
      outcome: { status: "duplicate", confrontation: session.confrontation },
    };
  }
  assertActiveCase(caseArtifact, session);
  if (!hasCompleteConfrontationDossier(caseArtifact, session)) {
    throw new Error(
      "a confrontation requires every reachable evidence item and the reconstructed timeline",
    );
  }
  if (session.confrontation) {
    throw new Error("a confrontation is already underway");
  }
  const suspect = caseArtifact.characters.find(
    (character) =>
      character.id === command.suspectId && character.roleTier === "suspect",
  );
  if (!suspect) {
    throw new Error("a confrontation requires a named suspect");
  }

  const confrontation: ConfrontationState = {
    suspectId: suspect.id,
    rebuttal: `${suspect.name}神色未变：\u201c你说我有罪，那你怎么解释我的不在场证明？没有把动机、手法和时间线连成完整证据链，就别想让我认罪。\u201d`,
  };
  const now = command.now ?? new Date().toISOString();
  const nextSession = appendEvent(
    { ...session, confrontation },
    command.commandId,
    now,
    "confrontation_started",
    `向${suspect.name}发起当面对质`,
    { suspectId: suspect.id },
  );

  return { session: nextSession, outcome: { status: "started", confrontation } };
}

export function resolveConfrontation(
  caseArtifact: CaseArtifact,
  session: GameSession,
  command: ResolveConfrontationCommand,
): { session: GameSession; outcome: ResolveConfrontationOutcome } {
  assertCaseMatches(caseArtifact, session);
  if (session.processedCommandIds.includes(command.commandId)) {
    return {
      session,
      outcome: {
        status: "duplicate",
        rebuttal: session.confrontation?.rebuttal,
        confession: session.confrontation?.confession,
        report: session.report,
      },
    };
  }
  assertActiveCase(caseArtifact, session);
  const confrontation = session.confrontation;
  if (!confrontation) {
    throw new Error("a confrontation has not been started");
  }

  const culprit = caseArtifact.characters.find(
    (character) => character.id === caseArtifact.solution.culpritId,
  );
  const confrontedSuspect = caseArtifact.characters.find(
    (character) => character.id === confrontation.suspectId,
  );
  const now = command.now ?? new Date().toISOString();
  if (!culprit || !isCompleteConfrontationSubmission(caseArtifact, session, command)) {
    const rebuttal = `${confrontedSuspect?.name ?? "嫌疑人"}仍然摇头：\u201c你的说法还没有排除其他可能，也没有形成让我无从抵赖的完整闭环。\u201d`;
    const nextSession = appendEvent(
      { ...session, confrontation: undefined },
      command.commandId,
      now,
      "confrontation_rebutted",
      "对质未能形成完整证据链",
      { suspectId: confrontation.suspectId },
    );
    return { session: nextSession, outcome: { status: "rebutted", rebuttal } };
  }

  const motiveStatement =
    caseArtifact.facts
      .find((fact) => fact.id === caseArtifact.solution.motiveFactId)
      ?.statement.replaceAll(culprit.name, "我")
      .replace(/[。！？]$/u, "") ?? "我有无法摆脱的作案动机";
  const confession = `${culprit.name}沉默良久，终于低声承认：\u201c……是我做的。${motiveStatement}，我才会铤而走险。你已经把动机、手法和时间线全都讲清楚了，我无从抵赖。\u201d`;
  const submitted = submitCaseReport(
    caseArtifact,
    {
      ...session,
      confrontation: { ...confrontation, confession },
    },
    command,
  );
  return {
    session: submitted.session,
    outcome: {
      status: "confessed",
      confession,
      report: submitted.outcome.report,
    },
  };
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

function hasCompleteConfrontationDossier(
  caseArtifact: CaseArtifact,
  session: GameSession,
) {
  const reachableEvidenceIds = findReachableEvidenceIds(caseArtifact);
  return [...reachableEvidenceIds].every((evidenceId) =>
    session.discoveredEvidenceIds.includes(evidenceId),
  );
}

function isCompleteConfrontationSubmission(
  caseArtifact: CaseArtifact,
  session: GameSession,
  command: ResolveConfrontationCommand,
) {
  const confrontation = session.confrontation;
  if (!confrontation || !hasCompleteConfrontationDossier(caseArtifact, session)) {
    return false;
  }
  const submittedEvidenceIds = new Set(command.evidenceIds);
  const submittedTimelineEventIds = new Set(command.timelineEventIds);
  const reachableEvidenceIds = findReachableEvidenceIds(caseArtifact);

  return (
    command.culpritId === confrontation.suspectId &&
    command.culpritId === caseArtifact.solution.culpritId &&
    command.motiveFactId === caseArtifact.solution.motiveFactId &&
    command.methodFactId === caseArtifact.solution.methodFactId &&
    command.reasoning.trim().length >= 10 &&
    [...reachableEvidenceIds].every((evidenceId) =>
      submittedEvidenceIds.has(evidenceId),
    ) &&
    caseArtifact.timeline.every((event) => submittedTimelineEventIds.has(event.id))
  );
}

export function getPlayerCaseView(
  caseArtifact: CaseArtifact,
  gameSession: GameSession,
) {
  // 这是唯一面向普通玩家的投影：绝不能把真凶、私密档案、未发现证据或完整时间线直接透出。
  const session = reconcileDisclosedInterviewEvidence(caseArtifact, gameSession);
  const victim = caseArtifact.characters.find(
    (character) => character.id === caseArtifact.victimId,
  );
  const discoveredEvidence = caseArtifact.evidence.filter((evidence) =>
    session.discoveredEvidenceIds.includes(evidence.id),
  );
  const discoveredFactIds = new Set(
    discoveredEvidence.flatMap((evidence) => evidence.supportsFactIds),
  );
  const hasCompleteEvidenceChain = caseArtifact.solution.requiredEvidenceIds.every(
    (evidenceId) => session.discoveredEvidenceIds.includes(evidenceId),
  );
  const hasConfirmedConclusion =
    hasCompleteEvidenceChain &&
    solveCaseWithEvidenceIds(caseArtifact, session.discoveredEvidenceIds).status ===
      "unique";
  const confrontationReady = hasCompleteConfrontationDossier(
    caseArtifact,
    session,
  );
  const previouslyVisibleClaimIds = new Set<string>();
  const dialogue = session.dialogue.map((exchange) => {
    const utterance = isLegacyDialogueRefusal(exchange.utterance)
      ? legacyDialogueReplacement(
          caseArtifact,
          exchange,
          previouslyVisibleClaimIds,
        )
      : exchange.utterance;
    for (const claimId of exchange.disclosedClaimIds) {
      previouslyVisibleClaimIds.add(claimId);
    }
    return {
      commandId: exchange.commandId,
      at: exchange.at,
      characterId: exchange.characterId,
      playerText: exchange.playerText,
      utterance,
      demeanor: exchange.demeanor,
      disclosedClaimIds: exchange.disclosedClaimIds,
      discoveredEvidenceIds: exchange.discoveredEvidenceIds,
    };
  });

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
      confrontation: session.confrontation ?? null,
      report: session.report,
    },
    case: {
      id: caseArtifact.id,
      title: caseArtifact.title,
      briefing: caseArtifact.briefing,
      setting: {
        era: caseArtifact.setting.era,
        place: caseArtifact.setting.place,
      },
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
    evidence: discoveredEvidence.map((evidence) =>
      playerFacingEvidence(caseArtifact, evidence, hasConfirmedConclusion),
    ),
    claims: caseArtifact.claims
      .filter((claim) => session.discoveredClaimIds.includes(claim.id))
      .map((claim) => ({ id: claim.id, speakerId: claim.speakerId, statement: claim.statement })),
    dialogue,
    deductions: caseArtifact.facts
      .filter((fact) => discoveredFactIds.has(fact.id))
      .map((fact) => ({
        id: fact.id,
        type: fact.type,
        statement: playerFacingFactStatement(
          caseArtifact,
          fact,
          hasConfirmedConclusion,
        ),
        sourceEvidenceNames: unique(
          discoveredEvidence
            .filter((evidence) => evidence.supportsFactIds.includes(fact.id))
            .map((evidence) =>
              playerFacingEvidence(caseArtifact, evidence, hasConfirmedConclusion).name,
            ),
        ),
      })),
    reportOptions: {
      suspects: caseArtifact.characters
        .filter((character) => character.roleTier === "suspect")
        .map(publicCharacter),
      motiveFacts: caseArtifact.facts
        .filter((fact) => fact.type === "motive" && discoveredFactIds.has(fact.id))
        .map((fact) => ({
          id: fact.id,
          statement: playerFacingFactStatement(
            caseArtifact,
            fact,
            hasConfirmedConclusion,
          ),
        })),
      methodFacts: caseArtifact.facts
        .filter((fact) => fact.type === "method" && discoveredFactIds.has(fact.id))
        .map((fact) => ({
          id: fact.id,
          statement: playerFacingFactStatement(
            caseArtifact,
            fact,
            hasConfirmedConclusion,
          ),
        })),
      timelineEvents: hasConfirmedConclusion
        ? caseArtifact.timeline.map((event) => ({
            id: event.id,
            description: redactTimelineForPlayer(caseArtifact, event.description),
          }))
        : [],
      hasCompleteEvidenceChain,
      hasCompleteConfrontationDossier: confrontationReady,
    },
  };
}

function playerFacingEvidence(
  caseArtifact: CaseArtifact,
  evidence: CaseArtifact["evidence"][number],
  hasConfirmedConclusion: boolean,
) {
  const shouldRedact =
    !hasConfirmedConclusion &&
    findInitiallyDiscoverableSceneEvidenceIds(caseArtifact).has(evidence.id);
  return {
    id: evidence.id,
    name: shouldRedact
      ? redactUnconfirmedLead(caseArtifact, evidence.name)
      : evidence.name,
    description: shouldRedact
      ? redactUnconfirmedLead(caseArtifact, evidence.description)
      : evidence.description,
    kind: evidence.kind,
  };
}

function playerFacingFactStatement(
  caseArtifact: CaseArtifact,
  fact: CaseArtifact["facts"][number],
  hasConfirmedConclusion: boolean,
) {
  if (hasConfirmedConclusion) return fact.statement;
  const unconfirmedStatements: Partial<Record<CaseArtifact["facts"][number]["type"], string>> = {
    identity: "发现了需要交叉核验的身份关联线索，尚待交叉核验。",
    motive: "发现了可能的作案动机线索，尚待交叉核验。",
    method: "发现了可能的作案手法线索，尚待交叉核验。",
    opportunity: "发现了需要核验的行动轨迹线索，尚待交叉核验。",
    alibi: "发现了一份仍待核验的不在场线索，尚待交叉核验。",
  };
  return unconfirmedStatements[fact.type] ?? redactUnconfirmedLead(caseArtifact, fact.statement);
}

function redactUnconfirmedLead(caseArtifact: CaseArtifact, text: string) {
  let redacted = text;
  const suspectNames = caseArtifact.characters
    .filter((character) => character.roleTier === "suspect")
    .map((character) => character.name)
    .sort((left, right) => right.length - left.length);
  for (const suspectName of suspectNames) {
    redacted = redacted.replaceAll(suspectName, "某位嫌疑人");
  }
  return redacted.replace(/真凶|凶手|作案者|杀人者/gu, "相关人员");
}

export function getCaseReview(
  caseArtifact: CaseArtifact,
  gameSession: GameSession,
): CaseReview | null {
  const session = reconcileDisclosedInterviewEvidence(caseArtifact, gameSession);
  if (session.status !== "closed" || !session.report) {
    return null;
  }
  const report = session.report;
  const characterNameById = new Map(
    caseArtifact.characters.map((character) => [character.id, character.name]),
  );
  const characterById = new Map(
    caseArtifact.characters.map((character) => [character.id, character]),
  );
  const factById = new Map(caseArtifact.facts.map((fact) => [fact.id, fact]));
  const evidenceById = new Map(
    caseArtifact.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const sceneById = new Map(caseArtifact.scenes.map((scene) => [scene.id, scene]));
  const objectById = new Map(
    caseArtifact.scenes
      .flatMap((scene) => scene.objects)
      .map((object) => [object.id, object]),
  );
  const facts = caseArtifact.facts.map((fact) => ({ ...fact }));
  const claims = caseArtifact.claims.map((claim) =>
    declassifyClaim(claim, characterNameById, factById),
  );
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const characters = caseArtifact.characters.map((character) =>
    declassifyCharacter(character, factById),
  );
  const submittedEvidenceIds = new Set(report.submitted.evidenceIds);
  const requiredEvidenceIds = new Set(caseArtifact.solution.requiredEvidenceIds);
  const evidence = caseArtifact.evidence.map((item) =>
    declassifyEvidence({
      evidence: item,
      caseArtifact,
      session,
      submittedEvidenceIds,
      requiredEvidenceIds,
      factById,
      claimById,
      characterById,
      evidenceById,
      sceneById,
      objectById,
    }),
  );

  return {
    culprit: caseArtifact.characters.find(
      (character) => character.id === caseArtifact.solution.culpritId,
    ),
    motive: factById.get(caseArtifact.solution.motiveFactId),
    method: factById.get(caseArtifact.solution.methodFactId),
    facts,
    characters,
    claims,
    timeline: caseArtifact.timeline,
    lies: claims.filter((claim) => claim.kind === "lie"),
    evidence,
    playerEvents: session.events,
    confession: session.confrontation?.confession,
    report,
  };
}

function declassifyClaim(
  claim: CaseArtifact["claims"][number],
  characterNameById: ReadonlyMap<string, string>,
  factById: ReadonlyMap<string, CaseArtifact["facts"][number]>,
): DeclassifiedClaim {
  return {
    id: claim.id,
    speakerId: claim.speakerId,
    speakerName: characterNameById.get(claim.speakerId) ?? claim.speakerId,
    kind: claim.kind,
    statement: claim.statement,
    facts: declassifyFacts(claim.factIds, factById),
  };
}

function declassifyCharacter(
  character: CaseArtifact["characters"][number],
  factById: ReadonlyMap<string, CaseArtifact["facts"][number]>,
): DeclassifiedCharacter {
  return {
    id: character.id,
    name: character.name,
    roleTier: character.roleTier,
    occupation: character.occupation,
    publicProfile: character.publicProfile,
    privateProfile: character.privateProfile,
    secrets: declassifyFacts(character.secretFactIds, factById),
    lieRules: character.lieRules.flatMap((rule) => {
      const fact = factById.get(rule.factId);
      return fact
        ? [
            {
              strategy: rule.strategy,
              coverStatement: rule.coverStatement,
              fact: { ...fact },
            },
          ]
        : [];
    }),
  };
}

function declassifyEvidence(input: {
  evidence: CaseArtifact["evidence"][number];
  caseArtifact: CaseArtifact;
  session: GameSession;
  submittedEvidenceIds: ReadonlySet<string>;
  requiredEvidenceIds: ReadonlySet<string>;
  factById: ReadonlyMap<string, CaseArtifact["facts"][number]>;
  claimById: ReadonlyMap<string, DeclassifiedClaim>;
  characterById: ReadonlyMap<string, CaseArtifact["characters"][number]>;
  evidenceById: ReadonlyMap<string, CaseArtifact["evidence"][number]>;
  sceneById: ReadonlyMap<string, CaseArtifact["scenes"][number]>;
  objectById: ReadonlyMap<
    string,
    CaseArtifact["scenes"][number]["objects"][number]
  >;
}): DeclassifiedEvidence {
  const contradictoryClaims = input.evidence.contradictsClaimIds.flatMap((id) => {
    const claim = input.claimById.get(id);
    return claim ? [claim] : [];
  });
  const supportingFacts = declassifyFacts(
    input.evidence.supportsFactIds,
    input.factById,
  );
  const implicatedCharacters = characterReferences(
    input.evidence.implicatesCharacterIds,
    input.characterById,
  );
  const excludesCharacters = characterReferences(
    input.evidence.excludesCharacterIds,
    input.characterById,
  );

  return {
    id: input.evidence.id,
    name: input.evidence.name,
    description: input.evidence.description,
    kind: input.evidence.kind,
    critical: input.evidence.critical,
    discovered: input.session.discoveredEvidenceIds.includes(input.evidence.id),
    includedInReport: input.submittedEvidenceIds.has(input.evidence.id),
    requiredForSolution: input.requiredEvidenceIds.has(input.evidence.id),
    supportsFacts: supportingFacts,
    contradictsClaims: contradictoryClaims,
    implicatesCharacters: implicatedCharacters,
    excludesCharacters,
    acquisition: buildEvidenceAcquisition(input),
    followUps: buildEvidenceFollowUps({
      contradictoryClaims,
      implicatedCharacters,
      supportingFacts,
    }),
  };
}

function buildEvidenceAcquisition(input: {
  evidence: CaseArtifact["evidence"][number];
  caseArtifact: CaseArtifact;
  evidenceById: ReadonlyMap<string, CaseArtifact["evidence"][number]>;
  characterById: ReadonlyMap<string, CaseArtifact["characters"][number]>;
  sceneById: ReadonlyMap<string, CaseArtifact["scenes"][number]>;
  objectById: ReadonlyMap<
    string,
    CaseArtifact["scenes"][number]["objects"][number]
  >;
}): CaseReviewAcquisition {
  const discovery = input.evidence.discovery;
  const scene = discovery.sceneId
    ? input.sceneById.get(discovery.sceneId)
    : undefined;
  const object = discovery.objectId
    ? input.objectById.get(discovery.objectId)
    : undefined;
  const character = discovery.characterId
    ? input.characterById.get(discovery.characterId)
    : undefined;

  return {
    method: discovery.method,
    primaryAction: discovery.actionAliases[0] ?? input.evidence.name,
    scene: scene ? { id: scene.id, name: scene.name } : undefined,
    object: object ? { id: object.id, name: object.name } : undefined,
    character: character
      ? {
          id: character.id,
          name: character.name,
          occupation: character.occupation,
        }
      : undefined,
    prerequisiteEvidence: evidenceReferences(
      discovery.prerequisiteEvidenceIds,
      input.evidenceById,
    ),
    unlockRequirements: unlockRequirementsForEvidence({
      evidence: input.evidence,
      caseArtifact: input.caseArtifact,
      evidenceById: input.evidenceById,
      sceneById: input.sceneById,
      characterById: input.characterById,
    }),
  };
}

function unlockRequirementsForEvidence(input: {
  evidence: CaseArtifact["evidence"][number];
  caseArtifact: CaseArtifact;
  evidenceById: ReadonlyMap<string, CaseArtifact["evidence"][number]>;
  sceneById: ReadonlyMap<string, CaseArtifact["scenes"][number]>;
  characterById: ReadonlyMap<string, CaseArtifact["characters"][number]>;
}): CaseReviewUnlockRequirement[] {
  const targetIds = [
    { targetType: "evidence" as const, targetId: input.evidence.id },
    ...(input.evidence.discovery.sceneId
      ? [{ targetType: "scene" as const, targetId: input.evidence.discovery.sceneId }]
      : []),
    ...(input.evidence.discovery.characterId
      ? [
          {
            targetType: "character" as const,
            targetId: input.evidence.discovery.characterId,
          },
        ]
      : []),
  ];

  return input.caseArtifact.unlockRules
    .filter(
      (rule) =>
        targetIds.some(
          (target) =>
            target.targetType === rule.targetType && target.targetId === rule.targetId,
        ) &&
        (rule.allEvidenceIds.length > 0 || rule.anyEvidenceIds.length > 0),
    )
    .map((rule) => ({
      targetType: rule.targetType,
      targetName: unlockTargetName(
        rule.targetType,
        rule.targetId,
        input.evidenceById,
        input.sceneById,
        input.characterById,
      ),
      allEvidence: evidenceReferences(rule.allEvidenceIds, input.evidenceById),
      anyEvidence: evidenceReferences(rule.anyEvidenceIds, input.evidenceById),
    }));
}

function buildEvidenceFollowUps(input: {
  contradictoryClaims: DeclassifiedClaim[];
  implicatedCharacters: Array<{ id: string; name: string }>;
  supportingFacts: DeclassifiedFact[];
}): CaseReviewFollowUp[] {
  const factStatements = input.supportingFacts.map((fact) => fact.statement);
  if (input.contradictoryClaims.length > 0) {
    return input.contradictoryClaims.map((claim) => ({
      characterId: claim.speakerId,
      characterName: claim.speakerName,
      claimId: claim.id,
      claimStatement: claim.statement,
      factStatements,
    }));
  }
  return input.implicatedCharacters.map((character) => ({
    characterId: character.id,
    characterName: character.name,
    factStatements,
  }));
}

function declassifyFacts(
  factIds: string[],
  factById: ReadonlyMap<string, CaseArtifact["facts"][number]>,
): DeclassifiedFact[] {
  return factIds.flatMap((id) => {
    const fact = factById.get(id);
    return fact ? [{ ...fact }] : [];
  });
}

function evidenceReferences(
  evidenceIds: string[],
  evidenceById: ReadonlyMap<string, CaseArtifact["evidence"][number]>,
): CaseReviewEvidenceReference[] {
  return evidenceIds.map((id) => ({ id, name: evidenceById.get(id)?.name ?? id }));
}

function characterReferences(
  characterIds: string[],
  characterById: ReadonlyMap<string, CaseArtifact["characters"][number]>,
) {
  return characterIds.map((id) => ({ id, name: characterById.get(id)?.name ?? id }));
}

function unlockTargetName(
  targetType: CaseReviewUnlockRequirement["targetType"],
  targetId: string,
  evidenceById: ReadonlyMap<string, CaseArtifact["evidence"][number]>,
  sceneById: ReadonlyMap<string, CaseArtifact["scenes"][number]>,
  characterById: ReadonlyMap<string, CaseArtifact["characters"][number]>,
) {
  if (targetType === "evidence") return evidenceById.get(targetId)?.name ?? targetId;
  if (targetType === "scene") return sceneById.get(targetId)?.name ?? targetId;
  if (targetType === "character") {
    return characterById.get(targetId)?.name ?? targetId;
  }
  return `分析目标 ${targetId}`;
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
  if (command.sceneId && evidence.discovery.sceneId && evidence.discovery.sceneId !== command.sceneId) {
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

export function factCanBeDisclosed(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  factId: string,
): boolean {
  const character = caseArtifact.characters.find((candidate) => candidate.id === characterId);
  if (!character || !caseArtifact.facts.some((fact) => fact.id === factId)) return false;
  const supportingEvidence = caseArtifact.evidence.filter((evidence) => evidence.supportsFactIds.includes(factId));
  const presented = session.presentedEvidenceByCharacter[characterId] ?? [];
  const hasPresentedEvidence = supportingEvidence.some((evidence) => presented.includes(evidence.id));
  if (!character.knowledge.factIds.includes(factId) && !hasPresentedEvidence) return false;

  const interviewEvidence = supportingEvidence.filter((evidence) =>
    evidence.discovery.method === "interview" && evidence.discovery.characterId === characterId,
  );
  const interviewUnlocked = interviewEvidence.some((evidence) =>
    session.discoveredEvidenceIds.includes(evidence.id) || evidenceIsAvailable(caseArtifact, session, evidence.id),
  );
  if (interviewEvidence.length > 0 && !interviewUnlocked && !hasPresentedEvidence) return false;

  // 知道秘密不等于获准披露；没有对应 claim 的秘密也必须遵守同一解锁边界。
  return !character.secretFactIds.includes(factId) || interviewUnlocked ||
    supportingEvidence.some((evidence) => session.discoveredEvidenceIds.includes(evidence.id) || presented.includes(evidence.id));
}

export function dialogueEvidenceCanBeDisclosed(
  caseArtifact: CaseArtifact,
  session: GameSession,
  characterId: string,
  evidenceId: string,
): boolean {
  const character = caseArtifact.characters.find((candidate) => candidate.id === characterId);
  const evidence = caseArtifact.evidence.find((candidate) => candidate.id === evidenceId);
  if (!character || !evidence) return false;
  if (session.presentedEvidenceByCharacter[characterId]?.includes(evidenceId)) return true;
  return character.knowledge.evidenceIds.includes(evidenceId) &&
    (evidence.discovery.method !== "interview" || evidenceIsAvailable(caseArtifact, session, evidenceId)) &&
    evidence.supportsFactIds.every((factId) => !character.secretFactIds.includes(factId) || factCanBeDisclosed(caseArtifact, session, characterId, factId));
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
    !character.knowledge.claimIds.includes(claim.id) ||
    (claim.kind !== "lie" && claim.factIds.some((factId) => !factCanBeDisclosed(caseArtifact, session, characterId, factId)))
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
    publicProfile: publicCharacterProfile(character),
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
