-- app_user: the role all app queries run as (via SET LOCAL ROLE in withUser()).
-- No LOGIN, no BYPASSRLS, so Row-Level Security always applies to it.
-- Roles are cluster-wide, so creation is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
