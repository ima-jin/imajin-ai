-- Auto-cleanup function for registry.logs
-- Deletes entries older than N days (default 30)

CREATE OR REPLACE FUNCTION registry.cleanup_old_logs(p_days INT DEFAULT 30)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM registry.logs
  WHERE created_at < now() - (p_days || ' days')::interval;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Also clean up legacy tables that are no longer written to
CREATE OR REPLACE FUNCTION registry.cleanup_legacy_logs(p_days INT DEFAULT 30)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM registry.request_log
  WHERE created_at < now() - (p_days || ' days')::interval;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  DELETE FROM registry.app_logs
  WHERE created_at < now() - (p_days || ' days')::interval;

  RETURN deleted_count;
END;
$$;
