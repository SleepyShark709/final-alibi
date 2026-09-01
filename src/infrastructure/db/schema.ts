import type { CaseArtifact } from "@/domain/case/case-artifact";
import type { GameSession } from "@/domain/game/game-runtime";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// 这些表共同保存领域真相、幂等命令和审计；LangGraph 自己的 checkpoint 位于独立 SQLite 文件。
export const anonymousPlayers = sqliteTable("anonymous_players", {
  id: text("id").primaryKey(),
  accessTokenHash: text("access_token_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});

export const caseArtifacts = sqliteTable(
  "case_artifacts",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    source: text("source", { enum: ["tutorial", "generated", "imported"] })
      .notNull(),
    status: text("status", {
      enum: ["validating", "ready", "rejected", "archived"],
    }).notNull(),
    seed: text("seed").notNull(),
    contentHash: text("content_hash").notNull(),
    artifactJson: text("artifact_json", { mode: "json" })
      .$type<CaseArtifact>()
      .notNull(),
    generationMetadataJson: text("generation_metadata_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_artifacts_seed_hash_unique").on(
      table.seed,
      table.contentHash,
    ),
    index("case_artifacts_status_idx").on(table.status),
  ],
);

export const gameSessions = sqliteTable(
  "game_sessions",
  {
    id: text("id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => anonymousPlayers.id, { onDelete: "cascade" }),
    caseId: text("case_id")
      .notNull()
      .references(() => caseArtifacts.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["investigating", "closed"] }).notNull(),
    revision: integer("revision").notNull().default(0),
    stateJson: text("state_json", { mode: "json" })
      .$type<GameSession>()
      .notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
  },
  (table) => [
    index("game_sessions_player_updated_idx").on(
      table.playerId,
      table.updatedAt,
    ),
    index("game_sessions_case_idx").on(table.caseId),
  ],
);

export const gameEvents = sqliteTable(
  "game_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    commandId: text("command_id").notNull(),
    type: text("type").notNull(),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    uniqueIndex("game_events_session_sequence_unique").on(
      table.sessionId,
      table.sequence,
    ),
    index("game_events_session_command_idx").on(
      table.sessionId,
      table.commandId,
    ),
  ],
);

export const gameCommands = sqliteTable(
  "game_commands",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    playerId: text("player_id")
      .notNull()
      .references(() => anonymousPlayers.id, { onDelete: "cascade" }),
    commandId: text("command_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status", {
      enum: ["running", "committed", "failed"],
    }).notNull(),
    baseRevision: integer("base_revision").notNull(),
    committedRevision: integer("committed_revision"),
    requestJson: text("request_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    resultJson: text("result_json", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("game_commands_session_command_unique").on(
      table.sessionId,
      table.commandId,
    ),
    index("game_commands_status_updated_idx").on(table.status, table.updatedAt),
  ],
);

// 生成等长任务必须经过 durable queue，不能依赖单个 Next.js 请求的存活时间。
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    playerId: text("player_id").references(() => anonymousPlayers.id, {
      onDelete: "cascade",
    }),
    type: text("type", {
      enum: ["generate_case", "validate_case", "blind_solve", "summarize"],
    }).notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    // UI 轮询的可观测状态；它不是业务真相，也不能替代 status 的终态语义。
    stage: text("stage", {
      enum: [
        "queued",
        "starting",
        "drafting",
        "validating",
        "repairing",
        "blind_solving",
        "finalizing",
        "succeeded",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("queued"),
    progress: integer("progress").notNull().default(0),
    payloadJson: text("payload_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    resultJson: text("result_json", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [index("jobs_status_created_idx").on(table.status, table.createdAt)],
);

export const modelRuns = sqliteTable(
  "model_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").references(() => gameSessions.id, {
      onDelete: "set null",
    }),
    caseId: text("case_id").references(() => caseArtifacts.id, {
      onDelete: "set null",
    }),
    commandId: text("command_id"),
    graphName: text("graph_name").notNull(),
    nodeName: text("node_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptHash: text("prompt_hash").notNull(),
    status: text("status", { enum: ["running", "succeeded", "failed"] })
      .notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estimatedCostMicrosCny: integer("estimated_cost_micros_cny")
      .notNull()
      .default(0),
    requestJson: text("request_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    responseJson: text("response_json", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("model_runs_session_created_idx").on(table.sessionId, table.createdAt),
    index("model_runs_case_created_idx").on(table.caseId, table.createdAt),
  ],
);

export const agentThreads = sqliteTable(
  "agent_threads",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    characterId: text("character_id").notNull(),
    graphName: text("graph_name").notNull(),
    checkpointThreadId: text("checkpoint_thread_id").notNull(),
    revision: integer("revision").notNull().default(0),
    stateJson: text("state_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_threads_session_character_graph_unique").on(
      table.sessionId,
      table.characterId,
      table.graphName,
    ),
    uniqueIndex("agent_threads_checkpoint_unique").on(table.checkpointThreadId),
  ],
);
