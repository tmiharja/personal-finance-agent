ALTER TABLE "audit_log" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "proposed_actions" ADD COLUMN "undone_at" timestamp with time zone;