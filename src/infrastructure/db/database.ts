import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import * as schema from "./schema";

export interface DatabaseOptions {
  url?: string;
  authToken?: string;
  migrationsFolder?: string;
  runMigrations?: boolean;
}

export interface DatabaseHandle {
  client: Client;
  db: LibSQLDatabase<typeof schema>;
  close: () => void;
}

export async function createDatabase(
  options: DatabaseOptions = {},
): Promise<DatabaseHandle> {
  // 本地文件库使用 WAL：同一台主机上读写可并行，但 SQLite 仍只有一个 writer，故不支持横向多机扩容。
  const configuredUrl = options.url ?? process.env.DATABASE_URL ?? "file:data/spy-game.sqlite";
  const url = await normalizeDatabaseUrl(configuredUrl);
  const client = createClient({
    url,
    authToken: options.authToken ?? process.env.DATABASE_AUTH_TOKEN,
  });
  const db = drizzle(client, { schema });

  if (url.startsWith("file:")) {
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 5000");
    if (url !== "file::memory:") {
      await client.execute("PRAGMA journal_mode = WAL");
      await client.execute("PRAGMA synchronous = NORMAL");
    }
  }

  if (options.runMigrations ?? true) {
    await migrate(db, {
      migrationsFolder:
        options.migrationsFolder ?? path.join(process.cwd(), "drizzle"),
    });
  }

  return {
    client,
    db,
    close: () => client.close(),
  };
}

const globalForDatabase = globalThis as typeof globalThis & {
  spyGameDatabase?: Promise<DatabaseHandle>;
};

export function getDatabase(): Promise<DatabaseHandle> {
  globalForDatabase.spyGameDatabase ??= createDatabase();
  return globalForDatabase.spyGameDatabase;
}

async function normalizeDatabaseUrl(configuredUrl: string): Promise<string> {
  if (!configuredUrl.startsWith("file:") || configuredUrl === "file::memory:") {
    return configuredUrl;
  }

  const configuredPath = configuredUrl.slice("file:".length);
  const absolutePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), configuredPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  return `file:${absolutePath}`;
}
