/**
 * Field-level disclosure policy for .fair settlement manifests (#1440).
 *
 * Implements the layered, composable disclosure model specified in #1440:
 *
 *   Layer 1 (floor)     — existence + integrity + signature. ALWAYS disclosed.
 *                         A signed settlement of type X occurred at T — verify the sig.
 *   Layer 2 (community) — deployment/instance default overlay. The tier is DATA,
 *                         not code: stored in nodeConfig key `fair.disclosure.overlay`.
 *                         Falls back to DEFAULT_AGRIFORTRESS_OVERLAY if absent.
 *   Layer 3 (subject)   — subject-authored per-field gates from manifest._disclosure.
 *                         Subject can tighten OR loosen relative to the community overlay.
 *                         Floor fields are pinned regardless.
 *
 * Release classes mirror #1196 / #1221 (the existing release-gated-projection pattern):
 *   silent     → always disclosed (public pass-through)
 *   on-consent → disclosed only under an active kernel.consent_grants row for the caller;
 *                withheld fields appear in `_withheld` as presence attestations so the
 *                floor + signature remain independently verifiable without the value
 *   never      → structural drop — absent from both `manifest` and `_withheld`
 *
 * This module is PURE and has NO side effects. It knows nothing about HTTP, DB,
 * or the broker pipeline — the route is responsible for I/O; this module handles
 * only the disclosure decision tree. That keeps it straightforwardly testable.
 */

import type { FairManifest } from "@imajin/fair";

// ── Release class ──────────────────────────────────────────────────────────────

/** Release class for a .fair manifest field. Mirrors #1196 / #1221 release tiers. */
export type FairReleaseClass = "silent" | "on-consent" | "never";

// ── Field key vocabulary ───────────────────────────────────────────────────────

/**
 * Canonical field key identifiers for .fair disclosure gates.
 *
 * Top-level manifest fields use their field name directly.
 * Per-entry sub-keys in repeated arrays use `<array>[*].<subkey>` notation
 * so an overlay can gate individual columns of every entry independently
 * (e.g. `attribution[*].name` gates the `name` column of every attribution
 * entry, while `attribution[*].did` and `attribution[*].share` remain silent).
 *
 * The synthetic key `amount` covers any `Money.amount` occurrence anywhere
 * in the manifest (distribution[*].price.amount, transfer.price.amount) so a
 * single on-consent gate seals all absolute monetary values at once. Rates
 * (fees[].rateBps) are governed by the `fees` key and default to silent.
 */
export type FairFieldKey =
  // ── Floor (pinned silent regardless of overlay) ──
  | "id"
  | "type"
  | "created"
  | "fair"
  | "version"
  | "integrity"
  | "signature"
  | "platformSignature"
  // ── Structural metadata ──
  | "owner"
  | "source"
  | "access"
  | "terms"
  | "intent"
  | "tipping"
  | "settlement"
  // ── Fee rates (public by default — rates ≠ amounts) ──
  | "fees"
  // ── Attribution array (top-level silent; sub-key name/note may be on-consent) ──
  | "attribution"
  | "attribution[*].did"
  | "attribution[*].role"
  | "attribution[*].share"
  | "attribution[*].chainProof"
  | "attribution[*].name"
  | "attribution[*].note"
  // ── Distribution/transfer rights ──
  | "distribution"
  | "transfer"
  | "distributions"
  | "chain"
  | "training"
  | "commercial"
  // ── Synthetic key covering ALL Money.amount values ──
  | "amount";

// ── Overlay types ──────────────────────────────────────────────────────────────

/** One entry in a disclosure overlay — just the release class for one field. */
export interface FieldOverlayEntry {
  release: FairReleaseClass;
}

/**
 * Per-field disclosure overlay. Keys are {@link FairFieldKey}s; values declare
 * the release class for that field in this deployment/subject context.
 *
 * Stored in `nodeConfig` (key `fair.disclosure.overlay`) for the community
 * overlay, or in `manifest._disclosure` for subject-authored gates.
 */
export type FairDisclosureOverlay = Partial<Record<FairFieldKey, FieldOverlayEntry>>;

// ── Floor ──────────────────────────────────────────────────────────────────────

