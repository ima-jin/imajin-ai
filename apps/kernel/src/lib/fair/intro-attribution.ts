/**
 * Intro-attribution join surface (#1886) — the kernel-side glue between
 * #1882 delegation grants, #1885 attestations, and the `.fair` template in
 * `@imajin/fair`'s `intro-attribution.ts`. Two responsibilities:
 *
 *   1. Grant-time terms: record the matchmaker's declared split/window,
 *      consented by the delegator when they issue an `intros:propose`
 *      grant (`recordIntroAttributionTerms` / `getIntroAttributionTermsForGrant`).
 *   2. Settlement-time verification: resolve a `.fair` manifest's
 *      `provenance[]` refs to real attestation rows and run the shared
 *      money-rule gate (`verifyIntroAttributionManifestForSettlement`),
 *      used by `POST /pay/api/settle` before it moves any MJNx.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, delegationGrants, delegationGrantCapabilities, introAttributionTerms, attestations } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import {
  validateIntroAttributionSplitBps,
  validateIntroAttributionProvenance,
  DEFAULT_INTRO_ATTRIBUTION_SPLIT_BPS,
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  isIntroAttributionManifest,
  type IntroAttributionSplitBps,
  type AttestationFact,
  type FairManifestV1_1,
} from '@imajin/fair';

export interface LibError {
  error: string;
  status: number;
}

export interface IntroAttributionTermsRecord {
  id: string;
  grantId: string;
  knockId: string | null;
  delegatorDid: string;
  matchmakerDid: string;
  split: IntroAttributionSplitBps;
  attributionWindowDays: number;
  createdAt: string;
}

const INTROS_PROPOSE_CAPABILITY = 'intros:propose';

function toRecord(row: {
  id: string;
  grantId: string;
  knockId: string | null;
  delegatorDid: string;
  matchmakerDid: string;
  matchmakerShareBps: number;
  partyAShareBps: number;
  partyBShareBps: number;
  attributionWindowDays: number;
  createdAt: Date;
}): IntroAttributionTermsRecord {
  return {
    id: row.id,
    grantId: row.grantId,
    knockId: row.knockId,
    delegatorDid: row.delegatorDid,
    matchmakerDid: row.matchmakerDid,
    split: {
      matchmakerBps: row.matchmakerShareBps,
      partyABps: row.partyAShareBps,
      partyBBps: row.partyBShareBps,
    },
    attributionWindowDays: row.attributionWindowDays,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface RecordIntroAttributionTermsInput {
  grantId: string;
  delegatorDid: string;
  knockId?: string | null;
  split?: IntroAttributionSplitBps;
  attributionWindowDays?: number;
}

/**
 * Record the matchmaker's declared terms for a just-issued grant. Callers
 * (the `/auth/api/grants` route) are responsible for calling this only
 * after `issueGrant()` has already succeeded, so a validation failure here
 * never leaves half-created state on the grant itself.
 *
 * One-shot by construction (mirrors grant issuance): a grant's terms are
 * consented once, at grant time — this returns 409 rather than upserting
 * if terms already exist for the grant, so a re-declaration requires a new
 * grant (and thus fresh delegator consent), never a silent overwrite.
 */
