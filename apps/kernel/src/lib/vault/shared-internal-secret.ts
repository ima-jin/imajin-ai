/**
 * Cross-service grants for self-provisioned internal secrets (#2245 —
 * second target of the #2241 epic, `ATTESTATION_INTERNAL_API_KEY`).
 *
 * `internal-secret.ts`'s `getInternalSecret`/`getOrGenerateInternalSecret`
 * self-provision AND self-grant a purpose's secret to the node's own DID —
 * exactly right for a single in-process consumer (#2245's first target,
 * the foreign-principal-stub pepper, PR #2274). `ATTESTATION_INTERNAL_API_KEY`
 * needs a SECOND, external consumer: corpus, which forwards ingestion
 * attestations to the kernel (`apps/corpus/src/lib/attestation-forwarder.ts`)
 * and must authenticate with the exact same key value the kernel checks
 * (`apps/kernel/src/lib/auth/require-internal-api-key.ts`).
 *
 * Ruling (Ryan, 2026-09-22, via #2245 — see `internal-secret.ts`'s own
 * docblock for the full quote): a shared, cross-service secret needs a
 * human to countersign import/rotate/revoke. Self-provisioning (existence)
 * stays fully automatic; granting the SAME secret to a second party is a
 * deliberate, operator-run action (this module's {@link grantInternalSecretTo}),
 * never something that happens automatically at boot. In this codebase
 * "operator-run" today means invoking this function directly from a script
 * (`scripts/grant-attestation-internal-api-key.ts`) — the full countersigned
 * canvas-proposal rail (#2247's `vault:grant`) only understands
 * `vault_minted_keys`-shaped fields today; wiring an internal-secret purpose
 * into that proposal vocabulary is out of scope for #2245 (a UI is
 * explicitly not required — see the #2245 issue's own "out of scope" note).
 *
 * ## No re-seal (same reasoning as #2247's `grantExistingMintedKey`)
 * The field's AES key is wrapped to the NODE's own X25519 public key, never
 * to anything derived from `grantedTo` (see `sealAndGrantStaticSecret`'s own
 * docs) — `grantedTo` is an authorization LABEL matched at fetch time, not
 * a distinct cryptographic recipient. So a new `vault_delegation_grants` row
 * for a new `grantedTo` can safely reuse the EXACT SAME
 * wrappedKey/wrappedNonce/ownerXPub/keyId an existing active row for the
 * same field already carries, re-signed by the node's own identity. This
 * generalizes `./grant.ts`'s `grantExistingMintedKey` (which does the
 * identical thing for a `vault_minted_keys` field) to a purpose-bound
 * internal-secret field instead of a minted keypair's field — the reuse
 * logic has nothing to do with WHY the field was originally sealed.
 *
 * ## Idempotent
 * Calling this again for the same (purpose, granteeDid) with an already-
 * active grant returns that grant's id rather than minting a duplicate row
 * — `uniq_vault_delegation_active` would refuse a genuine duplicate anyway
 * (same (subject, grantedTo, field, keyId) tuple), but checking first
 * avoids a churned grantId (and a pointless re-sign) on every redundant
 * provisioning run.
 *
 * ## Rotation (#2446)
 * Rotation supersedes the self-grant AND every external grantee this module
 * has created, and re-grants each from the fresh seal
 * ({@link reissueInternalSecretGrants}, called by `internal-secret-rotate.ts`)
 * — no change needed to `getInternalSecret`'s or this module's own
 * lookup-by-(field, grantedTo).
 */
import { and, desc, eq } from 'drizzle-orm';
import { crypto as authCrypto } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants, type VaultDelegationGrant } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getNodeSigningIdentity, isVaultTier1 } from './sealing';
import { canonicalizeGrantPayload, supersedeActiveGrant, type DbExecutor } from './index';
import { getInternalSecret, internalSecretField } from './internal-secret';
import { emitGrantEvents } from './grant';

const log = createLogger('kernel');

export type GrantInternalSecretResult =
  | { status: 'ok'; grantId: string }
  | { status: 'no_reusable_grant' }
  | { status: 'tier1_unsupported' };

