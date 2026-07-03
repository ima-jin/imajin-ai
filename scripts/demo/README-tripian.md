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
4. **Broker, shadow mode (#1231)** — the restaurant's requesting agent calls
   `POST /api/broker/request` with `mode: "shadow"` for each field.
5. **Release correctness** — `dietary` comes back **raw**, `allergies` comes back
   in **attestation** mode, `budget` is **not released** (no consent).
6. **Non-binding** — every response is HTTP `200` with `enforced: false`, on both
   releases and the denial. Nothing is gated.
7. **Audit (#1050)** — `GET /api/broker/audit?shadow=true` returns
   shadow-flagged rows: 2 releases + 1 denial.

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
[4] Restaurant requests each field via the broker in SHADOW mode (#1231)
    dietary: http=200 released=true mode=raw enforced=false
    ✓ dietary is released in RAW mode
    allergies: http=200 released=true mode=attestation enforced=false
    ✓ allergies is released in ATTESTATION mode
    budget: http=200 released=false enforced=false
    ✓ budget is NOT released (no consent)

[5] Verify shadow-flagged audit rows were written (#1050)
    audit rows (shadow=true): 3 (released=2, denied=1)
    sample row: {"id":"...","type":"release","requester":"did:imajin:...",
      "subject":"did:imajin:...","purpose":"restaurant_reservation",
      "fields_requested":["dietary"],"fields_released":["dietary"],
      "status":"RELEASED","mode":"raw","shadow":true,"created_at":"..."}

All assertions passed. Shadow mode ran the full consent + audit path; nothing was gated.
```

## Deviations from the idealized narrative (read before reviewing)

The demo exercises the **real, merged** primitives. Two aspects of the PoC
narrative are not yet supported by those primitives, so the demo adapts honestly
rather than mocking:

1. **Per-field release modes.** The broker resolves a **single** release mode per
   call (`envelope.mode`), and composing grants unions their fields and prefers
   `raw`. It cannot return `dietary=raw` **and** `allergies=attestation` in one
   response. The demo therefore issues **one shadow request per field**, so each
   mode (raw / attestation / denied) is proven distinctly against real consent
   resolution. A single combined request remains a future enhancement once the
   broker supports per-field modes.
2. **Attestation redaction.** In the current Phase-1 broker, `mode` is a label on
   the release envelope; the pipeline returns the filtered value regardless of
   mode (it does not yet redact raw values behind a `has:true` attestation). The
   demo asserts the **mode** and the release/denial + non-binding behavior;
   value-level redaction for attestation is a documented future enhancement.
3. **Consent seeding.** `POST /api/broker/consent` requires `subject === acting`,
   which a keypair-less soft traveler DID cannot satisfy. The demo writes the
   traveler's grants directly into `kernel.consent_grants` (real rows), so the
   broker's consent **resolution** — the thing being proven — stays fully real.
   `granted_to` is the demo agent DID (the authenticated requester acting for the
   restaurant).

These are properties of the underlying primitives, not of the demo; each is a
small, well-scoped follow-up.
