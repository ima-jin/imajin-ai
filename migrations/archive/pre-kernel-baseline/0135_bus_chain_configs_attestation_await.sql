-- 0135_bus_chain_configs_attestation_await.sql
-- owner: kernel
--
-- #2016: `packages/bus/src/config.ts`'s DEFAULTS now runs the `attestation`
-- reactor with `await: true` on every chain that also runs `mjn`, so the
-- attestation is guaranteed to exist (and its id stashed onto the shared
-- event object by `reactors/attestation.ts`) before `mjn` reads it and
-- forwards it as the emission's `attestation_id`. `getChainConfig()`
-- (`packages/bus/src/config.ts`) prefers a `kernel.bus_chain_configs` DB
-- row over DEFAULTS when one exists — migration 0039 seeded exactly these
-- event types without `await`, so those DB rows would silently shadow the
-- config.ts fix in any environment where they were ever inserted. This
-- migration brings them in sync, mirroring the "kept in sync with
-- migration NNNN" convention already used for the other DEFAULTS entries
-- in config.ts.
--
-- Scoped to `scope IS NULL` (the node-default row each of these was seeded
-- with) — a node that has since customized one of these rows away from the
-- seeded default keeps its customization only if the reactors array no
-- longer matches the pre-await JSON below; every match here is the exact
-- literal migration-0039 payload for that event type.

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"identity.created"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"identity.created"},"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb
WHERE event_type = 'identity.created' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"identity.created"},"enabled":true},{"type":"mjn","config":{"attestationType":"identity.created"},"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"identity.verified.preliminary"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"identity.verified.preliminary"},"enabled":true}]'::jsonb
WHERE event_type = 'identity.verified.preliminary' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"identity.verified.preliminary"},"enabled":true},{"type":"mjn","config":{"attestationType":"identity.verified.preliminary"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"identity.verified.hard"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"identity.verified.hard"},"enabled":true}]'::jsonb
WHERE event_type = 'identity.verified.hard' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"identity.verified.hard"},"enabled":true},{"type":"mjn","config":{"attestationType":"identity.verified.hard"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"connection.accepted"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"connection.accepted"},"enabled":true},{"type":"notify","config":{"template":"invite_accepted"},"enabled":true}]'::jsonb
WHERE event_type = 'connection.accepted' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"connection.accepted"},"enabled":true},{"type":"mjn","config":{"attestationType":"connection.accepted"},"enabled":true},{"type":"notify","config":{"template":"invite_accepted"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"vouch"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"vouch"},"enabled":true}]'::jsonb
WHERE event_type = 'vouch' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"vouch"},"enabled":true},{"type":"mjn","config":{"attestationType":"vouch"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"tip.granted"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"tip.granted"},"enabled":true},{"type":"notify","config":{"scope":"coffee:tip"},"enabled":true}]'::jsonb
WHERE event_type = 'tip.granted' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"tip.granted"},"enabled":true},{"type":"mjn","config":{"attestationType":"tip.granted"},"enabled":true},{"type":"notify","config":{"scope":"coffee:tip"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"ticket.purchased"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"ticket.purchased"},"enabled":true},{"type":"notify","config":{"scope":"event:ticket"},"enabled":true}]'::jsonb
WHERE event_type = 'ticket.purchased' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"ticket.purchased"},"enabled":true},{"type":"mjn","config":{"attestationType":"ticket.purchased"},"enabled":true},{"type":"notify","config":{"scope":"event:ticket"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"listing.purchased"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"listing.purchased"},"enabled":true},{"type":"settle","config":{},"await":true,"enabled":true},{"type":"notify","config":{"scope":"market:purchase"},"enabled":true}]'::jsonb
WHERE event_type = 'listing.purchased' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"listing.purchased"},"enabled":true},{"type":"mjn","config":{"attestationType":"listing.purchased"},"enabled":true},{"type":"settle","config":{},"await":true,"enabled":true},{"type":"notify","config":{"scope":"market:purchase"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"group.created"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"group.created"},"enabled":true}]'::jsonb
WHERE event_type = 'group.created' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"group.created"},"enabled":true},{"type":"mjn","config":{"attestationType":"group.created"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"scope.onboard"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"scope.onboard"},"enabled":true}]'::jsonb
WHERE event_type = 'scope.onboard' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"scope.onboard"},"enabled":true},{"type":"mjn","config":{"attestationType":"scope.onboard"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"handle.claimed"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"handle.claimed"},"enabled":true}]'::jsonb
WHERE event_type = 'handle.claimed' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"handle.claimed"},"enabled":true},{"type":"mjn","config":{"attestationType":"handle.claimed"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"event.created"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"event.created"},"enabled":true}]'::jsonb
WHERE event_type = 'event.created' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"event.created"},"enabled":true},{"type":"mjn","config":{"attestationType":"event.created"},"enabled":true}]'::jsonb;

UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"attestation","config":{"attestationType":"event.attendance"},"await":true,"enabled":true},{"type":"mjn","config":{"attestationType":"event.attendance"},"enabled":true}]'::jsonb
WHERE event_type = 'event.attendance' AND scope IS NULL
  AND reactors = '[{"type":"attestation","config":{"attestationType":"event.attendance"},"enabled":true},{"type":"mjn","config":{"attestationType":"event.attendance"},"enabled":true}]'::jsonb;
