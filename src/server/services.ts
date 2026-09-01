import { DeepSeekModelProvider } from "@/ai/deepseek/deepseek-provider";
import { getLangGraphCheckpointer } from "@/ai/langgraph/checkpointer";
import { DialogueService } from "@/application/dialogue/dialogue-service";
import { CaseGenerationService } from "@/application/generation/case-generation-service";
import { GameService } from "@/application/game/game-service";
import { ReportFeedbackService } from "@/application/report/report-feedback-service";
import { getDatabase } from "@/infrastructure/db/database";
import { GameRepository } from "@/infrastructure/persistence/game-repository";

async function createServerServices() {
  const database = await getDatabase();
  const repository = new GameRepository(database);
  await repository.recoverStaleGameCommands();
  // Provider 在这里捕获运行时环境配置；因此容器重建/进程重启才会读取替换后的 API key。
  const provider = new DeepSeekModelProvider();
  const checkpointer = getLangGraphCheckpointer();
  const reportFeedback = new ReportFeedbackService(repository, provider);

  return {
    database,
    repository,
    game: new GameService(repository, reportFeedback),
    dialogue: new DialogueService(repository, provider, checkpointer),
    generation: new CaseGenerationService(repository, provider, checkpointer),
  };
}

type ServerServices = Awaited<ReturnType<typeof createServerServices>>;

const globalForServices = globalThis as typeof globalThis & {
  spyGameServices?: Promise<ServerServices>;
};

export function getServerServices(): Promise<ServerServices> {
  // 同一进程复用服务和 SQLite 连接，避免每个 Route Handler 请求重复跑迁移或创建 checkpointer。
  globalForServices.spyGameServices ??= createServerServices();
  return globalForServices.spyGameServices;
}
