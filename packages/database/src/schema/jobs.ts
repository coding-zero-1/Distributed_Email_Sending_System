import {
  pgEnum,
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "processing",
  "completed",
  "failed",
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),

  status: jobStatusEnum("status")
    .notNull()
    .default("queued"),

  recipient: varchar("recipient", { length: 320 }).notNull(),
  subject: varchar("subject", { length: 200 }).notNull(),
  text: text("text").notNull(),

  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  resultMessageId: text("result_message_id"),

  createdAt: timestamp("created_at", {
    withTimezone: true,
  }).notNull().defaultNow(),

  startedAt: timestamp("started_at", {
    withTimezone: true,
  }),

  completedAt: timestamp("completed_at", {
    withTimezone: true,
  }),

  updatedAt: timestamp("updated_at", {
    withTimezone: true,
  }).notNull().defaultNow(),
});
