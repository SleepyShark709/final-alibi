import { mkdirSync } from "node:fs";
import path from "node:path";

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export function createLangGraphCheckpointer(
  configuredPath =
    process.env.LANGGRAPH_CHECKPOINT_PATH ??
    path.join(process.cwd(), "data", "langgraph-checkpoints.sqlite"),
): SqliteSaver {
  // checkpoint 仅帮助图恢复节点执行；案件、session、事件的业务真相永远写入 GameRepository 的领域库。
  if (configuredPath !== ":memory:") {
    const absolutePath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(/* turbopackIgnore: true */ process.cwd(), configuredPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    return SqliteSaver.fromConnString(absolutePath);
  }
  return SqliteSaver.fromConnString(configuredPath);
}

const globalForCheckpointer = globalThis as typeof globalThis & {
  spyGameCheckpointer?: SqliteSaver;
};

export function getLangGraphCheckpointer(): SqliteSaver {
  globalForCheckpointer.spyGameCheckpointer ??= createLangGraphCheckpointer();
  return globalForCheckpointer.spyGameCheckpointer;
}
