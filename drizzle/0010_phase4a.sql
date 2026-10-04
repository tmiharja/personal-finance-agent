ALTER TYPE "public"."bank" ADD VALUE 'CITI';--> statement-breakpoint
ALTER TYPE "public"."bank" ADD VALUE 'HSBC';--> statement-breakpoint
ALTER TYPE "public"."bank" ADD VALUE 'SCB';--> statement-breakpoint
ALTER TYPE "public"."bank" ADD VALUE 'MAYBANK';--> statement-breakpoint
ALTER TYPE "public"."bank" ADD VALUE 'AMEX';--> statement-breakpoint
ALTER TYPE "public"."bank" ADD VALUE 'OTHER';--> statement-breakpoint
CREATE TABLE "parse_stats" (
	"day" date NOT NULL,
	"bank" text NOT NULL,
	"method" text NOT NULL,
	"outcome" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "parse_stats_day_bank_method_outcome_pk" PRIMARY KEY("day","bank","method","outcome")
);
