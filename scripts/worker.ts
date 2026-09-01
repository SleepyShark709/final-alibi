import { processNextCaseGenerationJob } from "@/application/generation/case-generation-service";
import { getServerServices } from "@/server/services";

const runOnce = process.argv.includes("--once");
const pollMs = readPositiveInteger(process.env.WORKER_POLL_MS, 2_000);
let stopping = false;

process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

void runWorker().catch((error: unknown) => {
  console.error("[worker] fatal startup error", error);
  process.exitCode = 1;
});

async function runWorker() {
  // Worker 与 web 共享领域 SQLite/数据卷；启动时先回收中断任务，再串行认领一个 durable job。
  const services = await getServerServices();
  const recovered = await services.repository.recoverStaleJobs();
  if (recovered > 0) console.log(`[worker] recovered ${recovered} stale job(s)`);
  console.log(`[worker] ready; poll interval ${pollMs}ms`);

  try {
    do {
      try {
        const result = await processNextCaseGenerationJob(
          services.repository,
          services.generation,
        );
        if (result) {
          console.log(`[worker] ${result.jobId}: ${result.status}`);
        } else if (runOnce) {
          console.log("[worker] no queued jobs");
        }
        if (!result && !runOnce && !stopping) await delay(pollMs);
      } catch (error) {
        console.error("[worker] unexpected loop error", error);
        if (runOnce) throw error;
        if (!stopping) await delay(Math.min(pollMs * 2, 10_000));
      }
    } while (!runOnce && !stopping);
  } finally {
    services.database.close();
    console.log("[worker] stopped");
  }
}

function requestStop() {
  // 当前调用结束后退出，finally 会关闭数据库连接；不会在 SIGTERM 时强杀到一半的提交事务。
  stopping = true;
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
