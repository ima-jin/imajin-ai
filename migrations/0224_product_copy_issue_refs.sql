-- owner: kernel
-- Forward-only copy repair for existing rows and fresh baseline installs (#3152).
-- Preserve identities, status, timestamps and all history; never delete records.
UPDATE registry.apps
SET description = regexp_replace(
  description,
  '\s*\((provisioned via apps\.provision #2375|#1185, RFC 7591|first-party, #1990|#1166)\)\s*$',
  ''
)
WHERE description ~ '\s*\((provisioned via apps\.provision #2375|#1185, RFC 7591|first-party, #1990|#1166)\)\s*$';

UPDATE auth.attestation_type_registry
SET description = regexp_replace(description, '\s*\(#1886\)', '', 'g')
WHERE type_name = 'value_realized' AND description ~ '\(#1886\)';
