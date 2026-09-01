import { validatePublishableCaseArtifact } from "@/domain/case/case-validator";
import { getServerServices } from "@/server/services";

void main().catch((error: unknown) => {
  console.error("[live-audit] failed", error);
  process.exitCode = 1;
});

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required for the paid live generation audit");
  }

  const services = await getServerServices();
  const count = readCount(process.env.LIVE_AUDIT_CASES);
  const themes = [
    "深夜闭馆后的城市美术馆",
    "暴雪封路的山间酒店",
    "停航中的近海研究船",
    "封闭排练中的老剧院",
    "断电后的智能办公楼",
  ];
  let totalCostMicrosCny = 0;

  try {
    for (let index = 1; index <= count; index += 1) {
      const seed = `live-audit-${Date.now()}-${index}`;
      const result = await services.generation.generateNow({
        seed,
        theme: themes[(index - 1) % themes.length]!,
        difficulty: index % 3 === 0 ? "hard" : "standard",
      });
      const validation = validatePublishableCaseArtifact(result.caseArtifact);
      if (!validation.valid) {
        throw new Error(`published case ${result.caseArtifact.id} failed validation`);
      }
      totalCostMicrosCny += result.estimatedCostMicrosCny;
      console.log(
        `[live-audit] ${index}/${count} ${result.caseArtifact.id} accepted after ${result.attemptCount} artifact attempt(s)`,
      );
    }
    console.log(
      `[live-audit] complete; estimated generation cost ¥${(totalCostMicrosCny / 1_000_000).toFixed(4)}`,
    );
  } finally {
    services.database.close();
  }
}

function readCount(value: string | undefined) {
  const parsed = Number(value ?? "10");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error("LIVE_AUDIT_CASES must be an integer from 1 to 50");
  }
  return parsed;
}
