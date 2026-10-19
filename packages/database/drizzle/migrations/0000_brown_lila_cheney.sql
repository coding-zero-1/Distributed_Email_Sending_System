CREATE TYPE "public"."job_status" AS ENUM('queued', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"recipient" varchar(320) NOT NULL,
	"subject" varchar(200) NOT NULL,
	"text" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"result_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
