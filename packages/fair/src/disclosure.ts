/**
 * Canonical .fair disclosure engine (#1453).
 *
 * Single source of truth for:
 *   - The release-tier vocabulary (FairReleaseTier, 4 tiers)
 *   - The #1196 consent-2x2 derivation (FieldClassification, deriveReleaseTier)
 *   - The manifest field-key vocabulary (FairFieldKey)
 *   - The floor field set (FAIR_FLOOR_FIELDS)
 *   - The composable disclosure overlay model and gate functions
 *
 * Previously split across apps/kernel/src/lib/media/release-policy.ts (asset-side,
 * 4-tier) and apps/kernel/src/lib/media/fair-disclosure-policy.ts (lot-side,
 * 3-tier, owner-only silently dropped). Decision A (2026-07-28) keeps all four
 * tiers; Decision B places the shared engine here as a pure module so
 * packages/bus can import it without violating its boundary rules.
 *
 * This module is PURE — no DB, HTTP, or Drizzle imports. I/O (consent-grant
 * lookup, nodeConfig load) stays in the route/consumer; this module only makes
 * disclosure *decisions* given pure inputs.
 */

import type { FairManifest } from './types';

// ── Release tier ───────────────────────────────────────────────────────────────

/**
 * Release tier for a .fair manifest field. Four tiers ordered from least
 * to most restrictive by {@link TIER_RANK}.
 *
 * - `silent`     — always disclosed (public pass-through)
 * - `on-consent` — disclosed only with an active consent_grants row for the caller
 * - `owner-only` — disclosed only to the manifest owner; no consent grant can
 *                  expose it to a counterparty (sovereignty-preserving tier)
 * - `never`      — structural drop; absent from both manifest and _withheld
 */
export type FairReleaseTier = 'silent' | 'on-consent' | 'owner-only' | 'never';

/** All tiers ordered least → most restrictive. */
export const FAIR_RELEASE_TIERS: readonly FairReleaseTier[] = [
  'silent',
  'on-consent',
  'owner-only',
  'never',
] as const;

/**
 * Restrictiveness ranking. Higher rank discloses LESS. An override is only
 * valid when its rank is >= the derived tier's rank (it may only tighten).
 */
export const TIER_RANK: Record<FairReleaseTier, number> = {
  silent: 0,
  'on-consent': 1,
  'owner-only': 2,
  never: 3,
};

// ── #1196 consent 2x2 ─────────────────────────────────────────────────────────

/**
 * The #1196 consent 2x2 classification of a field/row. The two axes are:
 *   - `disclosesOthers`: does releasing this field reveal data about someone
 *     other than the document owner?
 *   - `sensitive`: is the field sensitive?
 */
export interface FieldClassification {
  disclosesOthers: boolean;
  sensitive: boolean;
}

/**
 * Derive the default release tier from the #1196 consent 2x2.
 *
 * CANONICAL IMPLEMENTATION of the #1196 decision record. Restrictiveness is
 * monotonic in both axes:
 *
 *   not-others, not-sensitive  → silent      (freely projectable)
 *   discloses-others, not-sensitive → on-consent  (needs others' consent)
 *   not-others, sensitive      → owner-only  (owner sees it, no grant can open it)
 *   discloses-others, sensitive → never      (most restrictive default)
 */
export function deriveReleaseTier(classification: FieldClassification): FairReleaseTier {
  if (!classification.disclosesOthers && !classification.sensitive) return 'silent';
  if (classification.disclosesOthers && !classification.sensitive) return 'on-consent';
  if (!classification.disclosesOthers && classification.sensitive) return 'owner-only';
  return 'never';
}

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
  | 'id'
  | 'type'
  | 'created'
  | 'fair'
  | 'version'
  | 'integrity'
  | 'signature'
  | 'platformSignature'
  // ── Structural metadata ──
  | 'owner'
  | 'source'
  | 'access'
  | 'terms'
  | 'intent'
  | 'tipping'
  | 'settlement'
  // ── Fee rates (public by default — rates ≠ amounts) ──
  | 'fees'
  // ── Attribution array (top-level silent; sub-key name/note may be on-consent) ──
  | 'attribution'
  | 'attribution[*].did'
  | 'attribution[*].role'
  | 'attribution[*].share'
  | 'attribution[*].chainProof'
  | 'attribution[*].name'
  | 'attribution[*].note'
  // ── Distribution/transfer rights ──
  | 'distribution'
  | 'transfer'
  | 'distributions'
  | 'chain'
  | 'training'
  | 'commercial'
  // ── Synthetic key covering ALL Money.amount values ──
  | 'amount';