/**
 * Grant an already-self-provisioned internal secret (see
 * {@link getInternalSecret}) to an EXTERNAL consumer DID, without
 * re-sealing. Generates the secret first (self-granting it to the node's
 * own DID, exactly like any other `getInternalSecret` caller) if this is
 * the very first grant ever issued for `purpose`.
 *
 * Tier 1 (external owner agent) is NOT supported — same reasoning as
 * `grantExistingMintedKey`: the node does not hold `ownerXPriv` in that
 * mode, so it cannot produce a valid `ownerSignature` for a new grant row.
 */
export async function grantInternalSecretTo(
  purpose: string,
  granteeDid: string,
  grantedBy: string,
): Promise<GrantInternalSecretResult> {
  if (isVaultTier1()) {
    return { status: 'tier1_unsupported' };
  }

  // Ensures the secret exists (self-provisioning it if this is the very
  // first call for `purpose`) before anything tries to reuse its grant
  // material.
  await getInternalSecret(purpose);

  const field = internalSecretField(purpose);
  const ownerDid = getNodeSigningIdentity().senderDid;

  const alreadyGranted = await db
    .select({ id: vaultDelegationGrants.id })
    .from(vaultDelegationGrants)
    .where(
      and(
        eq(vaultDelegationGrants.subject, ownerDid),
        eq(vaultDelegationGrants.field, field),
        eq(vaultDelegationGrants.grantedTo, granteeDid),
        eq(vaultDelegationGrants.status, 'active'),
      ),
    )
    .limit(1);
  if (alreadyGranted.length > 0) {
    // Already granted — a no-op re-run of the provisioning script. No new
    // event: nothing actually happened this call.
    return { status: 'ok', grantId: alreadyGranted[0]!.id };
  }

  // Any row for this (subject, field) with intact key material works as the
  // reuse source — revoke/supersede blanks wrappedKey/wrappedNonce, so an
  // erased row is naturally skipped by the non-empty check below. Filtering
  // on `subject` too (not just `field`) matters because the no-re-seal
  // argument above depends on the wrap being to THIS node's own X25519 key
  // — true for every row this module or `getInternalSecret` has ever
  // written (subject is always `ownerDid`), but the query should enforce
  // that invariant rather than assume no other row could ever share this
  // field name.
  const candidates = await db
    .select()
    .from(vaultDelegationGrants)
    .where(and(eq(vaultDelegationGrants.subject, ownerDid), eq(vaultDelegationGrants.field, field)))
    .orderBy(desc(vaultDelegationGrants.createdAt));
  const source = candidates.find((row) => row.wrappedKey.length > 0 && row.wrappedNonce.length > 0);
  if (!source) {
    return { status: 'no_reusable_grant' };
  }

  const grantId = await issueGrantFromSource({
    field, subject: ownerDid, granteeDid, source,
    terms: { purpose, expiresAt: null, oneTime: false },
  });
  announceIssuedGrant({ purpose, field, subject: ownerDid, granteeDid, grantedBy, grantId });
  return { status: 'ok', grantId };
}

/**
 * Insert a new active grant of `field` to `granteeDid`, reusing `source`'s
 * key material (no re-seal — see this module's docblock). Shared by
 * first-time grants and rotation re-issue (#2446). Writes only: the log line
 * and bus event are {@link announceIssuedGrant}, which a transactional caller
 * (rotation, #2451) must run AFTER commit so a rolled-back grant is never
 * announced.
 */
