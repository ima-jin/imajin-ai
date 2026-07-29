import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAdmin, verifySync } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants, vaultGrantRequests } from '@/src/db';
import { canonicalizeGrantPayload } from '@/src/lib/vault';
import { getNodeSigningIdentity, getExternalOwnerEdPublicKey } from '@/src/lib/vault/sealing';
import { generateId } from '@/src/lib/kernel/id';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

interface GrantBody {
  requestId: string;
  subject: string;       // ownerDid
  grantedTo: string;     // nodeDid
  field: string;
  ownerXPub: string;     // owner's X25519 pubkey (must match request row)
  wrappedKey: string;    // fieldKey ECDH-wrapped ownerXPriv → nodeXPub
  wrappedNonce: string;
  keyId: string;
  ownerSignature: string; // Ed25519 sig over canonicalizeGrantPayload(...)
  expiresAt?: string | null;
}

/**
 * POST /api/vault/delegation/grant — accept a pre-signed delegation grant from
 * the external owner agent (imajin-cli vault serve).
 *
 * Admin-only. Verifies:
 *   1. A pending vault_grant_requests row exists for the given requestId.
 *   2. The ownerSignature is a valid Ed25519 signature over the canonical
 *      grant payload, verified against VAULT_OWNER_ED_PUB (configured on kernel).
 *   3. ownerXPub in the body matches the request row (prevents key substitution).
 *
 * On success:
 *   - Inserts an active row into vault_delegation_grants.
 *   - Marks the vault_grant_requests row as fulfilled.
 *   - Supersedes any existing active grant for (subject, grantedTo, field).
 *
 * After this, loadAndUnseal on the cloud node will succeed headlessly.
 */
export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: GrantBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    requestId, subject, grantedTo, field,
    ownerXPub, wrappedKey, wrappedNonce, keyId,
    ownerSignature, expiresAt,
  } = body;

  if (!requestId || !subject || !grantedTo || !field || !ownerXPub ||
      !wrappedKey || !wrappedNonce || !keyId || !ownerSignature) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  try {
    // Resolve this node's identity up-front so it is available for both the
    // grantedTo assertion and the bus publish at the end.
    const identity = getNodeSigningIdentity();

    // Defense-in-depth: the canonical grant payload is signed by the owner and
    // includes grantedTo, but an owner agent could accidentally sign a grant
    // meant for a different node. Reject early if grantedTo doesn't match ours.
    if (grantedTo !== identity.senderDid) {
      return NextResponse.json(
        { error: `grantedTo '${grantedTo}' does not match this node's DID` },
        { status: 400 },
      );
    }

    // 1. Look up the pending grant request.
    const rows = await db
      .select()
      .from(vaultGrantRequests)
      .where(
        and(
          eq(vaultGrantRequests.requestId, requestId),
          eq(vaultGrantRequests.status, 'pending'),
        ),
      )
      .limit(1);

    const grantRequest = rows[0];
    if (!grantRequest) {
      return NextResponse.json(
        { error: `No pending grant request found for requestId '${requestId}'` },
        { status: 404 },
      );
    }

    // 2. Verify ownerXPub matches the stored request (prevents key substitution).
    if (grantRequest.ownerXPub !== ownerXPub) {
      return NextResponse.json(
        { error: 'ownerXPub does not match the pending grant request' },
        { status: 400 },
      );
    }

    // 3. Verify ownerSignature against VAULT_OWNER_ED_PUB.
    const ownerEdPub = getExternalOwnerEdPublicKey();

    const expiresAtDate = expiresAt ? new Date(expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAtDate?.getTime())) {
      return NextResponse.json({ error: 'expiresAt must be a valid ISO 8601 date' }, { status: 400 });
    }

    const canonical = canonicalizeGrantPayload({
      subject,
      grantedTo,
      field,
      ownerXPub,
      wrappedKey,
      wrappedNonce,
      keyId,
      expiresAt: expiresAtDate,
    });

    const sigValid = verifySync(ownerSignature, canonical, ownerEdPub);
    if (!sigValid) {
      log.warn({ field, requestId }, 'Vault delegation/grant: owner signature invalid');
      return NextResponse.json(
        { error: 'Owner signature verification failed' },
        { status: 403 },
      );
    }

    // 4. Supersede any existing active grant for this (subject, grantedTo, field) tuple.
    await db
      .update(vaultDelegationGrants)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(vaultDelegationGrants.subject, subject),
          eq(vaultDelegationGrants.grantedTo, grantedTo),
          eq(vaultDelegationGrants.field, field),
          eq(vaultDelegationGrants.status, 'active'),
        ),
      );

    // 5. Insert the new active delegation grant.
    const grantId = generateId('vdg');
    await db.insert(vaultDelegationGrants).values({
      id: grantId,
      subject,
      grantedTo,
      field,
      ownerXPub,
      wrappedKey,
      wrappedNonce: wrappedNonce,
      keyId,
      ownerSignature,
      status: 'active',
      expiresAt: expiresAtDate,
    });

    // 6. Mark the grant request as fulfilled.
    await db
      .update(vaultGrantRequests)
      .set({ status: 'fulfilled', fulfilledAt: new Date(), grantId })
      .where(eq(vaultGrantRequests.requestId, requestId));

    // 7. Non-fatal bus notification — emit a dedicated grant.fulfilled event so
    //    consumers can track grant lifecycle without misinterpreting the generic
    //    vault.secret.updated event (which uses keyId as a cid proxy).
    publish('vault.grant.fulfilled', {
      issuer: identity.senderDid,
      subject,
      scope: 'vault',
      payload: {
        grantId,
        requestId,
        field,
        subject,
        grantedTo,
        context_id: field,
        context_type: 'vault',
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Bus publish error for vault.grant.fulfilled');
    });

    log.info({ field, requestId, grantId }, 'Vault Tier 1: delegation grant fulfilled by owner agent');

    return NextResponse.json({ ok: true, grantId, field });
  } catch (error) {
    log.error({ err: String(error), requestId }, 'Vault delegation/grant error');
    return toVaultErrorResponse(error, 'Failed to process delegation grant', 500);
  }
}