// ── Floor ──────────────────────────────────────────────────────────────────────

/**
 * Floor field set: existence + integrity + signature.
 *
 * These are ALWAYS disclosed at `silent` regardless of community or subject
 * settings. The public record asserts "a real, signed settlement of type X
 * occurred at T — verify the sig."
 */
export const FAIR_FLOOR_FIELDS: ReadonlySet<FairFieldKey> = new Set<FairFieldKey>([
  'id',
  'type',
  'created',
  'fair',
  'version',
  'integrity',
  'signature',
  'platformSignature',
]);

// ── Overlay types ──────────────────────────────────────────────────────────────

/** One entry in a disclosure overlay — just the release tier for one field. */
export interface FieldOverlayEntry {
  release: FairReleaseTier;
}

/**
 * Per-field disclosure overlay. Keys are {@link FairFieldKey}s; values declare
 * the release tier for that field in this deployment/subject context.
 *
 * Stored in `nodeConfig` (key `fair.disclosure.overlay`) for the community
 * overlay, or in `manifest._disclosure` for subject-authored gates.
 */
export type FairDisclosureOverlay = Partial<Record<FairFieldKey, FieldOverlayEntry>>;

// ── Effective policy ───────────────────────────────────────────────────────────

/** Resolved policy entry for one field. */
export interface EffectiveFieldPolicy {
  release: FairReleaseTier;
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
 *      the community default.
 *   3. Fields not in either overlay default to `silent`.
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
      policy[key] = { release: 'silent', isFloor: true };
      continue;
    }
    const release =
      subjectGates[key]?.release ?? communityOverlay[key]?.release ?? 'silent';
    policy[key] = { release, isFloor: false };
  }
  return policy;
}

// ── Withheld attestation ───────────────────────────────────────────────────────

/**
 * Attestation emitted for a withheld `on-consent` or `owner-only` field.
 *
 * Keeps the response independently signature-verifiable: the consumer knows
 * the field was present and covered by the manifest signature without seeing
 * the actual value. Full ZKP hardening is #1226 (out of scope here).
 */
export interface WithheldAttestation {
  /** The field had a non-null value in the signed manifest. */
  present: boolean;
  /** Proof grade: the floor signature covers this field. */
  attestation: 'covered-by-signature';
}

// ── Apply gates ────────────────────────────────────────────────────────────────

/** Result of applying the effective policy to a raw manifest. */
export interface ApplyGatesResult {
  /**
   * The filtered manifest: only fields whose effective release tier passed
   * the gate for this caller are present. Floor fields are always here.
   */
  manifest: Record<string, unknown>;
  /**
   * Presence attestations for withheld `on-consent` and `owner-only` fields.
   * Empty when the caller has grants for all on-consent fields (or none exist).
   */
  withheld: Record<string, WithheldAttestation>;
}

/**
 * Apply the effective disclosure policy to a raw .fair manifest object.
 *
 * Gate semantics:
 *   silent     → field included as-is.
 *   on-consent → included if `grantedFields` contains the field key;
 *                otherwise emitted as a `_withheld` presence attestation so the
 *                floor + signature remain independently verifiable.
 *   owner-only → included if `isOwner` is true (the caller IS the manifest owner);
 *                otherwise withheld with attestation. No consent grant can ever
 *                expose an `owner-only` field to a counterparty.
 *   never      → structural drop — absent from both `manifest` and `withheld`.
 *
 * Special handling:
 *   `attribution` — array always passed, but per-entry `name`/`note` sub-keys
 *   are stripped when their individual `attribution[*].<sub>` gate says
 *   `on-consent` and the caller lacks a matching grant.
 *
 *   `distribution` / `transfer` — when the top-level gate is `on-consent` and
 *   not granted, the whole object is withheld. When granted (or `silent`), the
 *   synthetic `amount` gate is evaluated to decide whether nested `price.amount`
 *   values are stripped.
 *
 *   `_disclosure` — never emitted (subject-authored metadata, not public).
 *
 * @param rawManifest   - Full .fair manifest (type-erased to handle v1.0 + v1.1).
 * @param policy        - Resolved effective policy from composeEffectivePolicy().
 * @param grantedFields - Field keys the current caller has active consent for.
 * @param isOwner       - True when the authenticated caller IS the manifest owner.
 *                        Unlocks `owner-only` fields. Defaults to false (fail-closed).
 */