async function issueGrantFromSource(params: {
  field: string;
  /** The grant's `subject` — the node for an internal secret, the principal DID for a connector/Warp grant (#2450). */
  subject: string;
  granteeDid: string;
  source: VaultDelegationGrant;
  terms: GrantTerms;
  executor?: DbExecutor;
}): Promise<string> {
  const { field, subject, granteeDid, source, terms, executor = db } = params;
  const { purpose, expiresAt, oneTime } = terms;
  const identity = getNodeSigningIdentity();
  const grantRaw = {
    subject,
    grantedTo: granteeDid,
    field,
    ownerXPub: source.ownerXPub,
    wrappedKey: source.wrappedKey,
    wrappedNonce: source.wrappedNonce,
    keyId: source.keyId,
    // Signed: the carried-forward expiry is part of the grant payload.
    expiresAt,
  };
  const ownerSignature = authCrypto.signSync(canonicalizeGrantPayload(grantRaw), identity.privateKeyHex);

  const grantId = generateId('vdg');
  await executor.insert(vaultDelegationGrants).values({
    id: grantId,
    ...grantRaw,
    ownerSignature,
    status: 'active',
    recipientXPub: source.recipientXPub,
    ownerEdPub: source.ownerEdPub ?? identity.senderPubkey,
    purpose,
    oneTime,
  });

  return grantId;
}

interface IssuedGrantAnnouncement {
  purpose: string | null;
  field: string;
  /** The grant's `subject` — the node for an internal secret, the principal DID for a connector/Warp grant (#2450). */
  subject: string;
  granteeDid: string;
  grantedBy: string;
  grantId: string;
}

/** Log + audit event for a grant {@link issueGrantFromSource} wrote. */
function announceIssuedGrant(params: IssuedGrantAnnouncement): void {
  const { purpose, field, subject, granteeDid, grantedBy, grantId } = params;
  log.info(
    { purpose, field, grantId, granteeDid, grantedBy },
    'Vault: issued a delegation grant to an external consumer (first grant or rotation re-issue)',
  );

  // Same audit posture as #2247's grantExistingMintedKey: a bus event only,
  // no signed attestation — `vault.grant.fulfilled` is not a registered
  // AttestationType (see packages/auth/src/types/attestation.ts).
  emitGrantEvents({ grantId, did: subject, field, grantedTo: granteeDid, grantedBy });
}

/** The unsigned + signed terms a grant is issued under — carried forward verbatim on re-issue. */
interface GrantTerms {
  purpose: string | null;
  expiresAt: Date | null;
  oneTime: boolean;
}

/**
 * A prior grant that can still be exercised: not expired, and not a
 * one-time grant already consumed. Re-issuing anything else would hand the
 * grantee access it no longer has — rotation must never widen (#2446).
 */
function isStillExercisable(grant: VaultDelegationGrant, now: Date): boolean {
  if (grant.expiresAt instanceof Date && grant.expiresAt.getTime() <= now.getTime()) return false;
  return !(grant.oneTime && grant.consumedAt);
}

/** `announce` fires the log + bus events for the re-issued grants — call it only once the writes have committed (#2451). */
interface ReissueResult {
  reissued: string[];
  dropped: string[];
  announce: () => void;
}

/**
 * Re-issue a rotated field to every external consumer that held it before
 * the rotation (#2446 for `internal-secret:*`, generalized to every
 * delegation-grant field by #2450). Rotation re-seals the field under a NEW
 * field key; an external grant still carrying the OLD wrapped key would
 * keep looking active while every fetch failed to decrypt. Each prior
 * grant is superseded (key material erased) and replaced by one that
 * reuses the node's fresh self-grant — with that prior grant's OWN terms
 * (subject, purpose, expiry, one-time) carried forward, so a consumer
 * that discovers its grant by purpose (corpus, #2245) or by `(field,
 * grantedTo)` (connector / Warp plugin) finds the new one on its next
 * fetch and nothing is ever broadened. Grants that are expired or
 * consumed one-time are superseded but NOT re-issued. The set of grantees
 * never grows: adding a consumer stays an operator grant. One
 * `vault.grant.fulfilled` bus event is published per re-issued grant.
 *
 * Operator-initiated rotation only — a boot never calls this (#2245
 * countersign ruling). `sourceGrantId` is the node's new self-grant,
 * returned by the re-seal.
 *
 * Atomic with the caller (#2451): pass the rotation's transaction as
 * `executor` and every supersede + insert here commits or rolls back together
 * with the self re-seal, so a failure partway never leaves a grantee
 * superseded-but-not-re-issued. The bus events are NOT sent here — the caller
 * invokes the returned `announce` once the transaction has committed.
 */
