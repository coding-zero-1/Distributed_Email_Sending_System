import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";
import { config } from "dotenv";
import { resolve } from "node:path";

if (!process.env.DATABASE_URL) {
  config({ path: resolve(import.meta.dirname, "../../../.env") });
  if (!process.env.DATABASE_URL) {
    config({ path: resolve(process.cwd(), ".env") });
  }
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not configured");
}

export const pool = new Pool({
  connectionString,
  max: 10,
});

export const db = drizzle({
  client: pool,
  schema,
});
