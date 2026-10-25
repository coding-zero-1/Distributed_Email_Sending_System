import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { emailQueue } from "@repo/queue";
import { db, jobs } from "@repo/database";
import { eq, count } from "drizzle-orm";
import {
  z,
  emailJobSchema,
  jobIdParamSchema,
  idempotencyKeySchema,
  computePayloadHash,
} from "@repo/contracts";

const app: Express = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
  });
});

/**
 * GET /jobs/stats
 *
 * Returns aggregate job counts grouped by status.  This endpoint exists
 * primarily for operational observability and load-test monitoring.
 * It runs a single GROUP BY aggregate query — do NOT call it on the hot
 * submission path.
 *
 * Response: { queued, processing, completed, failed, total }
 */
app.get("/jobs/stats", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db
      .select({ status: jobs.status, count: count() })
      .from(jobs)
      .groupBy(jobs.status);

    const result: Record<string, number> = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };

    for (const row of rows) {
      result[row.status] = Number(row.count);
    }

    return res.json({
      ...result,
      total: Object.values(result).reduce((a, b) => a + b, 0),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/jobs/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = jobIdParamSchema.safeParse(req.params);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Invalid UUID format",
        message: "The provided job ID is not a valid UUID",
      });
    }

    const { id } = parseResult.data;

    const [jobRecord] = await db
      .select({
        id: jobs.id,
        status: jobs.status,
        recipient: jobs.recipient,
        subject: jobs.subject,
        attempts: jobs.attempts,
        error: jobs.error,
        resultMessageId: jobs.resultMessageId,
        createdAt: jobs.createdAt,
        startedAt: jobs.startedAt,
        completedAt: jobs.completedAt,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);

    if (!jobRecord) {
      return res.status(404).json({
        error: "Job not found",
        message: `Job with ID '${id}' was not found`,
      });
    }

    return res.status(200).json(jobRecord);
  } catch (error) {
    next(error);
  }
});

app.post("/jobs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = emailJobSchema.parse(req.body);

    const rawIdempotencyKey = req.headers["idempotency-key"];
    let idempotencyKey: string | null = null;
    let payloadHash: string | null = null;

    if (rawIdempotencyKey !== undefined) {
      const keyHeader = Array.isArray(rawIdempotencyKey)
        ? rawIdempotencyKey[0]
        : rawIdempotencyKey;

      const parsedKey = idempotencyKeySchema.safeParse(keyHeader);
      if (!parsedKey.success) {
        return res.status(400).json({
          error: "Invalid Idempotency-Key header",
          message:
            parsedKey.error.issues[0]?.message ||
            "Idempotency-Key must be between 1 and 255 characters",
        });
      }

      idempotencyKey = parsedKey.data;
      payloadHash = computePayloadHash(email);
    }

    // 1. If an idempotency key was supplied, handle idempotent creation/deduplication
    if (idempotencyKey && payloadHash) {
      const [insertedJob] = await db
        .insert(jobs)
        .values({
          recipient: email.to,
          subject: email.subject,
          text: email.text,
          idempotencyKey,
          payloadHash,
        })
        .onConflictDoNothing({ target: jobs.idempotencyKey })
        .returning({ id: jobs.id });

      if (!insertedJob) {
        // Unique conflict: row with this idempotency key already exists
        const [existingJob] = await db
          .select({
            id: jobs.id,
            status: jobs.status,
            payloadHash: jobs.payloadHash,
          })
          .from(jobs)
          .where(eq(jobs.idempotencyKey, idempotencyKey))
          .limit(1);

        if (!existingJob) {
          throw new Error("Failed to retrieve existing job record");
        }

        if (existingJob.payloadHash !== payloadHash) {
          return res.status(409).json({
            error: "Conflict",
            message:
              "An existing job with this idempotency key was submitted with different payload parameters.",
          });
        }

        return res.status(200).json({
          jobId: existingJob.id,
          status: existingJob.status,
        });
      }

      // New row created: enqueue to BullMQ using the PostgreSQL UUID
      try {
        await emailQueue.add(
          "send-email",
          {
            id: insertedJob.id,
            ...email,
          },
          {
            jobId: insertedJob.id,
            attempts: 3,
            backoff: {
              type: "exponential",
              delay: 1000,
            },
          },
        );
      } catch (error) {
        await db
          .update(jobs)
          .set({
            status: "failed",
            error:
              error instanceof Error
                ? error.message
                : "Failed to enqueue job",
            updatedAt: new Date(),
          })
          .where(eq(jobs.id, insertedJob.id));

        throw error;
      }

      return res.status(202).json({
        jobId: insertedJob.id,
        status: "queued",
      });
    }

    // 2. Request without idempotency key: create job without deduplication
    const [createdJob] = await db
      .insert(jobs)
      .values({
        recipient: email.to,
        subject: email.subject,
        text: email.text,
        idempotencyKey: null,
        payloadHash: null,
      })
      .returning({ id: jobs.id });

    try {
      await emailQueue.add(
        "send-email",
        {
          id: createdJob.id,
          ...email,
        },
        {
          jobId: createdJob.id,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
        },
      );
    } catch (error) {
      await db
        .update(jobs)
        .set({
          status: "failed",
          error:
            error instanceof Error ? error.message : "Failed to enqueue job",
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, createdJob.id));

      throw error;
    }

    return res.status(202).json({
      jobId: createdJob.id,
      status: "queued",
    });
  } catch (error) {
    next(error);
  }
});

// Centralized error-handling middleware
app.use(
  (
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    console.error("Unhandled API error:", err);

    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: "Validation error",
        message: err.issues.map((i) => i.message).join(", "),
        details: err.issues,
      });
    }

    if (
      err instanceof SyntaxError &&
      "status" in err &&
      (err as { status: number }).status === 400
    ) {
      return res.status(400).json({
        error: "Invalid JSON",
        message: "Malformed JSON in request body",
      });
    }

    return res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while processing the request",
    });
  },
);

export default app;
