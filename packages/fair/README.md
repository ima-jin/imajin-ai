# @imajin/fair

Shared `.fair` attribution types, validator, builder, settlement fee-math,
and React components. The canonical `.fair` file-format spec lives at
[github.com/ima-jin/.fair](https://github.com/ima-jin/.fair); this package
is the TypeScript implementation consumed across `imajin-ai`.

## Schema versions

- **v1.0** (`FairManifestV10`) — original shape, preserved for backward
  compatibility.
- **v1.1** (`FairManifestV11`, `fair`/`version: '1.1'`) — richer
  distribution/training/commercial/settlement fields.
- **v1.2** (`FairManifestV11`, `fair`/`version: '1.2'`, #2419) — identical
  shape to v1.1, plus an optional top-level `taxes[]` array. A manifest is
  `'1.2'` **only** when it actually carries `taxes[]`; every manifest
  without `taxes[]` stays `'1.1'` and validates/settles byte-for-byte
  identically to before #2419. The tie is enforced both ways by
  `validateManifest` (#2439): a non-empty `taxes[]` on a `'1.1'` manifest
  is rejected, and so is `'1.2'` with no (or an empty) `taxes[]`.

## `taxes[]` — sales tax collected in trust (#2419)

New optional top-level array on the manifest:

```ts
taxes?: Array<{
  jurisdiction: string;        // e.g. "CA-ON"
  kind: 'GST/HST' | 'QST' | 'VAT' | 'PST' | string;
  rateBps: number;             // e.g. 1300 for 13%
  basisAmount: number;         // pre-tax subtotal the rate applies to (cents)
  amount: number;              // round(basisAmount × rateBps / 10000), cents
  registrationNumber: string;  // issuer tax registration — required end-to-end (#2439)
  collectorDid: string;        // who holds the money in trust (typically the seller)
  remitTo: string;             // authority DID this is owed to (creditor label)
}>
```

### Invariants (Ryan rulings, 2026-09-28 — settled)

1. **Tax lives INSIDE `.fair` as `taxes[]`** — never in `fees[]`, never as
   a `chain` payee.
2. **Fee math on the pre-tax subtotal (`basisAmount`) only.** Every chain
   share and platform/protocol/node/scope/buyer-credit fee computes on
   `basisAmount` — tax is never in the skim basis. In `buildFairManifest`,
   this holds by construction: chain shares are pure ratios of 1.0 that
   never reference any monetary total at all. In `resolveSettlementChain`
   / kernel `settle-core.ts`, `amountCents`/`total_amount` for chain
   purposes is always `basisAmount`, never the gross.
3. **The processor (Stripe) fee applies to the GROSS amount** (subtotal +
   tax). **The seller absorbs the fee on the tax portion** — consistent
   with the existing model where the seller already absorbs the
   processing fee on their own chain share. Concretely:
   `resolveSettlementChain`'s `estimatedFeeDollars` and kernel
   `checkout.ts`'s `computeProcessingFeeCents` both compute on
   `basisAmount + Σtaxes.amount`, while the platform fee and every chain
   share still compute on `basisAmount` alone.
4. **Tax settles as a trust-liability credit** to `collectorDid`, with
   ledger metadata `{ tax: true, jurisdiction, kind, rateBps, remitTo,
   registrationNumber, trustLiability: true, remitted: null }`
   (`registrationNumber` is required on every credit — `settlePayment()`
   400s without it — and stored so the remittance-owed report can show it).
   It is **never MJNx-reconciled** and **never fee-skimmable** — both hold structurally, since tax credits
   are written entirely outside `chain`/`resolvedChain`, and MJNx
   reconciliation (`webhook-handlers.ts`) and fee-skim math only ever look
   at `chain`.
5. **`remitTo` is an authority DID** (well-known placeholder
   `AUTHORITY_DID_CA_CRA = 'did:imajin:authority:ca-cra'`, exported from
   `./constants`), recorded as **creditor**, not a payee. No settlement
   transfer ever goes to `remitTo`.
6. **Remittance-owed** = `SUM(amount)` over settled tax rows `WHERE
   metadata.tax AND metadata.remitted IS NULL GROUP BY jurisdiction, kind`
   (plus the registration number the tax was collected under, #2439, so
   each owed line carries its `registrationNumber`) — see
   `getTaxRemittanceOwed`, exposed read-only via
   `GET /pay/api/tax/remittance-owed`.
7. **Tax registration lives on the business profile**, not yet an
   attestation.
8. **v1 granularity** = invoice-level toggle + one rate per invoice —
   `buildFairManifest`'s `taxes` input shares one `basisAmountCents`
   across every row it's given.

### Rounding

`amount` is always `Math.round(basisAmount × rateBps / 10000)`, integer
cents — the same plain-integer rounding convention every other cents-based
fee computation in this codebase already uses (`resolveSettlementChain`'s
`computeFeeCents`, kernel `checkout.ts`'s fee helpers). `packages/fair`
deliberately does not depend on `@imajin/money` for this: that dependency
was removed entirely (see `docs/npm-publishing.md`) because `@imajin/money`
is unpublished and pulls in `@imajin/db`/`@imajin/auth`, which would break
`@ima-jin/fair`'s publishability.

### Backward compatibility

Existing v1.0/v1.1 manifests (events tickets, market listings, tips, ...)
remain valid and settle byte-for-byte identically when `taxes[]` is
absent. The field is optional everywhere; every code path behaves exactly
as before #2419 when it's missing.
