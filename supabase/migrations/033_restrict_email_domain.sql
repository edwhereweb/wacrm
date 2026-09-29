-- ============================================================
-- 033_restrict_email_domain.sql
-- Enforces that only emails ending in @edwhere.com can exist
-- in the application by blocking inserts and updates to auth.users.
-- ============================================================

CREATE OR REPLACE FUNCTION public.restrict_email_domain()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email NOT ILIKE '%@edwhere.com' THEN
    RAISE EXCEPTION 'Only @edwhere.com emails are allowed in this application.';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.restrict_email_domain() OWNER TO postgres;

DROP TRIGGER IF EXISTS restrict_email_domain_trigger ON auth.users;

CREATE TRIGGER restrict_email_domain_trigger
  BEFORE INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.restrict_email_domain();
