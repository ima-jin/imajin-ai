/**
 * `.fair` intro-attribution template (#1886) — template-as-data for the
 * matchmaking pattern, riding the existing `.fair` cascade (#509) rather
 * than a new settlement engine.
 *
 * Settled design (RFC #1881 Day-1 review, 2026-08-30, carried into #1886's
 * own Day-1 review):
 *   - Trigger is always a bilaterally-signed economic fact, never a
 *     declaration by the beneficiary. On-platform settlement is itself
 *     already the strongest countersignature there is; off-platform value
 *     requires a `value_realized` attestation (#1885's registry-as-data)
 *     that has been COUNTERSIGNED (evidence grade `corroborated`) — a
 *     `pending` (unilateral) claim must never trigger settlement.
 *   - The split is the agent's offer, consented at grant time (#1882) —
 *     70/15/15 is only the template default, overridable per-agreement.
 *   - `.fair.provenance[]` is one-directional: money manifests point at
 *     attestation facts; attestations never point at money.
 *   - Attribution survives grant expiry (expiry severs authority, not
 *     attribution) but is bounded by a declared attribution window
 *     (default 12 months / 365 days from `intro_made`).
 *
 * This module is deliberately dependency-free (no DB, no @imajin/auth) so
 * it can be unit tested in isolation and reused by any caller (a settlement
 * guard, an admin tool, a future reactor) that has already resolved the
 * attestation facts it needs to check.
 */
import type { DidShareEntry, FairManifestV1_1, FairProvenanceRef } from './types';

/** The off-platform "value happened" fact (#1886) — registered in #1885's attestation-type registry. */
export const VALUE_REALIZED_ATTESTATION_TYPE = 'value_realized';

/** The funnel fact whose `issuedAt` anchors the attribution window (#1885). */
export const INTRO_MADE_ATTESTATION_TYPE = 'intro_made';

/** `.fair` manifest `type` discriminator for this template. */
export const INTRO_ATTRIBUTION_MANIFEST_TYPE = 'intro-attribution';

/** Fixed roles used in an intro-attribution manifest's `attribution[]` / settlement chain. */
export const INTRO_ATTRIBUTION_ROLES = {
  MATCHMAKER: 'matchmaker',
  PARTY_A: 'party_a',
  PARTY_B: 'party_b',
} as const;

export type IntroAttributionRole = (typeof INTRO_ATTRIBUTION_ROLES)[keyof typeof INTRO_ATTRIBUTION_ROLES];

/** Basis-points split between the three funnel participants. Must sum to 10000. */
export interface IntroAttributionSplitBps {
  matchmakerBps: number;
  partyABps: number;
  partyBBps: number;
}

const BPS_TOTAL = 10_000;

/** Template default (#1886 Day-1 review): 70/15/15 matchmaker/party-A/party-B. */
export const DEFAULT_INTRO_ATTRIBUTION_SPLIT_BPS: IntroAttributionSplitBps = {
  matchmakerBps: 7000,
  partyABps: 1500,
  partyBBps: 1500,
};

/** Template default attribution window: 12 months from `intro_made`. */
export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 365;

export interface SplitValidationResult {
  ok: boolean;
  error?: string;
}

/** Validate that a declared split is well-formed and sums to exactly 10000 bps. */
export function validateIntroAttributionSplitBps(split: IntroAttributionSplitBps): SplitValidationResult {
  const { matchmakerBps, partyABps, partyBBps } = split;
  for (const [name, value] of [
    ['matchmakerBps', matchmakerBps],
    ['partyABps', partyABps],
    ['partyBBps', partyBBps],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > BPS_TOTAL) {
      return { ok: false, error: `${name} must be an integer between 0 and ${BPS_TOTAL}` };
    }
  }
  const total = matchmakerBps + partyABps + partyBBps;
  if (total !== BPS_TOTAL) {
    return { ok: false, error: `split must sum to ${BPS_TOTAL} bps, got ${total}` };
  }
  return { ok: true };
}

