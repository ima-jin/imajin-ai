-- owner: kernel
-- #2862: migration-status.ts now uses Array.at(-1) for the applied head.
-- The helper's query, schema and persisted data are unchanged. This matching,
-- idempotent migration records that package-db update without altering data.
SELECT 1;
