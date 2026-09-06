import type { ModelMessage } from "@/ai/model-provider";
import type { BlindSolveResult } from "../generation-schema";

/** 测试脚本用实体名称选取本次请求提供的编号，模拟模型遵循盲测协议。 */
export class ScriptedBlindProtocol {
  private readonly names = new Map<string, string>();

  reply(request: { schemaName: string; messages: ModelMessage[] }, response: unknown): unknown {
    if (request.schemaName !== "blind_case_solution") {
      const value = response instanceof Error && "input" in response ? response.input : response;
      if (value && typeof value === "object") {
        const record = value as { characters?: unknown[]; evidence?: unknown[] };
        for (const item of [...(record.characters ?? []), ...(record.evidence ?? [])]) {
          if (item && typeof item === "object" && "id" in item && "name" in item &&
            typeof item.id === "string" && typeof item.name === "string") this.names.set(item.id, item.name);
        }
      }
      return response;
    }
    if (response === undefined || response instanceof Error) return response;
    const dossier = JSON.parse(request.messages[1]!.content) as {
      suspects: Array<{ id: string; name: string }>;
      fullyDiscoveredEvidence: Array<{ id: string; name: string }>;
    };
    const result = response as BlindSolveResult;
    const providedId = (id: string, entities: Array<{ id: string; name: string }>) =>
      entities.find((item) => item.name === this.names.get(id))?.id ?? id;
    return {
      ...result,
      culpritId: providedId(result.culpritId, dossier.suspects),
      evidenceIds: result.evidenceIds.map((id) => providedId(id, dossier.fullyDiscoveredEvidence)),
    };
  }
}
