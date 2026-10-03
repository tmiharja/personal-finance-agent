CREATE TABLE "demo_quota" (
	"key" char(64) NOT NULL,
	"day" date NOT NULL,
	"workspaces" integer DEFAULT 0 NOT NULL,
	"questions" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "demo_quota_key_day_pk" PRIMARY KEY("key","day")
);
--> statement-breakpoint
CREATE TABLE "llm_spend_archive" (
	"month" date PRIMARY KEY NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_anonymous" boolean DEFAULT false;