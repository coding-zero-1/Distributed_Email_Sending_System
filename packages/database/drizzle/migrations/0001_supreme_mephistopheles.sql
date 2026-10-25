ALTER TABLE "jobs" ADD COLUMN "idempotency_key" varchar(255);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "payload_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key");