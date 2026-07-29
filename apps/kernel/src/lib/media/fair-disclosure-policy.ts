/**
 * Field-level disclosure policy for .fair settlement manifests (#1440).
 *
 * This file is now a thin shim — the canonical disclosure engine lives in
 * `packages/fair/src/disclosure.ts` and is exported from `@imajin/fair`.
 * All engine symbols are re-exported below so existing import paths work
 * unchanged (including the 32 regression tests from #1441).
 *
 * Only `DEFAULT_AGRIFORTRESS_OVERLAY` stays here — it is a deployment-specific
 * default for the AgriFortress instance, not a canonical protocol primitive.
 *
 * Decision A (2026-07-28): 4 tiers, lot-side re-adopts `owner-only`.
 * Decision B (2026-07-28): shared engine lives in `packages/fair` as a pure module.
 */

// ── Re-exports from canonical engine ──────────────────────────────────────────
export type {
  FairReleaseTier,
  FairFieldKey,
  FieldOverlayEntry,
  FairDisclosureOverlay,
  EffectiveFieldPolicy,
  EffectivePolicy,
  WithheldAttestation,
  ApplyGatesResult,
} from '@imajin/fair';
export {
  FAIR_RELEASE_TIERS,
  TIER_RANK,
  FAIR_FLOOR_FIELDS,
  composeEffectivePolicy,
  applyDisclosureGates,
  parseSubjectGates,
} from '@imajin/fair';

/**
 * Backward-compat alias. Previously a 3-tier type (missing `owner-only`);
 * now a full alias for FairReleaseTier (4 tiers). Decision A re-adopts
 * `owner-only` on the lot-side — callers that exhaustively handled 3 cases
 * should add the `owner-only` branch.
 */
export type { FairReleaseTier as FairReleaseClass } from '@imajin/fair';

// ── AgriFortress defaults (deployment-specific, not canonical) ────────────────

/**
 * Default community overlay for AgriFortress deployments.
 *
 * A deployment operator overrides this by writing a JSON object to nodeConfig
 * key `fair.disclosure.overlay` — the overlay is data, not code. Examples:
 *
 * Private supplier (maximum privacy):
 *   `{ "fees": { "release": "on-consent" }, "amount": { "release": "never" } }`
 *
 * Radical-transparency co-op:
 *   `{ "amount": { "release": "silent" }, "attribution[*].name": { "release": "silent" } }`
 *
 * Carbon registry (full fee transparency):
 *   `{ "fees": { "release": "silent" }, "distribution": { "release": "silent" } }`
 *
 * Default AgriFortress tiers below:
 *   • fees             → silent   (rate model is checkable; rates ≠ amounts)
 *   • owner            → on-consent (linkability handle — the same DID across lots
 *                        reconstructs a supplier's full settlement graph; the floor
 *                        already proves provenance without exposing who; a radical-
 *                        transparency overlay can restore `silent` via nodeConfig)
 *   • attribution.did  → silent   (pseudonymous anchors; who-got-what-share, no names)
 *   • attribution.share → silent
 *   • amount           → on-consent (public view: "amount present: true")
 *   • attribution.name → on-consent (PII; the DID suffices)
 *   • attribution.note → on-consent (may contain PII)
 */
export const DEFAULT_AGRIFORTRESS_OVERLAY: FairDisclosureOverlay = {
  // Floor (belt-and-suspenders — FAIR_FLOOR_FIELDS is authoritative)
  id: { release: "silent" },
  type: { release: "silent" },
  created: { release: "silent" },
  fair: { release: "silent" },
  version: { release: "silent" },
  integrity: { release: "silent" },
  signature: { release: "silent" },
  platformSignature: { release: "silent" },
  // owner is on-consent: the same DID across many lots reconstructs a supplier's
  // full settlement graph (linkability). The floor proves provenance without naming
  // the owner. A radical-transparency overlay restores `silent` via nodeConfig.
  owner: { release: "on-consent" },
  source: { release: "silent" },
  access: { release: "silent" },
  terms: { release: "silent" },
  intent: { release: "silent" },
  tipping: { release: "silent" },
  settlement: { release: "silent" },
  // Fee RATES are public — the model is checkable (rates ≠ amounts)
  fees: { release: "silent" },
  // Attribution array: top-level silent; per-entry sub-keys selectively gated
  attribution: { release: "silent" },
  "attribution[*].did": { release: "silent" },   // pseudonymous anchor
  "attribution[*].role": { release: "silent" },
  "attribution[*].share": { release: "silent" },  // who-got-what-share
  "attribution[*].chainProof": { release: "silent" },
  "attribution[*].name": { release: "on-consent" }, // PII — the DID suffices
  "attribution[*].note": { release: "on-consent" }, // may contain PII
  // Absolute amounts — on-consent (public view: "amount present: true")
  amount: { release: "on-consent" },
  // Distribution and transfer rights — on-consent (contain price sub-fields)
  distribution: { release: "on-consent" },
  transfer: { release: "on-consent" },
  // Backward-compat arrays
  distributions: { release: "silent" },
  chain: { release: "silent" },
  // Training / commercial flags — silent (policy booleans, not PII)
  training: { release: "silent" },
  commercial: { release: "silent" },
};

