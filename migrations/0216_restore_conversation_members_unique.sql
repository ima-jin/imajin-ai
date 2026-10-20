-- #2865: 0201 dropped prod's only membership uniqueness (a seed-era constraint).
-- owner: kernel
-- migrate.mjs wraps each file in a transaction, so CONCURRENTLY is not allowed.
-- Prod was repaired manually at 2026-10-20 15:12Z; dev and fresh builds also
-- already have this index. IF NOT EXISTS preserves those existing indexes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_members_unique
  ON chat.conversation_members (conversation_did, member_did);
