import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createLangGraphCheckpointer } from "./checkpointer";

describe("LangGraph SQLite checkpointer", () => {
  it("restores graph state by thread id", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "spy-game-graph-test-"));
    const checkpointer = createLangGraphCheckpointer(
      path.join(directory, "checkpoints.sqlite"),
    );
    const State = new StateSchema({ count: z.number().int() });
    const graph = new StateGraph(State)
      .addNode("increment", (state) => ({ count: state.count + 1 }))
      .addEdge(START, "increment")
      .addEdge("increment", END)
      .compile({ checkpointer });
    const config = { configurable: { thread_id: "thread_checkpoint_test" } };

    await graph.invoke({ count: 4 }, config);
    const restored = await graph.getState(config);

    expect(restored.values).toMatchObject({ count: 5 });
    checkpointer.db.close();
    await rm(directory, { recursive: true, force: true });
  });
});