export function applyDisclosureGates(
  rawManifest: FairManifest,
  policy: EffectivePolicy,
  grantedFields: ReadonlySet<string> = new Set(),
  isOwner = false,
): ApplyGatesResult {
  const manifest: Record<string, unknown> = {};
  const withheld: Record<string, WithheldAttestation> = {};
  const raw = rawManifest as unknown as Record<string, unknown>;

  const ctx: GateContext = {
    policy,
    grantedFields,
    isOwner,
    amountPolicy: policy['amount']?.release ?? 'on-consent',
    amountGranted: grantedFields.has('amount'),
    withheld,
  };

  for (const [key, value] of Object.entries(raw)) {
    // _disclosure is subject-internal; never emitted
    if (key === '_disclosure') continue;

    const release: FairReleaseTier = policy[key as FairFieldKey]?.release ?? 'silent';

    if (release === 'never') continue;

    if (release === 'owner-only') {
      if (isOwner) manifest[key] = value;
      else withholdIfPresent(withheld, key, value);
      continue;
    }

    if (release === 'on-consent') {
      // Granted: include but still scrub nested amounts if `amount` is gated
      if (grantedFields.has(key)) manifest[key] = scrubAmountBearingField(key, value, ctx);
      else withholdIfPresent(withheld, key, value);
      continue;
    }

    // ── silent: include, with sub-field gating for special cases ──────────
    if (key === 'attribution' && Array.isArray(value)) {
      manifest['attribution'] = applyAttributionGates(
        value as Record<string, unknown>[],
        ctx,
      );
      continue;
    }

    manifest[key] = scrubAmountBearingField(key, value, ctx);
  }

  return { manifest, withheld };
}

/** Shared read-only context threaded through the disclosure-gate helpers. */
interface GateContext {
  policy: EffectivePolicy;
  grantedFields: ReadonlySet<string>;
  isOwner: boolean;
  amountPolicy: FairReleaseTier;
  amountGranted: boolean;
  withheld: Record<string, WithheldAttestation>;
}

/** Record a `_withheld` presence attestation when the value is actually present. */
function withholdIfPresent(
  withheld: Record<string, WithheldAttestation>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined && value !== null) {
    withheld[key] = { present: true, attestation: 'covered-by-signature' };
  }
}

/**
 * Pass a field through, scrubbing nested `price.amount` values for the
 * amount-bearing `distribution` / `transfer` objects per the synthetic
 * `amount` gate. All other fields are returned unchanged.
 */
function scrubAmountBearingField(key: string, value: unknown, ctx: GateContext): unknown {
  if (key === 'distribution' && typeof value === 'object' && value !== null) {
    return scrubAmountsFromDistribution(
      value as Record<string, unknown>,
      ctx.amountPolicy,
      ctx.amountGranted,
      ctx.withheld,
    );
  }
  if (key === 'transfer' && typeof value === 'object' && value !== null) {
    return scrubAmountFromTransfer(
      value as Record<string, unknown>,
      ctx.amountPolicy,
      ctx.amountGranted,
      ctx.withheld,
    );
  }
  return value;
}

/**
 * Gate a single attribution sub-field (`name` / `note`) in place. Mutates
 * `out`, deleting the sub-key when the effective policy withholds it. Returns
 * true when a present value was withheld (a `_withheld` attestation is owed).
 */
function gateAttributionSubField(
  out: Record<string, unknown>,
  subKey: string,
  policy: FairReleaseTier,
  granted: boolean,
  isOwner: boolean,
): boolean {
  if (policy === 'never') {
    delete out[subKey];
    return false;
  }
  const withhold =
    (policy === 'on-consent' && !granted) || (policy === 'owner-only' && !isOwner);
  if (!withhold) return false;
  const present = out[subKey] !== undefined && out[subKey] !== null;
  delete out[subKey];
  return present;
}

