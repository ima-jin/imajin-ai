-- 0146_usage_incurred_status.sql
-- owner: kernel
--
-- #2202: usage.incurred hygiene -- mark failed upstream passthrough attempts.
--
-- The OpenAI-compatible completions passthrough (openai-compatible-adapter.ts)
-- unconditionally writes one usage.incurred row per call, even when the
-- upstream rejects the request with a 4xx/5xx (#2202 observed two
-- gpt-6-astra 400s from OpenAI: `max_tokens` unsupported, `reasoning_effort`
-- + tools unsupported). Those rows already carry NULL
-- tokens_in/tokens_out/cost_usd ("a degraded row beats a missing one" per
-- migration 0119) -- but that shape is indistinguishable from a genuinely
-- successful call whose provider simply omitted `usage` from its response.
--
-- Decision (see #2202): keep recording the attempt -- auditors should still
-- see it happened -- but mark it explicitly so cost/call-count rollups can
-- exclude it instead of silently counting a failed call as a free success.
--
-- `status` is nullable and purely additive: NULL for every pre-existing row
-- and every normal call (successful, or degraded-but-served with unknown
-- usage) -- only the new failed-upstream-attempt write path
-- (`recordInferenceUsage({ status: 'error' })`) ever sets it to 'error'.
ALTER TABLE usage.incurred ADD COLUMN IF NOT EXISTS status TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_incurred_status
  ON usage.incurred (status)
  WHERE status IS NOT NULL;
