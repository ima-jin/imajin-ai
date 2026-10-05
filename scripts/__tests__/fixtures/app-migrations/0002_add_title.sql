-- Fixture app migration: unqualified names resolve into fixture_app (search_path pin).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS title TEXT;
