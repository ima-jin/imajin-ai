# Tripian shadow-mode restaurant walkthrough (#1232)

A runnable, end-to-end proof of the SHITSUJI/Tripian PoC. A traveler has dietary
preferences; a restaurant requests them through the broker; consent logic decides
what is released and in what form — all in **shadow mode**, where the full
consent + audit pipeline runs and logs, but **nothing gates the flow**.

This is the visible deliverable that wires the underlying primitives into one
coherent, demonstrable sequence and proves it with assertions (not just prints).

## What it proves

Running `tripian-shadow-walkthrough.ts` executes seven steps and asserts each:

1. **Identity (#1230)** — traveler and restaurant are lazily minted as soft
   `did:imajin:` DIDs via `POST /registry/api/identity`, idempotent per
   `(namespace, ref)`.
2. **Vault (#1227)** — the traveler's `dietary`, `allergies`, and `budget` prefs
   are sealed under the traveler DID and then unsealed; the round-trip must
   return the original plaintext.
3. **Consent (#1049)** — three consent defaults are recorded: `dietary → raw`,
   `allergies → attestation`, `budget → none`.
4. **Broker, shadow mode (#1231/#1511)** — the restaurant's requesting agent
   calls `POST /api/broker/request` with `mode: "shadow"` for the mixed release.
5. **Release correctness** — `dietary` comes back **raw**, `allergies` comes back
   as a computed **attestation** predicate claim with the raw list withheld,
   `budget` is **not released** (no consent).
6. **Non-binding** — every response is HTTP `200` with `enforced: false`, on both
   releases and the denial. Nothing is gated.
7. **Audit (#1050)** — `GET /api/broker/audit?shadow=true` returns
   shadow-flagged rows: 1 mixed release + 1 denial.

## What "shadow mode" means

Shadow mode runs the **identical** `consent → scope → release → audit` pipeline
as enforcement and writes real, shadow-flagged audit rows — but the decision is
**advisory**. The response carries `enforced: false`, and a denial is still
returned with `200` so the caller logs it and never acts on it. Enforcement is a
config flip after the PoC. This is distinct from `preview`, which skips release +
audit entirely.

## Prerequisites

- A running dev kernel with the merged primitives: #1230 (identity), #1231
  (broker shadow mode), and #1227 (vault seal/unseal).
- A delegated **demo agent**: an authenticated identity that plays the
  restaurant's data-requesting service. You need its bearer token and DID.
- `AUTH_PRIVATE_KEY` available to the script — the vault round-trip runs
  **in-process** using #1227's real cipher (`sealSecret`/`unsealSecret`) with the
  same node seal-key derivation as `sealing.ts`. A dev fallback key is used when
  `AUTH_PRIVATE_KEY` is unset; never use the fallback with real secrets.

## Running it

```bash
cd apps/kernel
KERNEL_BASE_URL=http://localhost:3001 \
DEMO_AGENT_TOKEN=<bearer-token> \
DEMO_AGENT_DID=did:imajin:<agent> \
DATABASE_URL=<postgres-url> \
AUTH_PRIVATE_KEY=<node-key> \
npx tsx ../../scripts/demo/tripian-shadow-walkthrough.ts
```

`npx tsx ../../scripts/demo/tripian-shadow-walkthrough.ts --help` prints the env
reference. The script exits `0` only if every assertion holds; otherwise `1`.

The vault seal/unseal round-trip runs in-process using #1227's real cipher
(`sealSecret`/`unsealSecret`, see `vault-client.ts`): prefs are sealed to genuine
AES-256-GCM ciphertext under the node seal key and unsealed back. #1227 exposes
no HTTP unseal, and its in-process `sealAndStore`/`loadAndUnseal` pull in
workspace-only packages a standalone script can't load, so the demo binds to the
cipher primitives directly. The full FileVaultRepository persistence +
signed-entry chain is covered by #1227's own `roundtrip.test.ts`.

## Expected output (abridged)

```
[4] Restaurant requests dietary + allergy gate via the broker in SHADOW mode (#1231/#1511)
    restaurant: http=200 released=true mode=mixed enforced=false
    ✓ release is MIXED mode (dietary raw, allergies attestation)
    ✓ raw allergies value is absent from broker response
    budget: http=200 released=false enforced=false
    ✓ budget is NOT released (no consent)

[5] Verify shadow-flagged audit rows were written (#1050)
    audit rows (shadow=true): 2 (released=1, denied=1)
    sample row: {"id":"...","type":"release","requester":"did:imajin:...",
      "subject":"did:imajin:...","purpose":"restaurant_reservation",
      "fields_requested":["dietary","allergies"],"fields_released":["dietary","allergies"],
      "status":"RELEASED","mode":"mixed","shadow":true,"created_at":"..."}

All assertions passed. Shadow mode ran the full consent + audit path; nothing was gated.
```

## Demo notes

The demo exercises the **real, merged** primitives. One practical setup note remains:

1. **Consent seeding.** `POST /api/broker/consent` requires `subject === acting`,
   which a keypair-less soft traveler DID cannot satisfy. The demo writes the
   traveler's grants directly into `kernel.consent_grants` (real rows), so the
   broker's consent **resolution** — the thing being proven — stays fully real.
   `granted_to` is the demo agent DID (the authenticated requester acting for the
   restaurant).

These are properties of the underlying primitives, not of the demo; each is a
small, well-scoped follow-up.
