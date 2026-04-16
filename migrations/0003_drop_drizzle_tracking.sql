-- Drop legacy drizzle migration tracking tables and schema.
-- These are replaced by public._migrations (plain SQL runner).

DROP TABLE IF EXISTS drizzle.__drizzle_migrations CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_auth CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_chat CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_coffee CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_connections CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_dykil CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_events CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_input CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_kernel CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_learn CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_links CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_market CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_media CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_notify CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_pay CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_profile CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_registry CASCADE;
DROP TABLE IF EXISTS drizzle.__drizzle_migrations_www CASCADE;

DROP SCHEMA IF EXISTS drizzle CASCADE;

-- Drop dead tables
DROP TABLE IF EXISTS profile.connection_requests CASCADE;
DROP TABLE IF EXISTS profile.did_migrations CASCADE;
