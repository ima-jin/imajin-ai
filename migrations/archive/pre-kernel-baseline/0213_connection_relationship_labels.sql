-- owner: kernel
-- #2945: commercial relationships are private to each side, never membership.
ALTER TABLE connections.connections
  ADD COLUMN IF NOT EXISTS relationship_label_a text,
  ADD COLUMN IF NOT EXISTS relationship_label_b text;

DO $$ BEGIN
  ALTER TABLE connections.connections ADD CONSTRAINT connections_relationship_label_a_check
    CHECK (relationship_label_a IN ('client', 'vendor', 'partner', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE connections.connections ADD CONSTRAINT connections_relationship_label_b_check
    CHECK (relationship_label_b IN ('client', 'vendor', 'partner', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