export async function recordIntroAttributionTerms(
  input: RecordIntroAttributionTermsInput,
): Promise<{ terms: IntroAttributionTermsRecord } | LibError> {
  const split = input.split ?? DEFAULT_INTRO_ATTRIBUTION_SPLIT_BPS;
  const splitCheck = validateIntroAttributionSplitBps(split);
  if (!splitCheck.ok) {
    return { error: splitCheck.error ?? 'invalid split', status: 400 };
  }
  const attributionWindowDays = input.attributionWindowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS;
  if (!Number.isInteger(attributionWindowDays) || attributionWindowDays <= 0) {
    return { error: 'attributionWindowDays must be a positive integer', status: 400 };
  }

  const [grant] = await db
    .select({ id: delegationGrants.id, agentDid: delegationGrants.agentDid, delegatorDid: delegationGrants.delegatorDid })
    .from(delegationGrants)
    .where(eq(delegationGrants.id, input.grantId))
    .limit(1);
  if (!grant) return { error: 'Grant not found', status: 404 };
  if (grant.delegatorDid !== input.delegatorDid) {
    return { error: 'Only the grant\u2019s own delegator may declare its intro-attribution terms', status: 403 };
  }

  const [activeIntrosPropose] = await db
    .select({ id: delegationGrantCapabilities.id })
    .from(delegationGrantCapabilities)
    .where(
      and(
        eq(delegationGrantCapabilities.grantId, input.grantId),
        eq(delegationGrantCapabilities.capability, INTROS_PROPOSE_CAPABILITY),
        eq(delegationGrantCapabilities.status, 'active'),
      ),
    )
    .limit(1);
  if (!activeIntrosPropose) {
    return { error: `Grant must carry an active ${INTROS_PROPOSE_CAPABILITY} capability to declare intro-attribution terms`, status: 400 };
  }

  const [existing] = await db
    .select({ id: introAttributionTerms.id })
    .from(introAttributionTerms)
    .where(eq(introAttributionTerms.grantId, input.grantId))
    .limit(1);
  if (existing) {
    return { error: 'Intro-attribution terms are already declared for this grant', status: 409 };
  }

  const id = generateId('iat');
  const createdAt = new Date();
  await db.insert(introAttributionTerms).values({
    id,
    grantId: input.grantId,
    knockId: input.knockId ?? null,
    delegatorDid: input.delegatorDid,
    matchmakerDid: grant.agentDid,
    matchmakerShareBps: split.matchmakerBps,
    partyAShareBps: split.partyABps,
    partyBShareBps: split.partyBBps,
    attributionWindowDays,
    createdAt,
  });

  return {
    terms: toRecord({
      id,
      grantId: input.grantId,
      knockId: input.knockId ?? null,
      delegatorDid: input.delegatorDid,
      matchmakerDid: grant.agentDid,
      matchmakerShareBps: split.matchmakerBps,
      partyAShareBps: split.partyABps,
      partyBShareBps: split.partyBBps,
      attributionWindowDays,
      createdAt,
    }),
  };
}

/**
 * Fetch a grant's declared intro-attribution terms, or null if none were
 * declared. Deliberately does not check the grant's own status/expiry —
 * attribution survives grant expiry (#1886 invariant 8), so a caller
 * checking whether a settlement is still eligible must consult the
 * attribution window (`attributionWindowDays`), not this grant's lifecycle.
 */
export async function getIntroAttributionTermsForGrant(grantId: string): Promise<IntroAttributionTermsRecord | null> {
  const [row] = await db.select().from(introAttributionTerms).where(eq(introAttributionTerms.grantId, grantId)).limit(1);
  return row ? toRecord(row) : null;
}

/** Resolve a set of attestation ids to the minimal facts the money-rule gate needs. */
export async function resolveAttestationFacts(ids: string[]): Promise<AttestationFact[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: attestations.id,
      type: attestations.type,
      issuedAt: attestations.issuedAt,
      attestationStatus: attestations.attestationStatus,
    })
    .from(attestations)
    .where(inArray(attestations.id, ids));

  return rows.map((row: { id: string; type: string; issuedAt: Date; attestationStatus: string | null }) => ({
    id: row.id,
    type: row.type,
    issuedAt: row.issuedAt.toISOString(),
    attestationStatus: row.attestationStatus,
  }));
}

export type SettlementVerification = { ok: true } | { ok: false; error: string };

/**
 * The settlement-time enforcement point (#1886): given the `fair_manifest`
 * a caller submitted to `POST /pay/api/settle`, decide whether it may
 * proceed. A no-op (`{ ok: true }`) for every manifest that is not this
 * template — this guard must never affect unrelated settlements (tickets,
 * media, listings, ...).
 *
 * For an intro-attribution manifest: resolves every `provenance[]` ref to
 * a real `auth.attestations` row and runs `@imajin/fair`'s
 * `validateIntroAttributionProvenance` against them — the single money-rule
 * gate shared by both trigger classes (on-platform settlement facts need no
 * further corroboration; a `value_realized` ref must be countersigned).
 */
export async function verifyIntroAttributionManifestForSettlement(
  fairManifest: Partial<FairManifestV1_1> | null | undefined,
): Promise<SettlementVerification> {
  if (!isIntroAttributionManifest(fairManifest ?? null)) {
    return { ok: true };
  }
  const manifest = fairManifest as FairManifestV1_1;
  const provenance = manifest.provenance ?? [];
  if (provenance.length === 0) {
    return { ok: false, error: 'intro-attribution manifest requires a non-empty provenance[]' };
  }

  const windowDays =
    typeof manifest.intent?.constraints?.attributionWindowDays === 'number'
      ? (manifest.intent.constraints.attributionWindowDays as number)
      : DEFAULT_ATTRIBUTION_WINDOW_DAYS;

  const resolvedFacts = await resolveAttestationFacts(provenance.map((ref: { attestationId: string }) => ref.attestationId));

  return validateIntroAttributionProvenance({ provenance, resolvedFacts, windowDays });
}
