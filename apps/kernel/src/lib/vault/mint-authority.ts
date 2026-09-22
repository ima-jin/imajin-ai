/**
 * Shared authority gate for `POST /api/vault/mint` and
 * `POST /api/vault/mint/revoke` (#2242).
 *
 * Minting a new signing identity — and revoking one — is exactly the kind
 * of high-risk vault mutation the codebase already gates to the node's own
 * identity (`POST /api/vault/delegation/grant`, `.../delegation/revoke`,
 * both `requireAdmin`-gated). Those routes use the cookie-session-only
 * `requireAdmin()`, which has no concept of delegation. Mint additionally
 * needs to be callable by a headless bootstrap script authenticating with a
 * bearer credential — and by an agent the node has explicitly delegated to
 * via `X-Acting-For` — so this gate is built on `requireAuth` +
 * `resolveActingDid` (`acting-did.ts`, #1673) instead: the resolved acting
 * DID must equal the vault's own signing identity (the same identity that
 * ends up as `senderDid` on the sealed entry), self OR delegated.
 *
 * `composedBy` (`resolveComposedBy`) is threaded through separately so the
 * mint/revoke attestation can distinguish "attributed to the node identity"
 * from "actually typed by this delegate agent", mirroring #1673.
 */
import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse, resolveActingDid, resolveComposedBy } from '@imajin/auth';
import { getNodeSigningIdentity } from './sealing';

export interface MintAuthority {
  /** The resolved acting DID — always the vault's own node identity. */
  actingDid: string;
  /** The delegate agent DID that composed the call, when acting-for delegation was used. */
  composedBy: string | null;
}

export type MintAuthorityResult =
  | { ok: true; authority: MintAuthority }
  | { ok: false; response: NextResponse };

export async function requireMintAuthority(request: Request): Promise<MintAuthorityResult> {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return { ok: false, response: authErrorResponse(authResult) };
  }

  const actingDid = resolveActingDid(authResult.identity);
  const nodeDid = getNodeSigningIdentity().senderDid;

  if (actingDid !== nodeDid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Only the vault node identity (or its delegate) may mint or revoke vault keys' },
        { status: 403 },
      ),
    };
  }

  return { ok: true, authority: { actingDid, composedBy: resolveComposedBy(authResult.identity) } };
}
