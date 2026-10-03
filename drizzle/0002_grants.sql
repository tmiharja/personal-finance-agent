-- Privileges for app_user. Better Auth tables (user, session, account,
-- verification, passkey, rate_limit) get NO grants: app code can't read them.
GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  user_keys, accounts, imports, statements, categories, transactions, tags,
  transaction_tags, rules, subscriptions, bills, alerts, budgets,
  proposed_actions, usage
TO app_user;
--> statement-breakpoint
-- audit_log is append-only for the app: no UPDATE/DELETE grant, plus a trigger below.
GRANT SELECT, INSERT ON audit_log TO app_user;
--> statement-breakpoint
GRANT SELECT ON merchant_map TO app_user;
--> statement-breakpoint
-- Lets the app's (owner) connection switch to app_user with SET LOCAL ROLE.
-- On Neon the owner created app_user in 0000 and so holds ADMIN on it (PG16+).
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'app_user', 'SET') THEN
    EXECUTE format('GRANT app_user TO %I WITH SET TRUE', current_user);
  END IF;
END
$$;
--> statement-breakpoint
-- Append-only audit log. Rows may only disappear when their user is deleted
-- (FK cascade from account deletion). SECURITY DEFINER so the check can see
-- the "user" table, which app_user can't read.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = OLD.user_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
