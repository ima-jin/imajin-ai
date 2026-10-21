-- 0026_clone_shared_survey_responses_per_ticket.sql
--
-- Issue #826 followup to 0025.
--
-- A handful of bundle-buy tickets share a single dykil.survey_response with the
-- order's "primary" ticket (the buyer filled the survey once for the whole order,
-- but each ticket carries its own attendee identity in events.ticket_registrations).
--
-- Today the guest list reads from ticket_registrations so it shows the per-ticket
-- attendee correctly. After ticket_registrations is dropped (#826), the read path
-- will join dykil.survey_responses by ticket_id and lose these attendees.
--
-- Fix: clone the shared survey_response into a per-ticket copy, overlaying the
-- registration row's name+email so the per-ticket attendee survives.
--
-- Idempotent: skips tickets that already have their own survey_response.

INSERT INTO dykil.survey_responses (id, survey_id, ticket_id, respondent_did, answers, created_at)
SELECT
  'response_clone_' || substr(md5(tr.id || ':' || tr.ticket_id), 1, 16),
  shared.survey_id,
  tr.ticket_id,
  shared.respondent_did,
  shared.answers
    || jsonb_strip_nulls(jsonb_build_object(
         'email', NULLIF(trim(tr.email), ''),
         'full_name', NULLIF(trim(tr.name), '')
       )),
  COALESCE(tr.registered_at, shared.created_at, now())
FROM events.ticket_registrations tr
JOIN dykil.survey_responses shared ON shared.id = tr.response_id
WHERE shared.ticket_id IS NOT NULL
  AND shared.ticket_id <> tr.ticket_id
  AND NOT EXISTS (
    SELECT 1 FROM dykil.survey_responses sr
    WHERE sr.ticket_id = tr.ticket_id
  )
ON CONFLICT (id) DO NOTHING;
