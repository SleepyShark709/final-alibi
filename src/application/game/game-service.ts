import { randomUUID } from "node:crypto";

import { tutorialCase } from "@/content/tutorial/tutorial-case";
import {
  getCaseReview,
  getPlayerCaseView,
  performInvestigation,
  presentEvidence,
  requestHint,
  submitCaseReport,
  type SubmitCaseReportCommand,
} from "@/domain/game/game-runtime";
import type { GameRepository } from "@/infrastructure/persistence/game-repository";
import type { ReportFeedbackService } from "@/application/report/report-feedback-service";

export class GameService {
  constructor(
    private readonly repository: GameRepository,
    private readonly reportFeedback?: ReportFeedbackService,
  ) {}

  async initializeContent(now?: string) {
    await this.repository.registerCase(tutorialCase, "tutorial", { now });
  }

  async getLobby(playerId: string) {
    await this.initializeContent();
    const [cases, sessions] = await Promise.all([
      this.repository.listReadyCases(),
      this.repository.listGames(playerId),
    ]);
    // 历史教程账本只服务于旧存档；新开调查始终只展示当前教程。
    const visibleCases = cases.filter(
      (caseItem) =>
        caseItem.source !== "tutorial" || caseItem.id === tutorialCase.id,
    );
    const caseTitleById = new Map(cases.map((caseItem) => [caseItem.id, caseItem.title]));

    return {
      cases: visibleCases,
      sessions: sessions.map((session) => ({
        id: session.id,
        caseId: session.caseId,
        caseTitle: caseTitleById.get(session.caseId) ?? session.caseId,
        status: session.status,
        revision: session.revision,
        updatedAt: session.updatedAt,
        score: session.report?.score,
      })),
    };
  }

  async startGame(playerId: string, caseId: string, now?: string) {
    await this.initializeContent(now);
    const caseArtifact = await this.repository.getReadyCase(caseId);
    const game = await this.repository.createGame(playerId, caseArtifact, {
      sessionId: `game_${randomUUID().replaceAll("-", "")}`,
      now,
    });
    return getPlayerCaseView(game.caseArtifact, game.session);
  }

  async getGame(playerId: string, sessionId: string) {
    const game = await this.repository.loadGame(playerId, sessionId);
    return getPlayerCaseView(game.caseArtifact, game.session);
  }

  async investigate(input: {
    playerId: string;
    sessionId: string;
    commandId: string;
    expectedRevision: number;
    text: string;
    sceneId?: string;
    objectId?: string;
    characterId?: string;
    now?: string;
  }) {
    const persisted = await this.repository.executeGameCommand(
      {
        playerId: input.playerId,
        sessionId: input.sessionId,
        commandId: input.commandId,
        kind: "investigate",
        expectedRevision: input.expectedRevision,
        request: {
          text: input.text,
          sceneId: input.sceneId,
          objectId: input.objectId,
          characterId: input.characterId,
        },
        now: input.now,
      },
      (caseArtifact, session) =>
        performInvestigation(caseArtifact, session, {
          commandId: input.commandId,
          text: input.text,
          sceneId: input.sceneId,
          objectId: input.objectId,
          characterId: input.characterId,
          now: input.now,
        }),
    );
    const game = await this.repository.loadGame(input.playerId, input.sessionId);
    return {
      outcome: persisted.outcome,
      replayed: persisted.replayed,
      view: getPlayerCaseView(game.caseArtifact, persisted.session),
    };
  }

  async useHint(input: {
    playerId: string;
    sessionId: string;
    commandId: string;
    expectedRevision: number;
    targetFactId?: string;
    now?: string;
  }) {
    const persisted = await this.repository.executeGameCommand(
      {
        playerId: input.playerId,
        sessionId: input.sessionId,
        commandId: input.commandId,
        kind: "hint",
        expectedRevision: input.expectedRevision,
        request: { targetFactId: input.targetFactId },
        now: input.now,
      },
      (caseArtifact, session) =>
        requestHint(caseArtifact, session, {
          commandId: input.commandId,
          targetFactId: input.targetFactId,
          now: input.now,
        }),
    );
    const game = await this.repository.loadGame(input.playerId, input.sessionId);
    return {
      outcome: persisted.outcome,
      replayed: persisted.replayed,
      view: getPlayerCaseView(game.caseArtifact, persisted.session),
    };
  }

  async showEvidence(input: {
    playerId: string;
    sessionId: string;
    commandId: string;
    expectedRevision: number;
    characterId: string;
    evidenceId: string;
    now?: string;
  }) {
    const persisted = await this.repository.executeGameCommand(
      {
        playerId: input.playerId,
        sessionId: input.sessionId,
        commandId: input.commandId,
        kind: "present_evidence",
        expectedRevision: input.expectedRevision,
        request: {
          characterId: input.characterId,
          evidenceId: input.evidenceId,
        },
        now: input.now,
      },
      (caseArtifact, session) =>
        presentEvidence(caseArtifact, session, {
          commandId: input.commandId,
          characterId: input.characterId,
          evidenceId: input.evidenceId,
          now: input.now,
        }),
    );
    const game = await this.repository.loadGame(input.playerId, input.sessionId);
    return {
      outcome: persisted.outcome,
      replayed: persisted.replayed,
      view: getPlayerCaseView(game.caseArtifact, persisted.session),
    };
  }

  async submitReport(
    input: {
      playerId: string;
      sessionId: string;
      expectedRevision: number;
    } & SubmitCaseReportCommand,
  ) {
    const persisted = await this.repository.executeGameCommand(
      {
        playerId: input.playerId,
        sessionId: input.sessionId,
        commandId: input.commandId,
        kind: "submit_report",
        expectedRevision: input.expectedRevision,
        request: {
          culpritId: input.culpritId,
          motiveFactId: input.motiveFactId,
          methodFactId: input.methodFactId,
          evidenceIds: input.evidenceIds,
          timelineEventIds: input.timelineEventIds,
          reasoning: input.reasoning,
        },
        now: input.now,
      },
      async (caseArtifact, session) => {
        // 先得到确定性分数，再可选地调用模型润色复盘；模型失败不能影响结案结果。
        const evaluated = submitCaseReport(caseArtifact, session, input);
        if (evaluated.outcome.status !== "submitted") return evaluated;
        const feedback = this.reportFeedback
          ? await this.reportFeedback.generate({
              caseArtifact,
              report: evaluated.outcome.report,
              sessionId: session.id,
              commandId: input.commandId,
              now: input.now,
            })
          : undefined;
        if (!feedback) return evaluated;
        const report = { ...evaluated.outcome.report, feedback };
        return {
          session: { ...evaluated.session, report },
          outcome: { ...evaluated.outcome, report },
        };
      },
    );
    const game = await this.repository.loadGame(input.playerId, input.sessionId);
    return {
      outcome: persisted.outcome,
      replayed: persisted.replayed,
      view: getPlayerCaseView(game.caseArtifact, persisted.session),
      review: getCaseReview(game.caseArtifact, persisted.session),
    };
  }

  async getReview(playerId: string, sessionId: string) {
    const game = await this.repository.loadGame(playerId, sessionId);
    return getCaseReview(game.caseArtifact, game.session);
  }
}
