import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAdmin, verifySync } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants, vaultGrantRequests } from '@/src/db';
import {
  canonicalizeGrantPayload,
  eraseInactiveGrantKeyMaterial,
  expectedGrantVerifier,
  getOwnerEnvelope,
  vaultService,
} from '@/src/lib/vault';
import {
  getExternalOwnerEdPublicKey,
  getNodeSigningIdentity,
  getNodeXPublicKey,
} from '@/src/lib/vault/sealing';
import { generateId } from '@/src/lib/kernel/id';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

interface GrantBody {
  /**
   * Present for the initial seal-time handshake, absent for a renewal.
   * See the route doc for why a renewal needs no request row.
   */
  requestId?: string | null;
  subject: string;       // ownerDid
  grantedTo: string;     // nodeDid
  field: string;
  ownerXPub: string;     // owner's X25519 pubkey (must match request row / envelope)
  wrappedKey: string;    // fieldKey ECDH-wrapped ownerXPriv → nodeXPub
  wrappedNonce: string;
  keyId: string;
  ownerSignature: string; // Ed25519 sig over canonicalizeGrantPayload(...)
  expiresAt?: string | null;
}

/**
 * The two values a grant must not take from the request body: the Ed25519 key
 * its signature is checked against, and the X25519 pubkey the field key was
 * wrapped to. Each flow derives them from node-written state instead.
 */
interface GrantTrustContext {
  ownerEdPub: string;
  recipientXPub: string;
  /**
   * The only `grantedTo` this flow will accept, taken from node-written state.
   *
   * Before #1603 this was implicitly "this node's DID", asserted directly against
   * the body. Static-secret custody (#1439) legitimately grants to a connector app
   * DID instead, so the node's own DID is no longer the right constant — but the
   * body still cannot be trusted to name its own grantee, or an owner agent could
   * be induced to install a grant for a DID the node never asked about.
   */
  expectedGrantedTo: string;
}

/** Either the resolved trust anchors, or the rejection to return verbatim. */
type TrustResolution = { ok: true; context: GrantTrustContext } | { ok: false; response: NextResponse };

function reject(error: string, status: number): TrustResolution {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

/**
 * Seal-time handshake: the pending `vault_grant_requests` row is the record this
 * node wrote when it generated the field key, so it is what the incoming grant
 * is checked against.
 */
async function resolveHandshake(requestId: string, ownerXPub: string): Promise<TrustResolution> {
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
    return reject(`No pending grant request found for requestId '${requestId}'`, 404);
  }

  // Prevents key substitution: the owner key must be the one we queued for.
  if (grantRequest.ownerXPub !== ownerXPub) {
    return reject('ownerXPub does not match the pending grant request', 400);
  }

  return {
    ok: true,
    context: {
      ownerEdPub: getExternalOwnerEdPublicKey(),
      // Written by this node at seal time, so it is the trustworthy record of
      // which key the owner wrapped to.
      recipientXPub: grantRequest.nodeXPub,
      // The grantee this node asked for. NULL on rows predating #1603, which are
      // self-grant requests by construction — nothing else could have written one.
      expectedGrantedTo: grantRequest.grantedTo ?? getNodeSigningIdentity().senderDid,
    },
  };
}

/**
 * Renewal: there is no request row, so the entry and the owner envelope take its
 * place. Both are node-written state, and together they pin the field, the key
 * generation, and the owner identity.
 */
async function resolveRenewal(
  field: string,
  keyId: string,
  ownerXPub: string,
  grantedTo: string,
): Promise<TrustResolution> {
  const entry = await vaultService.peek(field);
  if (!entry || entry.deleted === true) {
    return reject(`No vault entry for field '${field}' — a renewal needs an entry to grant against`, 404);
  }

  if (entry.custodyScheme !== 'delegation-grant') {
    return reject(
      `Field '${field}' is not under delegation-grant custody — re-seal it instead of renewing`,
      400,
    );
  }

  // A grant only opens the generation it was minted for. Accepting a stale keyId
  // would install a grant that cannot decrypt the current ciphertext.
  if (entry.keyId !== keyId) {
    return reject(`keyId does not match the current entry for field '${field}'`, 400);
  }

  const envelope = await getOwnerEnvelope(field, keyId);
  if (!envelope) {
    return reject(
      `No owner envelope for field '${field}' — the owner has no recoverable copy of this field key`,
      404,
    );
  }

  if (envelope.ownerXPub !== ownerXPub) {
    return reject('ownerXPub does not match the owner envelope for this field', 400);
  }

  // A renewal has no request row, so the anchor for `grantedTo` is the grant
  // history this node already wrote for the field. Renewing to a grantee that
  // never held a grant here would be minting new authority under the name of a
  // renewal, so it is rejected.
  const nodeDid = getNodeSigningIdentity().senderDid;
  if (grantedTo !== nodeDid) {
    const known = await db
      .select({ id: vaultDelegationGrants.id })
      .from(vaultDelegationGrants)
      .where(
        and(
          eq(vaultDelegationGrants.field, field),
          eq(vaultDelegationGrants.grantedTo, grantedTo),
        ),
      )
      .limit(1);

    if (known.length === 0) {
      return reject(
        `grantedTo '${grantedTo}' has no grant history for field '${field}' — ` +
          'a renewal cannot introduce a new grantee',
        400,
      );
    }
  }

  return {
    ok: true,
    context: {
      ownerEdPub: expectedGrantVerifier(entry),
      // The owner wrapped the key to this node, so the ECDH counterparty is our
      // own X25519 pubkey — derived, never taken from the body.
      recipientXPub: getNodeXPublicKey(),
      expectedGrantedTo: grantedTo,
    },
  };
}

