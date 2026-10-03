ALTER TABLE "accounts" ADD COLUMN "identity_key" char(64);--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_key_uq" ON "accounts" USING btree ("user_id","identity_key");