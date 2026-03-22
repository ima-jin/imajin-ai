-- Migration: Add signature column to messages_v2
-- Part of #422: Signed messages with chain keys (Phase A)

ALTER TABLE "chat"."messages_v2" ADD COLUMN "signature" text;
