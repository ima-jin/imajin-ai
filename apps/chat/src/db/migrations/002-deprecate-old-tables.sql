-- Migration 002: Document deprecated tables and columns
-- Phase 6 of #278 — DID-based chat migration
--
-- These tables/columns are DEPRECATED and can be dropped after verification
-- that no active traffic depends on them. DO NOT DROP without manual review.
--
-- Verification steps before dropping:
--   1. Confirm no queries hit these tables in production logs
--   2. Confirm all event chats are routing through conversations_v2 / DID routes
--   3. Back up data or archive as needed
--   4. Drop in a follow-up migration

-- -----------------------------------------------------------------------------
-- chat schema
-- -----------------------------------------------------------------------------

-- DEPRECATED: chat.conversations
--   Replaced by: chat.conversations_v2 (DID-keyed)
--   Safe to drop when: all chat clients use /api/d/:did routes exclusively
--   Note: still referenced by apps/chat/src/app/api/conversations/ (legacy routes kept intentionally)
-- DROP TABLE IF EXISTS chat.conversations CASCADE;

-- DEPRECATED: chat.participants
--   Replaced by: auth /api/access/:did endpoint for access control
--   Safe to drop when: lobby/surrogate-key participant rows are no longer queried
-- DROP TABLE IF EXISTS chat.participants CASCADE;

-- DEPRECATED: chat.read_receipts
--   Replaced by: chat.conversation_reads_v2
--   Safe to drop when: legacy conversation routes are removed
-- DROP TABLE IF EXISTS chat.read_receipts CASCADE;

-- -----------------------------------------------------------------------------
-- connections schema
-- -----------------------------------------------------------------------------

-- DEPRECATED: connections.pods
--   Events now use DID-based conversations; pods are no longer created for new events
--   Existing rows are orphaned — kept for historical data integrity
-- DROP TABLE IF EXISTS connections.pods CASCADE;

-- DEPRECATED: connections.pod_members
--   Role checks (owner/host/cohost) still query this table via my-ticket and cohosts routes
--   Safe to drop only after those role checks migrate to a DID-native access model
-- DROP TABLE IF EXISTS connections.pod_members CASCADE;

-- -----------------------------------------------------------------------------
-- events schema — column-level deprecations
-- -----------------------------------------------------------------------------

-- DEPRECATED: events.events.pod_id
--   No longer populated for new events (createEventPod removed in Phase 6)
--   Still read by cohosts route for pod_members role check — do not drop yet
-- ALTER TABLE events.events DROP COLUMN pod_id;

-- DEPRECATED: events.events.lobby_conversation_id
--   No longer populated for new events
--   Column is safe to drop; no active code reads it after Phase 6
-- ALTER TABLE events.events DROP COLUMN lobby_conversation_id;
