# .fair — Legal Boundaries

> Addresses #1051 weakness 7 (Tier 2.3). A `.fair` manifest is a **machine-readable commercial
> instruction** — it tells the settlement system who gets paid what. It is **not a legal
> instrument**. This document states plainly what `.fair` does and does not do.

## What .fair is

A `.fair` manifest is a signed, machine-readable description of how value from a transaction is
split across contributors (the `entries`/shares), what fees apply (`fees`), transfer rules
(`transfer`), and access (`access`). When a payment settles, the settlement reactor reads the
manifest and pays out accordingly. See `packages/fair`.

It is an **executable payout specification** the platform honors at settlement time.

## What .fair is NOT

A `.fair` manifest, by itself, does **not**:

- **Establish copyright or ownership.** A share in a manifest is a payout instruction, not a
  grant, assignment, or license of any intellectual-property right. Listing someone as a
  contributor does not transfer or create copyright.
- **Convey moral rights** (attribution, integrity rights) in any jurisdiction.
- **Constitute a contract** between the parties in the legal sense. It is configuration the
  operator executes, not a meeting of minds enforceable on its own.
- **Carry jurisdiction, governing law, or venue.**
- **Handle tax.** It does not compute, withhold, or report tax obligations; contributors are
  responsible for their own.
- **Resolve disputes, chargebacks, or refunds.** If a buyer charges back or a contributor
  disputes a split, the manifest has no built-in arbitration. Resolution happens off-protocol.
- **Guarantee payment.** It describes the *intended* split; actual payout depends on funds
  clearing at the payment processor and the node executing settlement.

## Linking to human-readable terms (optional)

For parties who want real legal terms behind a manifest, the recommended pattern is to attach a
`termsUri` pointing to a human-readable agreement (and optionally a `disputes` contact/process).
This keeps the protocol honest — the manifest stays a machine instruction, and any legal weight
lives in the linked document, authored and agreed by humans.

> **Status:** `termsUri` / `disputes` are **proposed optional fields** on the manifest schema,
> not yet implemented. Tracked under #1067 (Tier 2.3). Until shipped, link terms out-of-band.

## One-line summary

> `.fair` decides **who the system pays**. It does not decide **who legally owns what** or
> **what happens when humans disagree**. Those remain human, off-protocol concerns.

See also: [SECURITY.md](../../SECURITY.md) · [proof-model.md](./proof-model.md)
