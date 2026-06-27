# DFOS v1 corpus re-mint + prune (#1111)

One-time data migration. **Not** part of the auto-pipeline (`scripts/migrate.mjs`
only runs SQL in `migrations/`). This re-derives DIDs via the protocol library, so
it ships as a Node script and is run **manually, once per environment**.

## What it does (one transaction)

1. **Prune** every `relay.*` row not bound to one of our `auth.identity_chains`
   (Brandon's gossiped/peered backfill — content-addressed, re-replicates on
   re-peer; no Imajin-user binding). Content/countersig/document/blob/credential/
   revocation/pending corpora are truncated wholesale.
2. **Re-mint** each of our identity chains whose `dfos_did` is still pre-v1 width
   (22-char) to the canonical v1 width (31-char), re-derived from the
   already-signed genesis op via `verifyIdentityChain` (same keypair, sigs stay
   valid, **no re-signing**).
3. **Rewrite** the new DID everywhere it is referenced: `auth.identity_chains.dfos_did`,
   `relay.relay_identity_chains.did`, `relay.relay_operations.chain_id`,
   `relay.relay_operation_log.chain_id`, `relay.relay_beacons.did`,
   `registry.nodes.chain_did`.

`did:imajin` (base58 full-pubkey) does NOT move — it is decoupled from DFOS width.
No user re-keys, no Imajin identity changes.

## Run

```bash
# DRY-RUN first (prints re-mint + prune plan, no writes)
node scripts/dfos-v1-remint.mjs

# APPLY (commits in one transaction; verifies all chains are 31-char after)
node scripts/dfos-v1-remint.mjs --apply
```

Reads `DATABASE_URL` from `apps/kernel/.env.local` or env. Requires
`@metalabel/[email protected]+` (idLength=31) installed — the same lib the
running relay uses.

## Status

- **dev (`imajin_dev`): APPLIED + verified.** All identity chains 31-char, zero
  22-char persisted anywhere.
- **prod (`imajin_prod`): PENDING** — run manually after merge.

## Caveat — full live-suite conformance is a separate issue

This closes the *corpus* gap (we stop serving pre-v1 DIDs / 404'ing on identity
resolution against v1 peers). Brandon's *current* conformance suite (0.13.5) posts
to `/proof/v1/*` routes; our relay binary (0.10.0) serves flat routes (the
`/proof/v1` namespacing is a post-0.10 BREAKING change, dfos #88). Running his
official `TestIdentifierWidthConformance` green requires bumping the relay
0.10.0 → 0.13.5. Tracked separately. Corpus invariant verified directly against
the DB here.
