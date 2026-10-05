-- Fixture app migration for scripts/__tests__/migrate-app-mode*.test.mjs (#2524).
-- Owns only the `fixture_app` schema; idempotent like every real migration.
CREATE SCHEMA IF NOT EXISTS fixture_app;
CREATE TABLE IF NOT EXISTS fixture_app.pages (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL
);
