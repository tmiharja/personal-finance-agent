ALTER TYPE "public"."import_status" ADD VALUE 'discarded';--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "preview_enc" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "expires_at" timestamp with time zone;