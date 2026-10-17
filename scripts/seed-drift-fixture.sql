-- Synthetic, non-secret rows; exercise preservation of values and row xmin.
INSERT INTO chat.conversations_v2 (did, created_by)
VALUES ('test:2865:conversation', 'test:2865:member');
INSERT INTO chat.messages_v2 (id, conversation_did, from_did, content)
VALUES ('test:2865:message', 'test:2865:conversation', 'test:2865:member', '{"test":2865}');
INSERT INTO chat.conversation_reads_v2 (conversation_did, did)
VALUES ('test:2865:conversation', 'test:2865:member');
INSERT INTO chat.message_reactions_v2 (message_id, did, emoji)
VALUES ('test:2865:message', 'test:2865:member', 'test-reaction');
INSERT INTO chat.conversation_members (conversation_did, member_did)
VALUES ('test:2865:conversation', 'test:2865:member');
INSERT INTO pay.balance_rollups (did, date, service, earned, spent, tx_count)
VALUES ('test:2865:member', '2026-01-01 00:00:00+00', 'test', 12.25, 3.5, 2);