export interface AttributionWindowParams {
  /** ISO 8601 timestamp of the `intro_made` attestation — the window's anchor. */
  introMadeAt: string;
  /** ISO 8601 timestamp to evaluate against. Defaults to now. */
  at?: string;
  /** Declared attribution window, in days. */
  windowDays: number;
}

/**
 * True when `at` (default: now) falls within `windowDays` of `introMadeAt`.
 * Pure date arithmetic — callers own resolving `introMadeAt` from a real
 * attestation row.
 */
export function isWithinAttributionWindow(params: AttributionWindowParams): boolean {
  const introMadeAtMs = new Date(params.introMadeAt).getTime();
  const atMs = params.at ? new Date(params.at).getTime() : Date.now();
  if (Number.isNaN(introMadeAtMs) || Number.isNaN(atMs)) return false;
  const windowMs = params.windowDays * 24 * 60 * 60 * 1000;
  return atMs >= introMadeAtMs && atMs <= introMadeAtMs + windowMs;
}

/** Minimal, storage-independent shape of an attestation fact needed to gate a trigger. */
export interface AttestationFact {
  id: string;
  type: string;
  /** ISO 8601. */
  issuedAt: string;
  /** `auth.attestations.attestation_status` — 'pending' | 'bilateral' | 'declined' | null. */
  attestationStatus?: string | null;
}

export type ProvenanceGateResult = { ok: true } | { ok: false; error: string };

/**
 * The money-rule join surface (#1886): given a manifest's `provenance[]`
 * refs and the real attestation facts they resolve to (caller-fetched),
 * decide whether this settlement may proceed.
 *
 * Rules, in order:
 *   1. Every provenance ref must resolve to a real fact (`resolvedFacts`
 *      covers every `attestationId` in `provenance`) — a dangling
 *      reference is refused outright, never silently ignored.
 *   2. At least one ref must be an `intro_made` fact — it anchors the
 *      attribution window. No genesis, no attribution.
 *   3. Any `value_realized` ref must be `attestationStatus === 'bilateral'`
 *      (corroborated). A `pending` (unilateral) or `declined` (disputed)
 *      claim never triggers settlement — this is the money rule from
 *      #1885/#1886: agent self-report alone is structurally worthless.
 *   4. `at` (default: now) must fall inside the declared attribution
 *      window measured from the `intro_made` fact's `issuedAt`. Expiry
 *      stops NEW attribution; it says nothing about settlements that
 *      already happened (those are immutable historical records).
 */
export function validateIntroAttributionProvenance(params: {
  provenance: FairProvenanceRef[];
  resolvedFacts: AttestationFact[];
  windowDays: number;
  at?: string;
}): ProvenanceGateResult {
  const { provenance, resolvedFacts, windowDays, at } = params;

  if (!provenance || provenance.length === 0) {
    return { ok: false, error: 'intro-attribution manifest requires a non-empty provenance[]' };
  }

  const factsById = new Map(resolvedFacts.map((fact) => [fact.id, fact]));

  for (const ref of provenance) {
    if (!factsById.has(ref.attestationId)) {
      return { ok: false, error: `provenance references an attestation that does not exist: ${ref.attestationId}` };
    }
  }

  const introMade = resolvedFacts.find((fact) => fact.type === INTRO_MADE_ATTESTATION_TYPE);
  if (!introMade) {
    return { ok: false, error: 'provenance must reference an intro_made attestation to anchor the attribution window' };
  }

  const valueRealizedRefs = resolvedFacts.filter((fact) => fact.type === VALUE_REALIZED_ATTESTATION_TYPE);
  for (const fact of valueRealizedRefs) {
    if (fact.attestationStatus !== 'bilateral') {
      return {
        ok: false,
        error: `value_realized attestation ${fact.id} must be countersigned (bilateral) before it can trigger settlement`,
      };
    }
  }

  if (!isWithinAttributionWindow({ introMadeAt: introMade.issuedAt, at, windowDays })) {
    return { ok: false, error: 'attribution window has expired for this intro' };
  }

  return { ok: true };
}