/**
 * POST /api/vault/delegation/grant — accept a pre-signed delegation grant from
 * the owner agent (imajin-cli vault serve).
 *
 * Admin-only. Serves two flows:
 *
 * ## Seal-time handshake (`requestId` present)
 * The node generated a field key it cannot keep, wrapped it to the owner, and
 * queued a `vault_grant_requests` row. The request row is how the field key
 * reaches an owner who does not have it, and `ownerXPub` must match that row.
 *
 * ## Renewal (`requestId` absent) — #1535
 * Re-issue a grant for an entry that already exists: after expiry, after
 * revocation, or to replace one about to lapse.
 *
 * No request row exists, and none is needed. The owner already holds the field
 * key via `vault_owner_envelopes` (#1521), so there is nothing to deliver. The
 * trust anchor is unchanged and was always the real one: an Ed25519 signature
 * over the canonical grant payload, verified against the key this node trusts
 * (the configured external owner in Tier 1, the node itself in Tier 0).
 *
 * Without this path an expiring grant is a permanent lockout — a grant could only
 * ever be created at seal time, and expiry now destroys the key material.
 *
 * Both flows then behave identically: supersede and crypto-erase any existing
 * active grant, insert the new one, and emit `vault.grant.fulfilled`. After
 * either, `loadAndUnseal` succeeds headlessly on the node.
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

  if (!subject || !grantedTo || !field || !ownerXPub ||
      !wrappedKey || !wrappedNonce || !keyId || !ownerSignature) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  try {
    // Resolve this node's identity up-front so it is available for the bus
    // publish at the end.
    const identity = getNodeSigningIdentity();

    const expiresAtDate = expiresAt ? new Date(expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAtDate?.getTime())) {
      return NextResponse.json({ error: 'expiresAt must be a valid ISO 8601 date' }, { status: 400 });
    }

    // 1. Resolve the trust anchors from node-written state, per flow.
    const resolution = requestId
      ? await resolveHandshake(requestId, ownerXPub)
      : await resolveRenewal(field, keyId, ownerXPub, grantedTo);

    if (!resolution.ok) {
      return resolution.response;
    }

    const { ownerEdPub, recipientXPub, expectedGrantedTo } = resolution.context;

    // 2. Defense-in-depth: the canonical payload is signed by the owner and
    //    includes grantedTo, but an owner agent could sign a grant for the wrong
    //    recipient. Before #1603 this asserted `grantedTo === this node`, which is
    //    no longer correct — a static-secret grant names a connector app DID. The
    //    check is now against the grantee this NODE recorded, so it still refuses
    //    anything the node did not ask for while allowing the delegated shape.
    if (grantedTo !== expectedGrantedTo) {
      log.warn(
        { field, requestId: requestId ?? null, grantedTo, expectedGrantedTo },
        'Vault delegation/grant: grantedTo does not match node-recorded grantee',
      );
      return NextResponse.json(
        { error: `grantedTo '${grantedTo}' does not match the grantee this node recorded` },
        { status: 400 },
      );
    }

    // 3. Verify the owner signature over the canonical payload. This is the trust
    //    anchor for both flows.
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

    // 4. Supersede any existing active grant for this (subject, grantedTo, field)
    //    tuple, erasing its key material so the replaced grant stops being a usable
    //    copy of the field key.
    const superseded = await db
      .update(vaultDelegationGrants)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(vaultDelegationGrants.subject, subject),
          eq(vaultDelegationGrants.grantedTo, grantedTo),
          eq(vaultDelegationGrants.field, field),
          eq(vaultDelegationGrants.status, 'active'),
        ),
      )
      .returning({
        id: vaultDelegationGrants.id,
        field: vaultDelegationGrants.field,
        keyId: vaultDelegationGrants.keyId,
      });

    await eraseInactiveGrantKeyMaterial(superseded);

    // 5. Insert the new active delegation grant.
    const grantId = generateId('vdg');
    await db.insert(vaultDelegationGrants).values({
      id: grantId,
      subject,
      grantedTo,
      field,
      ownerXPub,
      wrappedKey,
      wrappedNonce,
      keyId,
      ownerSignature,
      status: 'active',
      expiresAt: expiresAtDate,
      // Self-describing: the ECDH counterparty needed to open this grant.
      recipientXPub,
      // Pin the verifier this signature was checked against, so the grant stays
      // verifiable if the Tier 1 env later changes.
      ownerEdPub,
    });

    // 6. Mark the grant request as fulfilled. A renewal has no request row to
    //    close out.
    if (requestId) {
      await db
        .update(vaultGrantRequests)
        .set({ status: 'fulfilled', fulfilledAt: new Date(), grantId })
        .where(eq(vaultGrantRequests.requestId, requestId));
    }

    // 7. Non-fatal bus notification — emit a dedicated grant.fulfilled event so
    //    consumers can track grant lifecycle without misinterpreting the generic
    //    vault.secret.updated event (which uses keyId as a cid proxy).
    publish('vault.grant.fulfilled', {
      issuer: identity.senderDid,
      subject,
      scope: 'vault',
      payload: {
        grantId,
        requestId: requestId ?? null,
        field,
        subject,
        grantedTo,
        context_id: field,
        context_type: 'vault',
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Bus publish error for vault.grant.fulfilled');
    });

    log.info(
      { field, requestId: requestId ?? null, grantId, renewal: !requestId },
      'Vault: delegation grant issued by owner agent',
    );

    return NextResponse.json({ ok: true, grantId, field, renewal: !requestId });
  } catch (error) {
    log.error({ err: String(error), requestId: requestId ?? null }, 'Vault delegation/grant error');
    return toVaultErrorResponse(error, 'Failed to process delegation grant', 500);
  }
}
