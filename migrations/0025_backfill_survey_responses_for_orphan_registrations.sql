-- 0025_backfill_survey_responses_for_orphan_registrations.sql
--
-- Issue #826 — prepare for dropping events.ticket_registrations by ensuring
-- every registration is represented in dykil.survey_responses (the source of truth).
--
-- Three operations, all idempotent:
--   1. Backfill ticket_id on existing survey_responses that we can match via
--      ticket_registrations.response_id (~14 rows in prod at time of writing).
--   2. Insert *partial* survey_responses ({email, full_name}) for ticket_registrations
--      that have no matching survey_response anywhere (~24 rows in prod). These
--      attendees have name+email only; remaining survey fields will be re-collected.
--   3. Flip those orphan tickets back to registration_status='pending' so the
--      organizer (and the registration UI) prompts them to complete the survey.
--      Dykil's submit endpoint upserts by (survey_id, ticket_id) so the partial
--      row is cleanly overwritten on re-submission.

BEGIN;

-- 1. Link existing survey_responses to their ticket via stored response_id.
UPDATE dykil.survey_responses sr
SET ticket_id = tr.ticket_id
FROM events.ticket_registrations tr
WHERE sr.id = tr.response_id
  AND sr.ticket_id IS NULL
  AND tr.ticket_id IS NOT NULL;

-- 2. Seed partial responses for true orphans (no survey_response by ticket_id
--    OR by response_id). Preserves whatever attendee identity we have.
INSERT INTO dykil.survey_responses (id, survey_id, ticket_id, answers, created_at)
SELECT
  'response_backfill_' || substr(md5(tr.id || ':' || tr.ticket_id), 1, 16),
  tr.form_id,
  tr.ticket_id,
  jsonb_strip_nulls(jsonb_build_object(
    'email', NULLIF(trim(tr.email), ''),
    'full_name', NULLIF(trim(tr.name), '')
  )),
  COALESCE(tr.registered_at, now())
FROM events.ticket_registrations tr
WHERE NOT EXISTS (
        SELECT 1 FROM dykil.survey_responses sr
        WHERE sr.ticket_id = tr.ticket_id
           OR (tr.response_id IS NOT NULL AND sr.id = tr.response_id)
      )
  -- Only seed when the form exists in Dykil; skip non-Dykil legacy rows.
  AND EXISTS (SELECT 1 FROM dykil.surveys s WHERE s.id = tr.form_id)
ON CONFLICT (id) DO NOTHING;

-- 3. Flip those orphans back to pending so the attendee gets re-prompted.
--    Identifying them by sr.id prefix is sufficient — we just created them
--    above with only {email, full_name}.
UPDATE events.tickets t
SET registration_status = 'pending'
WHERE t.registration_status = 'complete'
  AND EXISTS (
    SELECT 1
    FROM dykil.survey_responses sr
    WHERE sr.ticket_id = t.id
      AND sr.id LIKE 'response_backfill_%'
  );

COMMIT;