export async function reissueFieldGrants(params: {
  field: string;
  sourceGrantId: string;
  previousGrants: readonly VaultDelegationGrant[];
  grantedBy: string;
  executor?: DbExecutor;
}): Promise<ReissueResult> {
  const { field, sourceGrantId, previousGrants, grantedBy, executor = db } = params;
  const ownerDid = getNodeSigningIdentity().senderDid;
  // The node's own self-grant is replaced by the re-seal itself.
  const prior = previousGrants.filter((g) => g.field === field && g.grantedTo !== ownerDid);
  if (prior.length === 0) return { reissued: [], dropped: [], announce: () => undefined };

  const [source] = await executor
    .select()
    .from(vaultDelegationGrants)
    .where(and(eq(vaultDelegationGrants.id, sourceGrantId), eq(vaultDelegationGrants.status, 'active')))
    .limit(1);
  if (source?.field !== field || source.subject !== ownerDid) {
    throw new Error(`reissueFieldGrants: '${sourceGrantId}' is not the active self-grant for '${field}'`);
  }

  const now = new Date();
  // One grant per (subject, grantedTo): newest first, so the newest grant's terms win.
  // Distinct tuples touch distinct rows, so the replacements are independent.
  const outcomes = await Promise.all(
    uniqueByGrantee(prior).map((grant) => reissueOneGrant({ grant, field, source, grantedBy, now, executor })),
  );

  const reissued: string[] = [];
  const dropped: string[] = [];
  const issued: IssuedGrantAnnouncement[] = [];
  for (const outcome of outcomes) {
    if (outcome.issued === null) {
      dropped.push(outcome.grantedTo);
    } else {
      reissued.push(outcome.issued.grantId);
      issued.push(outcome.issued);
    }
  }
  return {
    reissued,
    dropped,
    announce: () => {
      for (const announcement of issued) announceIssuedGrant(announcement);
    },
  };
}

/** First (newest) grant per `(subject, grantedTo)` pair, preserving order. */
function uniqueByGrantee(grants: readonly VaultDelegationGrant[]): VaultDelegationGrant[] {
  const seen = new Set<string>();
  return grants.filter((grant) => {
    const key = `${grant.subject}\u0000${grant.grantedTo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Supersede one prior grant (erasing its old key material), then issue its
 * replacement from `source` with the same terms — unless it can no longer be
 * exercised, in which case it is superseded and NOT replaced.
 */
async function reissueOneGrant(params: {
  grant: VaultDelegationGrant;
  field: string;
  source: VaultDelegationGrant;
  grantedBy: string;
  now: Date;
  executor: DbExecutor;
}): Promise<{ grantedTo: string; issued: IssuedGrantAnnouncement | null }> {
  const { grant, field, source, grantedBy, now, executor } = params;
  await supersedeActiveGrant({ subject: grant.subject, grantedTo: grant.grantedTo, field }, executor);
  if (!isStillExercisable(grant, now)) {
    return { grantedTo: grant.grantedTo, issued: null };
  }
  const granteeDid = grant.grantedTo;
  const grantId = await issueGrantFromSource({
    field, subject: grant.subject, granteeDid, source, executor,
    terms: { purpose: grant.purpose, expiresAt: grant.expiresAt, oneTime: grant.oneTime },
  });
  return {
    grantedTo: granteeDid,
    issued: { purpose: grant.purpose, field, subject: grant.subject, granteeDid, grantedBy, grantId },
  };
}

/** {@link reissueFieldGrants} for an `internal-secret:<purpose>` field (#2446). */
export async function reissueInternalSecretGrants(params: {
  purpose: string;
  sourceGrantId: string;
  previousGrants: readonly VaultDelegationGrant[];
  grantedBy: string;
  executor?: DbExecutor;
}): Promise<ReissueResult> {
  const { purpose, ...rest } = params;
  return reissueFieldGrants({ field: internalSecretField(purpose), ...rest });
}
