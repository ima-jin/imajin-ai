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
 * ## Rotation (explicitly out of scope for #2245, same seam as internal-secret.ts)
 * A future rotate card supersedes every active grant for the field (the
 * self-grant AND every external grantee this module has ever created) and
 * re-grants each from a fresh seal — no change needed to `getInternalSecret`'s
 * or this module's own lookup-by-(field, grantedTo).
 */
import { and, desc, eq } from 'drizzle-orm';
import { crypto as authCrypto } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getNodeSigningIdentity, isVaultTier1 } from './sealing';
import { canonicalizeGrantPayload } from './index';
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

  const identity = getNodeSigningIdentity();
  const grantRaw = {
    subject: ownerDid,
    grantedTo: granteeDid,
    field,
    ownerXPub: source.ownerXPub,
    wrappedKey: source.wrappedKey,
    wrappedNonce: source.wrappedNonce,
    keyId: source.keyId,
    expiresAt: null,
  };
  const ownerSignature = authCrypto.signSync(canonicalizeGrantPayload(grantRaw), identity.privateKeyHex);

  const grantId = generateId('vdg');
  await db.insert(vaultDelegationGrants).values({
    id: grantId,
    ...grantRaw,
    ownerSignature,
    status: 'active',
    recipientXPub: source.recipientXPub,
    ownerEdPub: source.ownerEdPub ?? identity.senderPubkey,
    purpose,
    oneTime: false,
  });

  log.info(
    { purpose, field, grantId, granteeDid, grantedBy },
    'Vault: granted a shared internal secret to an additional external consumer',
  );

  // Same audit posture as #2247's grantExistingMintedKey: a bus event only,
  // no signed attestation — `vault.grant.fulfilled` is not a registered
  // AttestationType (see packages/auth/src/types/attestation.ts).
  emitGrantEvents({ grantId, did: ownerDid, field, grantedTo: granteeDid, grantedBy });

  return { status: 'ok', grantId };
}
