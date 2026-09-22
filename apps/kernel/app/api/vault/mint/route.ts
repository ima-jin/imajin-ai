import { NextResponse } from 'next/server';
import { emitAttestation } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { mintKeypair } from '@/src/lib/vault';
import { requireMintAuthority } from '@/src/lib/vault/mint-authority';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

interface MintBody {
  /** Free-form label naming what the minted key will be used for. */
  purpose?: unknown;
  /**
   * The DID that should receive the one-time delegation grant for the
   * sealed private key — e.g. a service's own pre-existing bootstrap
   * identity. Distinct from the acting principal that calls this route.
   */
  requesterDid?: unknown;
  expiresAt?: unknown;
}

function validateMintBody(body: MintBody): string | null {
  if (typeof body.purpose !== 'string' || body.purpose.trim().length === 0 || body.purpose.length > 200) {
    return 'purpose must be a non-empty string of at most 200 characters';
  }
  if (typeof body.requesterDid !== 'string' || body.requesterDid.trim().length === 0) {
    return 'requesterDid is required';
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null && typeof body.expiresAt !== 'string') {
    return 'expiresAt must be an ISO 8601 date string or null';
  }
  return null;
}

/**
 * POST /api/vault/mint — generate an Ed25519 keypair INSIDE the kernel
 * vault (#2242). The private key never leaves the vault and is never
 * returned by this route — only `{ did, publicKey }`.
 *
 * Auth: `requireMintAuthority` — the caller's resolved acting DID
 * (requireAuth + actingFor) must be the vault's own node signing identity,
 * self or delegated. This is the "who requested" recorded on the signed
 * mint attestation, distinct from `requesterDid` in the body: the DID the
 * sealed private key is delivered to via a one-time, purpose-bound
 * delegation grant, fetchable through the EXISTING #2231 agent-fetch route
 * (`POST /api/vault/delegation/grants/{grantId}/fetch`) — no new fetch
 * surface is introduced here.
 */
export async function POST(request: Request) {
  const authority = await requireMintAuthority(request);
  if (!authority.ok) {
    return authority.response;
  }
  const { actingDid, composedBy } = authority.authority;

  let body: MintBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const validationError = validateMintBody(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const purpose = (body.purpose as string).trim();
  const requesterDid = (body.requesterDid as string).trim();
  const expiresAt = typeof body.expiresAt === 'string' ? new Date(body.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return NextResponse.json({ error: 'expiresAt must be a valid ISO 8601 date' }, { status: 400 });
  }

  try {
    const minted = await mintKeypair({ purpose, requesterDid, mintedBy: actingDid, expiresAt });

    emitAttestation({
      issuer_did: actingDid,
      subject_did: minted.did,
      type: 'vault.key.minted',
      context_id: minted.mintId,
      context_type: 'vault.mint',
      payload: {
        mintId: minted.mintId,
        publicKey: minted.publicKey,
        purpose,
        requesterDid,
        composedBy,
        grantId: minted.grantId,
      },
    }).catch((err: unknown) => log.error({ err: String(err), mintId: minted.mintId }, 'vault.key.minted attestation failed'));

    publish('vault.key.minted', {
      issuer: actingDid,
      subject: minted.did,
      scope: 'vault',
      payload: {
        mintId: minted.mintId,
        did: minted.did,
        publicKey: minted.publicKey,
        field: minted.field,
        purpose,
        requestedBy: requesterDid,
        mintedBy: actingDid,
        grantId: minted.grantId,
        context_id: minted.mintId,
        context_type: 'vault.mint',
      },
    }).catch((err: unknown) => log.error({ err: String(err), mintId: minted.mintId }, 'Bus publish error for vault.key.minted'));

    log.info({ mintId: minted.mintId, did: minted.did, mintedBy: actingDid }, 'Vault: mint requested');

    return NextResponse.json({ did: minted.did, publicKey: minted.publicKey }, { status: 201 });
  } catch (error) {
    log.error({ err: String(error), requesterDid, mintedBy: actingDid }, 'Vault mint error');
    return toVaultErrorResponse(error, 'Failed to mint vault key', 500);
  }
}
