import { NextResponse } from 'next/server';
import { and, eq, gt, isNull, isNotNull, lt, or } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, vaultGrantRequests } from '@/src/db';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';

const log = createLogger('kernel');

/**
 * GET /api/vault/grants/pending — return pending Tier 1 grant requests.
 *
 * Admin-only. Polled by `imajin-cli vault serve` to discover outstanding
 * vault.grant.requested events that require the external owner agent to
 * create and sign a delegation grant.
 *
 * Each row includes the per-field AES key ECDH-wrapped from nodeXPriv →
 * ownerXPub so only the owner can recover it via:
 *   unwrapFieldKey({ encryptedKey: wrappedFieldKey, nonce: wrappedFieldKeyNonce },
 *                  nodeXPub, ownerXPriv)
 *
 * After recovering the field key, the owner agent wraps it to nodeXPub using
 * ownerXPriv (the canonical delegation grant), signs, and POSTs to
 * POST /api/vault/delegation/grant which marks the request fulfilled.
 *
 * `subject` / `grantedTo` (#1603) tell the owner agent which custody pair to sign.
 * A node self-grant has both set to the node's DID; a static-secret connector
 * credential (#1439) has `subject` = the principal and `grantedTo` = the connector
 * app DID. Rows predating #1603 have neither, so both fall back to the node DID —
 * they are self-grants by construction.
 *
 * `grantedTo` does NOT change where the key is wrapped: it stays `nodeXPub`,
 * because the node unseals on the grantee's behalf.
 */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();

    // Sweep: atomically mark any pending requests whose expiresAt has passed as
    // 'expired'. This prevents the queue growing indefinitely with stale rows.
    // The owner agent polls this endpoint, so the sweep runs on every poll cycle.
    await db
      .update(vaultGrantRequests)
      .set({ status: 'expired' })
      .where(
        and(
          eq(vaultGrantRequests.status, 'pending'),
          isNotNull(vaultGrantRequests.expiresAt),
          lt(vaultGrantRequests.expiresAt, now),
        ),
      );

    const requests = await db
      .select({
        requestId: vaultGrantRequests.requestId,
        field: vaultGrantRequests.field,
        keyId: vaultGrantRequests.keyId,
        nodeXPub: vaultGrantRequests.nodeXPub,
        ownerXPub: vaultGrantRequests.ownerXPub,
        wrappedFieldKey: vaultGrantRequests.wrappedFieldKey,
        wrappedFieldKeyNonce: vaultGrantRequests.wrappedFieldKeyNonce,
        createdAt: vaultGrantRequests.createdAt,
        expiresAt: vaultGrantRequests.expiresAt,
        subject: vaultGrantRequests.subject,
        grantedTo: vaultGrantRequests.grantedTo,
      })
      .from(vaultGrantRequests)
      .where(
        and(
          eq(vaultGrantRequests.status, 'pending'),
          or(
            isNull(vaultGrantRequests.expiresAt),
            gt(vaultGrantRequests.expiresAt, now),
          ),
        ),
      )
      .orderBy(vaultGrantRequests.createdAt);

    // Resolved once, not per row: a pre-#1603 row carries no custody pair and is a
    // self-grant, so the node's own DID is the correct reading of NULL.
    const nodeDid = getNodeSigningIdentity().senderDid;

    return NextResponse.json({
      requests: requests.map((r) => ({
        requestId: r.requestId,
        field: r.field,
        keyId: r.keyId,
        nodeXPub: r.nodeXPub,
        ownerXPub: r.ownerXPub,
        wrappedFieldKey: r.wrappedFieldKey,
        wrappedFieldKeyNonce: r.wrappedFieldKeyNonce,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null,
        subject: r.subject ?? nodeDid,
        grantedTo: r.grantedTo ?? nodeDid,
      })),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Vault grants/pending error');
    return toVaultErrorResponse(error, 'Failed to fetch pending grant requests', 500);
  }
}