/**
 * Apply per-entry `name` / `note` sub-field gating to an `attribution` array,
 * recording aggregate `_withheld` attestations on `ctx.withheld`.
 */
function applyAttributionGates(
  entries: Record<string, unknown>[],
  ctx: GateContext,
): Record<string, unknown>[] {
  const namePolicy: FairReleaseTier = ctx.policy['attribution[*].name']?.release ?? 'silent';
  const notePolicy: FairReleaseTier = ctx.policy['attribution[*].note']?.release ?? 'silent';
  const nameGranted = ctx.grantedFields.has('attribution[*].name');
  const noteGranted = ctx.grantedFields.has('attribution[*].note');

  let hasNameWithheld = false;
  let hasNoteWithheld = false;

  const gated = entries.map((entry) => {
    const out: Record<string, unknown> = { ...entry };
    if (gateAttributionSubField(out, 'name', namePolicy, nameGranted, ctx.isOwner)) {
      hasNameWithheld = true;
    }
    if (gateAttributionSubField(out, 'note', notePolicy, noteGranted, ctx.isOwner)) {
      hasNoteWithheld = true;
    }
    return out;
  });

  if (hasNameWithheld) {
    ctx.withheld['attribution[*].name'] = { present: true, attestation: 'covered-by-signature' };
  }
  if (hasNoteWithheld) {
    ctx.withheld['attribution[*].note'] = { present: true, attestation: 'covered-by-signature' };
  }
  return gated;
}

/** Strip `price.amount` from a distribution rights object when `amount` is on-consent+ungated. */
function scrubAmountsFromDistribution(
  distribution: Record<string, unknown>,
  amountPolicy: FairReleaseTier,
  amountGranted: boolean,
  withheld: Record<string, WithheldAttestation>,
): Record<string, unknown> {
  if (amountPolicy === 'silent' || amountGranted) return distribution;

  const out: Record<string, unknown> = {};
  let didWithhold = false;

  for (const [key, right] of Object.entries(distribution)) {
    if (
      typeof right === 'object' &&
      right !== null &&
      'price' in (right as Record<string, unknown>)
    ) {
      const r = right as Record<string, unknown>;
      const price = r['price'];
      if (price !== undefined && price !== null) {
        if (amountPolicy === 'never') {
          const { price: _, ...rest } = r;
          out[key] = rest;
        } else {
          // on-consent or owner-only and not granted/owner
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
    withheld['amount'] = { present: true, attestation: 'covered-by-signature' };
  }
  return out;
}

/** Strip `price` from a transfer object when `amount` is on-consent+ungated. */
function scrubAmountFromTransfer(
  transfer: Record<string, unknown>,
  amountPolicy: FairReleaseTier,
  amountGranted: boolean,
  withheld: Record<string, WithheldAttestation>,
): Record<string, unknown> {
  if (amountPolicy === 'silent' || amountGranted) return transfer;

  const price = transfer['price'];
  if (price === undefined || price === null) return transfer;

  if (amountPolicy === 'never') {
    const { price: _, ...rest } = transfer;
    return rest;
  }
  // on-consent or owner-only, not granted/owner
  withheld['amount'] = { present: true, attestation: 'covered-by-signature' };
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
 * lands. Today this is safe because `lot.fairManifest` is only writable via the
 * owner-authenticated lot write path. Do NOT expose `parseSubjectGates` on any
 * unauthenticated or third-party write surface.
 */
export function parseSubjectGates(
  rawManifest: Record<string, unknown>,
): FairDisclosureOverlay {
  const raw = rawManifest['_disclosure'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const gates: FairDisclosureOverlay = {};
  for (const [field, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      continue;
    const e = entry as Record<string, unknown>;
    const release = e['release'];
    if (
      release === 'silent' ||
      release === 'on-consent' ||
      release === 'owner-only' ||
      release === 'never'
    ) {
      gates[field as FairFieldKey] = { release };
    }
  }
  return gates;
}
