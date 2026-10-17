-- Migration 0008: add ticket_id to dykil.survey_responses for #815
-- Lets survey responses be looked up by the events ticket they were filled for,
-- so the events app can authoritatively reconcile registration_status.

ALTER TABLE dykil.survey_responses
    ADD COLUMN IF NOT EXISTS ticket_id text;

CREATE INDEX IF NOT EXISTS idx_responses_ticket_id
    ON dykil.survey_responses USING btree (ticket_id)
    WHERE ticket_id IS NOT NULL;
