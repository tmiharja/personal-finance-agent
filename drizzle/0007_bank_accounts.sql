ALTER TYPE "public"."txn_kind" ADD VALUE 'income';--> statement-breakpoint
ALTER TYPE "public"."txn_kind" ADD VALUE 'transfer';--> statement-breakpoint
ALTER TABLE "statements" ALTER COLUMN "previous_balance_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ALTER COLUMN "total_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ALTER COLUMN "reconciled" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "transfer_pair_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "transfer_account_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_pair_id_transactions_id_fk" FOREIGN KEY ("transfer_pair_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_account_id_accounts_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Ownership check for transactions.transfer_pair_id. A policy on transactions
-- can't query transactions itself (infinite recursion), so this runs as the
-- owner and compares the pair's user with the session's app.user_id.
CREATE OR REPLACE FUNCTION app_owns_transaction(txn uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = txn AND t.user_id = current_setting('app.user_id', true)
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_owns_transaction(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_owns_transaction(uuid) TO app_user;--> statement-breakpoint
ALTER POLICY "transactions_own_rows" ON "transactions" TO app_user USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true) and (transactions.account_id is null or exists (select 1 from accounts p where p.id = transactions.account_id)) and (transactions.statement_id is null or exists (select 1 from statements p where p.id = transactions.statement_id)) and (transactions.category_id is null or exists (select 1 from categories p where p.id = transactions.category_id)) and (transactions.transfer_account_id is null or exists (select 1 from accounts p where p.id = transactions.transfer_account_id)) and (transactions.transfer_pair_id is null or app_owns_transaction(transactions.transfer_pair_id)));