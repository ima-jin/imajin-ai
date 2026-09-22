import { NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { revokeMintedKey, emitRevokedEvents } from '@/src/lib/vault';
import { requireMintAuthority } from '@/src/lib/vault/mint-authority';

const log = createLogger('kernel');

/**
 * POST /api/vault/mint/revoke — tombstone a previously minted key (#2242).
 *
 * Body: `{ did: string }` — the minted DID to revoke.
 *
 * Auth: `requireMintAuthority` — same gate as `POST /api/vault/mint`.
 *
 * Soft tombstone (v1): the `vault_minted_keys` row is marked 'revoked'
 * (surviving as the record that a key existed and was withdrawn) and the
 * delegation grant's wrapped key material is erased, so a second fetch of
 * the grant fails closed (`revokeStaticSecretGrant` — see
 * `apps/kernel/src/lib/vault/mint.ts`). The underlying vault field entry
 * itself is left in place; a harder-destroy tier is deferred (see the
 * #2242 PR description).
 */
export async function POST(request: Request) {
  const authority = await requireMintAuthority(request);
  if (!authority.ok) {
    return authority.response;
  }
  const { actingDid } = authority.authority;

  let body: { did?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { did } = body;
  if (typeof did !== 'string' || did.trim().length === 0) {
    return NextResponse.json({ error: 'did is required' }, { status: 400 });
  }
  const trimmedDid = did.trim();

  const outcome = await revokeMintedKey({ did: trimmedDid, revokedBy: actingDid });

  if (outcome.status === 'not_found') {
    return NextResponse.json({ error: `No minted key found for DID '${trimmedDid}'` }, { status: 404 });
  }
  if (outcome.status === 'already_revoked') {
    return NextResponse.json({ ok: true, alreadyRevoked: true, did: trimmedDid });
  }

  const { record } = outcome;

  emitRevokedEvents(record, actingDid);

  log.info({ mintId: record.id, did: trimmedDid, revokedBy: actingDid }, 'Vault: mint revoked');

  return NextResponse.json({ ok: true, did: trimmedDid, mintId: record.id });
}