export interface BuildIntroAttributionManifestParams {
  id: string;
  matchmakerDid: string;
  partyADid: string;
  partyBDid: string;
  /** Defaults to {@link DEFAULT_INTRO_ATTRIBUTION_SPLIT_BPS}. */
  split?: IntroAttributionSplitBps;
  /** Defaults to {@link DEFAULT_ATTRIBUTION_WINDOW_DAYS}. */
  attributionWindowDays?: number;
  /** One-directional refs into the attestation chain that justifies this manifest. */
  provenance: FairProvenanceRef[];
  /** ISO 8601 — the anchoring `intro_made` attestation's issuedAt. */
  introMadeAt: string;
  /** ISO 8601. Defaults to now. */
  created?: string;
}

/**
 * Build a `.fair` v1.1 manifest for the intro-attribution template.
 * Template-as-data alongside the existing media/ticket/course templates in
 * `templates.ts` — this one has no asset to attach to, so it lives as its
 * own builder rather than an entry in that upload-defaults map.
 */
export function buildIntroAttributionManifest(params: BuildIntroAttributionManifestParams): FairManifestV1_1 {
  const split = params.split ?? DEFAULT_INTRO_ATTRIBUTION_SPLIT_BPS;
  const splitCheck = validateIntroAttributionSplitBps(split);
  if (!splitCheck.ok) {
    throw new Error(`buildIntroAttributionManifest: invalid split — ${splitCheck.error}`);
  }
  const attributionWindowDays = params.attributionWindowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS;

  const attribution: DidShareEntry[] = [
    { did: params.matchmakerDid, role: INTRO_ATTRIBUTION_ROLES.MATCHMAKER, share: split.matchmakerBps / BPS_TOTAL },
    { did: params.partyADid, role: INTRO_ATTRIBUTION_ROLES.PARTY_A, share: split.partyABps / BPS_TOTAL },
    { did: params.partyBDid, role: INTRO_ATTRIBUTION_ROLES.PARTY_B, share: split.partyBBps / BPS_TOTAL },
  ];

  return {
    fair: '1.1',
    version: '1.1',
    id: params.id,
    type: INTRO_ATTRIBUTION_MANIFEST_TYPE,
    owner: params.matchmakerDid,
    created: params.created ?? new Date().toISOString(),
    source: 'intro-attribution',
    access: { type: 'private', allowedDids: [params.matchmakerDid, params.partyADid, params.partyBDid] },
    attribution,
    provenance: params.provenance,
    intent: {
      purpose: 'intro-attribution',
      constraints: {
        attributionWindowDays,
        introMadeAt: params.introMadeAt,
      },
    },
  };
}

/** `{did, role, share}` triple compatible with `resolveSettlementChain` from `./settlement`. */
export interface IntroAttributionChainEntry {
  did: string;
  role: IntroAttributionRole;
  share: number;
}

/**
 * Resolve the three-way settlement chain for an intro-attribution manifest,
 * in the shape `resolveSettlementChain` (`./settlement`) expects.
 */
export function introAttributionSettlementChain(params: {
  matchmakerDid: string;
  partyADid: string;
  partyBDid: string;
  split?: IntroAttributionSplitBps;
}): IntroAttributionChainEntry[] {
  const split = params.split ?? DEFAULT_INTRO_ATTRIBUTION_SPLIT_BPS;
  return [
    { did: params.matchmakerDid, role: INTRO_ATTRIBUTION_ROLES.MATCHMAKER, share: split.matchmakerBps / BPS_TOTAL },
    { did: params.partyADid, role: INTRO_ATTRIBUTION_ROLES.PARTY_A, share: split.partyABps / BPS_TOTAL },
    { did: params.partyBDid, role: INTRO_ATTRIBUTION_ROLES.PARTY_B, share: split.partyBBps / BPS_TOTAL },
  ];
}

/** True when a manifest is (or claims to be) an intro-attribution manifest. */
export function isIntroAttributionManifest(
  manifest: Partial<Pick<FairManifestV1_1, 'type'>> | null | undefined,
): boolean {
  return !!manifest && manifest.type === INTRO_ATTRIBUTION_MANIFEST_TYPE;
}
