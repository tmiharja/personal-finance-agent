ALTER TABLE "alerts" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "occurred_on" date;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "last_paid_on" date;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "last_amount_cents" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "charges" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "first_charge_date" date;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "previous_amount_cents" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "price_changed_on" date;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "ignored" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bills_payee_uq" ON "bills" USING btree ("user_id","payee","source");