/**
 * Floor field set: existence + integrity + signature.
 *
 * These are ALWAYS disclosed at `silent` regardless of community or subject
 * settings. The public record asserts "a real, signed settlement of type X
 * occurred at T, chained to lot Y — verify the sig."
 */
export const FAIR_FLOOR_FIELDS: ReadonlySet<FairFieldKey> = new Set<FairFieldKey>([
  "id",
  "type",
  "created",
  "fair",
  "version",
  "integrity",
  "signature",
  "platformSignature",
]);

// ── AgriFortress defaults ──────────────────────────────────────────────────────

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

// ── Effective policy ───────────────────────────────────────────────────────────

/** Resolved policy entry for one field. */
export interface EffectiveFieldPolicy {
  release: FairReleaseClass;
  /** True for fields in FAIR_FLOOR_FIELDS — route MUST always include these. */
  isFloor: boolean;
}

/** Resolved effective disclosure policy keyed by FairFieldKey. */
export type EffectivePolicy = Partial<Record<FairFieldKey, EffectiveFieldPolicy>>;

/**
 * Compose the effective disclosure policy from a community overlay and
 * (optionally) subject-authored gates.
 *
 * Composition rule:
 *   1. Floor fields are pinned to `silent` regardless — non-negotiable.
 *   2. For every other field: subject gate wins over community overlay.
 *      Subject can tighten (raise tier) OR loosen (lower tier) relative to
 *      the community default — "radical-transparency co-op" and "private
 *      supplier" are both expressible from the same route.
 *   3. Fields not in either overlay default to `silent` (unknown structural
 *      metadata passes through rather than being gated).
 *
 * @param communityOverlay - Deployment defaults (nodeConfig or DEFAULT_AGRIFORTRESS_OVERLAY).
 * @param subjectGates     - Subject-authored per-field overrides (from manifest._disclosure).
 */
export function composeEffectivePolicy(
  communityOverlay: FairDisclosureOverlay,
  subjectGates: FairDisclosureOverlay = {},
): EffectivePolicy {
  const allKeys = new Set<FairFieldKey>([
    ...(Object.keys(communityOverlay) as FairFieldKey[]),
    ...(Object.keys(subjectGates) as FairFieldKey[]),
    ...FAIR_FLOOR_FIELDS,
  ]);

  const policy: EffectivePolicy = {};
  for (const key of allKeys) {
    const isFloor = FAIR_FLOOR_FIELDS.has(key);
    if (isFloor) {
      policy[key] = { release: "silent", isFloor: true };
      continue;
    }
    // Subject gate overrides community overlay (tighten or loosen allowed)
    const release =
      subjectGates[key]?.release ?? communityOverlay[key]?.release ?? "silent";
    policy[key] = { release, isFloor: false };
  }
  return policy;
}

// ── Withheld attestation ───────────────────────────────────────────────────────

/**
 * Attestation emitted for a withheld `on-consent` field.
 *
 * Keeps the response independently signature-verifiable: the consumer knows
 * the field was present and covered by the manifest signature without seeing
 * the actual value. Full ZKP hardening is #1226 (out of scope here).
 */
export interface WithheldAttestation {
  /** The field had a non-null value in the signed manifest. */
  present: boolean;
  /** Proof grade: the floor signature covers this field. */
  attestation: "covered-by-signature";
}

// ── Apply gates ────────────────────────────────────────────────────────────────

/** Result of applying the effective policy to a raw manifest. */
export interface ApplyGatesResult {
  /**
   * The filtered manifest: only fields whose effective release class passed
   * the gate for this caller are present. Floor fields are always here.
   */
  manifest: Record<string, unknown>;
  /**
   * Presence attestations for withheld `on-consent` fields. Empty when the
   * caller has grants for all on-consent fields (or none exist).
   */
  withheld: Record<string, WithheldAttestation>;
}

