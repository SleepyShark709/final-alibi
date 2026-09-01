import { createHash } from "node:crypto";

import { z } from "zod";

import { createModelCallAudit } from "@/ai/model-audit";
import type {
  ModelMessage,
  StructuredModelProvider,
} from "@/ai/model-provider";
import type { CaseArtifact } from "@/domain/case/case-artifact";
import type { CaseReportResult } from "@/domain/game/game-runtime";
import type { GameRepository } from "@/infrastructure/persistence/game-repository";

export const reportFeedbackSchema = z
  .object({
    summary: z.string().trim().min(10).max(500),
    strengths: z.array(z.string().trim().min(2).max(180)).max(3),
    gaps: z.array(z.string().trim().min(2).max(180)).max(3),
  })
  .strict();

export type ReportFeedback = z.infer<typeof reportFeedbackSchema>;

export class ReportFeedbackService {
  constructor(
    private readonly repository: GameRepository,
    private readonly provider: StructuredModelProvider,
  ) {}

  async generate(input: {
    caseArtifact: CaseArtifact;
    report: CaseReportResult;
    sessionId: string;
    commandId: string;
    now?: string;
  }): Promise<ReportFeedback> {
    // 反馈是非关键增强：任意模型或审计故障都退回确定性文案，绝不改变已计算的分数。
    const messages = buildFeedbackMessages(input.caseArtifact, input.report);
    try {
      const result = await this.provider.invokeStructured({
        tier: "flash",
        schema: reportFeedbackSchema,
        schemaName: "detective_report_feedback",
        messages,
        temperature: 0.2,
        maxTokens: 900,
      });
      const audit = createModelCallAudit(
        "report_feedback",
        "flash",
        messages,
        result,
        input.now ? new Date(input.now) : new Date(),
      );
      const modelRunId = await this.repository.startModelRun({
        sessionId: input.sessionId,
        caseId: input.caseArtifact.id,
        commandId: input.commandId,
        graphName: "case_report",
        nodeName: audit.task,
        provider: "deepseek",
        model: audit.model,
        promptHash: createHash("sha256")
          .update(JSON.stringify(audit.request))
          .digest("hex"),
        request: audit.request,
        now: input.now,
      });
      await this.repository.finishModelRun({
        id: modelRunId,
        response: audit.response,
        inputTokens: audit.inputTokens,
        cachedInputTokens: audit.cachedInputTokens,
        outputTokens: audit.outputTokens,
        estimatedCostMicrosCny: audit.estimatedCostMicrosCny,
        now: input.now,
      });
      return result.value;
    } catch {
      return deterministicFeedback(input.report);
    }
  }
}

export function deterministicFeedback(report: CaseReportResult): ReportFeedback {
  const strengths: string[] = [];
  const gaps: string[] = [];
  const completeDossier = Object.values(report.correct).every(Boolean);
  if (report.correct.culprit) strengths.push("正确锁定了真凶。 ".trim());
  else gaps.push("真凶判断与完整证据链不符。 ".trim());
  if (report.correct.motive) strengths.push("动机判断与案件事实吻合。 ".trim());
  else gaps.push("动机判断仍有关键事实未被串联。 ".trim());
  if (report.correct.method) strengths.push("准确还原了作案手法。 ".trim());
  else gaps.push("作案手法的还原存在偏差。 ".trim());
  if (report.correct.evidence && report.correct.timeline) {
    strengths.push("证据与时间线形成了闭环。 ".trim());
  } else if (gaps.length < 3) {
    gaps.push("证据或时间线尚未完整覆盖定案所需节点。 ".trim());
  }
  return {
    summary:
      !report.correct.culprit
        ? `本次报告获得 ${report.score} 分；真凶指认未能与卷宗真相吻合。`
        : completeDossier
        ? "你的报告与卷宗真相一致，推理链条足以完成定案。"
        : `提前结案成功：你正确锁定了真凶，获得 ${report.score} 分；未完成的卷宗项目未计入得分。`,
    strengths: strengths.slice(0, 3),
    gaps: gaps.slice(0, 3),
  };
}

function buildFeedbackMessages(
  caseArtifact: CaseArtifact,
  report: CaseReportResult,
): ModelMessage[] {
  const factById = new Map(caseArtifact.facts.map((fact) => [fact.id, fact]));
  const evidenceById = new Map(
    caseArtifact.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const timelineById = new Map(
    caseArtifact.timeline.map((event) => [event.id, event]),
  );
  return [
    {
      role: "system",
      content: [
        "你是中文推理游戏的结案教练。案件已经结束，可依据真相给玩家复盘。",
        "固定分数与各项正误是确定性规则的结果，绝不能改分或质疑评分。",
        "评价玩家提交的推理陈述如何使用证据；不要假称玩家写了未写的内容。",
        "语气冷静、具体、鼓励复盘。summary 1–3 句，strengths 与 gaps 各最多 3 条。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          truth: {
            culpritId: caseArtifact.solution.culpritId,
            motive: factById.get(caseArtifact.solution.motiveFactId)?.statement,
            method: factById.get(caseArtifact.solution.methodFactId)?.statement,
            requiredEvidence: caseArtifact.solution.requiredEvidenceIds.map(
              (id) => ({ id, description: evidenceById.get(id)?.description }),
            ),
            requiredTimeline: caseArtifact.solution.requiredTimelineEventIds.map(
              (id) => ({ id, description: timelineById.get(id)?.description }),
            ),
          },
          deterministicResult: {
            verdict: report.verdict,
            score: report.score,
            correct: report.correct,
            missedEvidenceIds: report.missedEvidenceIds,
            missedTimelineEventIds: report.missedTimelineEventIds,
          },
          playerSubmission: report.submitted,
        },
        null,
        2,
      ),
    },
  ];
}
