import { z } from "zod";
import { createHash } from "node:crypto";
import type { EmailJob } from "./email.js";

export const jobStatusEnumSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);
export type JobStatus = z.infer<typeof jobStatusEnumSchema>;

export const jobIdParamSchema = z.object({
  id: z.uuid({ message: "Invalid UUID format" }),
});
export type JobIdParam = z.infer<typeof jobIdParamSchema>;

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1, { message: "Idempotency-Key must not be empty" })
  .max(255, { message: "Idempotency-Key cannot exceed 255 characters" });
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

export const jobStatusResponseSchema = z.object({
  id: z.uuid(),
  status: jobStatusEnumSchema,
  recipient: z.string(),
  subject: z.string(),
  attempts: z.number().int(),
  error: z.string().nullable(),
  resultMessageId: z.string().nullable(),
  createdAt: z.union([z.string(), z.date()]),
  startedAt: z.union([z.string(), z.date()]).nullable(),
  completedAt: z.union([z.string(), z.date()]).nullable(),
  updatedAt: z.union([z.string(), z.date()]),
});
export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>;

export const createJobResponseSchema = z.object({
  jobId: z.uuid(),
  status: jobStatusEnumSchema,
});
export type CreateJobResponse = z.infer<typeof createJobResponseSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export function computePayloadHash(payload: EmailJob): string {
  const canonical = JSON.stringify({
    subject: payload.subject,
    text: payload.text,
    to: payload.to,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