/**
 * Apply the effective disclosure policy to a raw .fair manifest object.
 *
 * Gate semantics:
 *   silent     → field included as-is.
 *   on-consent → included if `grantedFields` contains the field key;
 *                otherwise emitted as a `_withheld` presence attestation.
 *   never      → structural drop — absent from both `manifest` and `withheld`.
 *
 * Special handling:
 *   `attribution` — the array is always passed, but per-entry `name`/`note`
 *   sub-keys are stripped when their individual `attribution[*].<sub>` gate
 *   says `on-consent` and the caller lacks a matching grant. The presence
 *   attestation uses the `[*]` key so consumers know PII was present.
 *
 *   `distribution` / `transfer` — when the top-level gate is `on-consent`
 *   and not granted, the whole object is withheld. When it IS granted (or
 *   `silent`), the synthetic `amount` gate is evaluated to decide whether
 *   nested `price.amount` values are stripped.
 *
 *   `_disclosure` — never emitted (subject-authored metadata, not public).
 *
 * Fields not in the policy default to `silent` (pass-through for unknown
 * structural metadata).
 *
 * @param rawManifest  - Full .fair manifest from the lot (type-erased to handle
 *                       both v1.0 and v1.1 without separate code paths).
 * @param policy       - Resolved effective policy from composeEffectivePolicy().
 * @param grantedFields - Field keys the current caller has active consent for.
 */
export function applyDisclosureGates(
  rawManifest: FairManifest,
  policy: EffectivePolicy,
  grantedFields: ReadonlySet<string> = new Set(),
): ApplyGatesResult {
  const manifest: Record<string, unknown> = {};
  const withheld: Record<string, WithheldAttestation> = {};
  const raw = rawManifest as unknown as Record<string, unknown>;

  const amountPolicy: FairReleaseClass =
    policy["amount"]?.release ?? "on-consent";
  const amountGranted = grantedFields.has("amount");

  for (const [key, value] of Object.entries(raw)) {
    // _disclosure is subject-internal; never emitted
    if (key === "_disclosure") continue;

    const fieldKey = key as FairFieldKey;
    const release: FairReleaseClass =
      policy[fieldKey]?.release ?? "silent";

    if (release === "never") continue;

    if (release === "on-consent") {
      if (grantedFields.has(key)) {
        // Granted: include but still scrub nested amounts if `amount` is gated
        if (key === "distribution" && typeof value === "object" && value !== null) {
          manifest[key] = scrubAmountsFromDistribution(
            value as Record<string, unknown>,
            amountPolicy,
            amountGranted,
            withheld,
          );
        } else if (key === "transfer" && typeof value === "object" && value !== null) {
          manifest[key] = scrubAmountFromTransfer(
            value as Record<string, unknown>,
            amountPolicy,
            amountGranted,
            withheld,
          );
        } else {
          manifest[key] = value;
        }
      } else if (value !== undefined && value !== null) {
        withheld[key] = { present: true, attestation: "covered-by-signature" };
      }
      continue;
    }

    // ── silent: include, with sub-field gating for special cases ──────────

    if (key === "attribution" && Array.isArray(value)) {
      const namePolicy: FairReleaseClass =
        policy["attribution[*].name"]?.release ?? "silent";
      const notePolicy: FairReleaseClass =
        policy["attribution[*].note"]?.release ?? "silent";
      const nameGranted = grantedFields.has("attribution[*].name");
      const noteGranted = grantedFields.has("attribution[*].note");

      let hasNameWithheld = false;
      let hasNoteWithheld = false;

      manifest["attribution"] = (value as Record<string, unknown>[]).map(
        (entry) => {
          const out: Record<string, unknown> = { ...entry };

          if (namePolicy === "never") {
            delete out["name"];
          } else if (namePolicy === "on-consent" && !nameGranted) {
            if (out["name"] !== undefined && out["name"] !== null) {
              hasNameWithheld = true;
            }
            delete out["name"];
          }

          if (notePolicy === "never") {
            delete out["note"];
          } else if (notePolicy === "on-consent" && !noteGranted) {
            if (out["note"] !== undefined && out["note"] !== null) {
              hasNoteWithheld = true;
            }
            delete out["note"];
          }

          return out;
        },
      );

      if (hasNameWithheld) {
        withheld["attribution[*].name"] = {
          present: true,
          attestation: "covered-by-signature",
        };
      }
      if (hasNoteWithheld) {
        withheld["attribution[*].note"] = {
          present: true,
          attestation: "covered-by-signature",
        };
      }
      continue;
    }

    if (key === "distribution" && typeof value === "object" && value !== null) {
      manifest[key] = scrubAmountsFromDistribution(
        value as Record<string, unknown>,
        amountPolicy,
        amountGranted,
        withheld,
      );
      continue;
    }

    if (key === "transfer" && typeof value === "object" && value !== null) {
      manifest[key] = scrubAmountFromTransfer(
        value as Record<string, unknown>,
        amountPolicy,
        amountGranted,
        withheld,
      );
      continue;
    }

    manifest[key] = value;
  }

  return { manifest, withheld };
}

