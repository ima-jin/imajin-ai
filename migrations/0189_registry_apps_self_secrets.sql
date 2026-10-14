-- App-declared recipes only: plaintext and ciphertext stay in the existing vault.
-- owner: kernel
ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS secrets jsonb NOT NULL DEFAULT '[]'::jsonb;
