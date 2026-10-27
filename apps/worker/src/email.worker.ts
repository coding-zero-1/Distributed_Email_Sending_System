import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db, jobs } from "@repo/database";
import { createRedisConnection } from "@repo/queue";
import { mailer } from "./mailer.js";

export async function processEmailJob(job: {
  data: {
    id: string;
    to: string;
    subject: string;
    text: string;
  };
  attemptsMade: number;
  opts: {
    attempts?: number;
  };
}) {
  const { id, to, subject, text } = job.data;

  const currentAttempt = job.attemptsMade + 1;
  const totalAttempts = job.opts.attempts ?? 1;

  console.log(
    `Processing job ${id}, attempt ${currentAttempt}/${totalAttempts}`,
  );

  // Avoid resending jobs already recorded as completed.
  const [existingJob] = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);

  if (!existingJob) {
    throw new Error(`Job ${id} does not exist in PostgreSQL`);
  }

  if (existingJob.status === "completed") {
    console.log(`Job ${id} is already completed; skipping`);
    return;
  }

  await db
    .update(jobs)
    .set({
      status: "processing",
      attempts: currentAttempt,
      startedAt: new Date(),
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id));

  let info;
  try {
    info = await mailer.sendMail({
      from: process.env.GMAIL_USER ?? "no-reply@test.local",
      to,
      subject,
      text,
    });
  } catch (mailError) {
    const message =
      mailError instanceof Error ? mailError.message : String(mailError);

    const exhaustedRetries = currentAttempt >= totalAttempts;

    try {
      await db
        .update(jobs)
        .set({
          status: exhaustedRetries ? "failed" : "queued",
          attempts: currentAttempt,
          error: message,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, id));
    } catch (databaseError) {
      console.error(
        `Could not update PostgreSQL state for job ${id}`,
        databaseError,
      );
    }

    console.error(
      `Job ${id} failed on attempt ${currentAttempt}/${totalAttempts}: ${message}`,
    );

    throw mailError;
  }

  try {
    await db
      .update(jobs)
      .set({
        status: "completed",
        attempts: currentAttempt,
        resultMessageId: info.messageId,
        completedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, id));

    console.log(`Job ${id} completed`);
    console.log(`Message ID: ${info.messageId}`);

    return { messageId: info.messageId };
  } catch (dbError) {
    console.error(
      `CRITICAL: Email for job ${id} was delivered successfully (Message ID: ${info.messageId}), but updating PostgreSQL state failed:`,
      dbError,
    );
    return { messageId: info.messageId };
  }
}

export const worker = new Worker("email", processEmailJob, {
  connection: createRedisConnection(),
  concurrency: 1,
});

worker.on("completed", (job) => {
  console.log(`BullMQ job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`BullMQ job ${job?.id} failed: ${error.message}`);
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

console.log("Email worker started");