/** Strip `price.amount` from a distribution rights object when `amount` is on-consent+ungated. */
function scrubAmountsFromDistribution(
  distribution: Record<string, unknown>,
  amountPolicy: FairReleaseClass,
  amountGranted: boolean,
  withheld: Record<string, WithheldAttestation>,
): Record<string, unknown> {
  if (amountPolicy === "silent" || amountGranted) return distribution;

  const out: Record<string, unknown> = {};
  let didWithhold = false;

  for (const [key, right] of Object.entries(distribution)) {
    if (
      typeof right === "object" &&
      right !== null &&
      "price" in (right as Record<string, unknown>)
    ) {
      const r = right as Record<string, unknown>;
      const price = r["price"];
      if (price !== undefined && price !== null) {
        if (amountPolicy === "never") {
          const { price: _, ...rest } = r;
          out[key] = rest;
        } else {
          // on-consent and not granted
          didWithhold = true;
          const { price: _, ...rest } = r;
          out[key] = rest;
        }
        continue;
      }
    }
    out[key] = right;
  }

  if (didWithhold) {
    withheld["amount"] = { present: true, attestation: "covered-by-signature" };
  }
  return out;
}

/** Strip `price` from a transfer object when `amount` is on-consent+ungated. */
function scrubAmountFromTransfer(
  transfer: Record<string, unknown>,
  amountPolicy: FairReleaseClass,
  amountGranted: boolean,
  withheld: Record<string, WithheldAttestation>,
): Record<string, unknown> {
  if (amountPolicy === "silent" || amountGranted) return transfer;

  const price = transfer["price"];
  if (price === undefined || price === null) return transfer;

  if (amountPolicy === "never") {
    const { price: _, ...rest } = transfer;
    return rest;
  }
  // on-consent, not granted
  withheld["amount"] = { present: true, attestation: "covered-by-signature" };
  const { price: _, ...rest } = transfer;
  return rest;
}

// ── Subject gate parsing ───────────────────────────────────────────────────────

/**
 * Parse subject-authored field gates from `manifest._disclosure`.
 *
 * Returns an empty overlay if the field is absent or malformed (fail-safe —
 * subject gates are opt-in sovereignty enhancements, not security mechanisms;
 * the community overlay and floor remain authoritative for the floor).
 *
 * Format (co-signed in the manifest):
 * ```json
 * { "_disclosure": { "amount": { "release": "silent" } } }
 * ```
 *
 * SECURITY NOTE — loosening gates are unsigned until #1226-adjacent co-signing
 * lands: a subject gate that LOOSENS disclosure (e.g. `never` → `silent`) is
 * parsed and applied here but is not independently signature-verified at the
 * field level. Today this is safe because `lot.fairManifest` is only writable
 * via the owner-authenticated lot write path — the only party who can author a
 * loosening `_disclosure` is the owner themselves. Until per-field co-signing
 * is implemented, do NOT expose `parseSubjectGates` on any unauthenticated or
 * third-party write surface; doing so would allow arbitrary callers to widen
 * disclosure without the owner's signature.
 */
export function parseSubjectGates(
  rawManifest: Record<string, unknown>,
): FairDisclosureOverlay {
  const raw = rawManifest["_disclosure"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const gates: FairDisclosureOverlay = {};
  for (const [field, entry] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      continue;
    const e = entry as Record<string, unknown>;
    const release = e["release"];
    if (
      release === "silent" ||
      release === "on-consent" ||
      release === "never"
    ) {
      gates[field as FairFieldKey] = { release };
    }
  }
  return gates;
}
