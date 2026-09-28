/**
 * POST /api/apps/claim — a third-party app's first-boot exchange of its
 * one-time claim code for its own vault-minted signing key (#2411).
 *
 * Unlike every other vault-fetch surface in this codebase
 * (`POST /api/vault/delegation/grants/{grantId}/fetch`), this route is
 * deliberately NOT `requireAuth`-gated: the whole point is that the app has
 * no pre-existing identity to authenticate a normal DID challenge-response
 * with (see `apps/kernel/src/lib/apps/signing-key-claims.ts`'s docblock).
 * The claim code itself — single-use, short-TTL, shown exactly once on the
 * /jin operator-approval card — IS the authentication for this one call.
 *
 * Body: `{ claimCode: string, hostHint?: string }`. `hostHint` is a
 * caller-reported, best-effort label (e.g. hostname) recorded on the /jin
 * timeline only — never trusted for authorization.
 *
 * Response (200): `{ appDid, privateKey, publicKey }` — held in memory only
 * by the caller (never written to disk by this route, and the SDK helper
 * this route is meant to be called through,
 * `@ima-jin/auth-client`'s `loadAppSigningKey`, never persists it either).
 *
 * Every outcome — success or refusal — is audited via the
 * `apps.signing-key.claimed` / `apps.signing-key.fetched` bus events.
 * Neither ever carries the claim code or the private key.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { claimSigningKey, type ClaimSigningKeyOutcome, APP_SIGNING_KEY_PURPOSE } from '@/src/lib/apps/signing-key-claims';
import { fetchGrantSecret, type GrantFetchOutcome } from '@/src/lib/vault';
import { getMintedKeyByDid } from '@/src/lib/vault/key-cards';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';

const log = createLogger('kernel:apps-claim-route');

export const dynamic = 'force-dynamic';

const MAX_HOST_HINT_LENGTH = 200;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface ClaimRequestBody {
  claimCode?: unknown;
  hostHint?: unknown;
}

function statusForClaimOutcome(status: Exclude<ClaimSigningKeyOutcome['status'], 'ok'>): number {
  switch (status) {
    case 'not_found':
      return 404;
    case 'expired':
    case 'already_claimed':
      return 410;
    default:
      return 400;
  }
}

function errorForClaimOutcome(status: Exclude<ClaimSigningKeyOutcome['status'], 'ok'>): string {
  switch (status) {
    case 'not_found':
      return 'Unrecognized claim code';
    case 'expired':
      return 'This claim code has expired — ask the operator to re-approve provisioning for a fresh one';
    case 'already_claimed':
      return 'This claim code has already been redeemed';
    default:
      return 'Unable to redeem this claim code';
  }
}

function statusForGrantOutcome(status: Exclude<GrantFetchOutcome['status'], 'ok'>): number {
  switch (status) {
    case 'not_found':
    case 'not_grantee':
      return 404;
    case 'consumed':
      return 410;
    case 'inactive':
    case 'expired':
    default:
      return 403;
  }
}

function errorForGrantOutcome(status: Exclude<GrantFetchOutcome['status'], 'ok'>): string {
  switch (status) {
    case 'not_found':
    case 'not_grantee':
      return 'The app-signing-key grant behind this claim no longer exists';
    case 'consumed':
      return 'The app-signing-key grant behind this claim has already been fetched';
    case 'inactive':
      return 'The app-signing-key grant behind this claim is no longer active (revoked)';
    case 'expired':
      return 'The app-signing-key grant behind this claim has expired';
    default:
      return 'Unable to fetch the app-signing-key grant behind this claim';
  }
}

function emitClaimedEvent(nodeDid: string, slug: string, appDid: string, grantId: string, hostHint: string | null): void {
  publish('apps.signing-key.claimed', {
    issuer: nodeDid,
    subject: appDid,
    scope: 'apps',
    payload: { slug, appDid, grantId, hostHint, context_id: appDid, context_type: 'apps.signing-key' },
  }).catch((err: unknown) => log.error({ err: String(err), slug, appDid }, 'Bus publish error for apps.signing-key.claimed'));
}

function emitFetchedEvent(nodeDid: string, slug: string, appDid: string, grantId: string, outcome: GrantFetchOutcome['status']): void {
  publish('apps.signing-key.fetched', {
    issuer: nodeDid,
    subject: appDid,
    scope: 'apps',
    payload: { slug, appDid, grantId, outcome, context_id: appDid, context_type: 'apps.signing-key' },
  }).catch((err: unknown) => log.error({ err: String(err), slug, appDid }, 'Bus publish error for apps.signing-key.fetched'));
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  let body: ClaimRequestBody;
  try {
    body = (await request.json()) as ClaimRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  if (typeof body.claimCode !== 'string' || body.claimCode.length === 0) {
    return NextResponse.json({ error: 'claimCode is required' }, { status: 400, headers: cors });
  }
  if (body.hostHint !== undefined && (typeof body.hostHint !== 'string' || body.hostHint.length > MAX_HOST_HINT_LENGTH)) {
    return NextResponse.json({ error: `hostHint must be a string of at most ${MAX_HOST_HINT_LENGTH} chars` }, { status: 400, headers: cors });
  }
  const hostHint = typeof body.hostHint === 'string' ? body.hostHint : null;

  const nodeDid = getNodeSigningIdentity().senderDid;

  try {
    const claimOutcome = await claimSigningKey({ code: body.claimCode, hostHint });
    if (claimOutcome.status !== 'ok') {
      return NextResponse.json(
        { error: errorForClaimOutcome(claimOutcome.status) },
        { status: statusForClaimOutcome(claimOutcome.status), headers: cors },
      );
    }
    const { slug, appDid, grantId } = claimOutcome;
    emitClaimedEvent(nodeDid, slug, appDid, grantId, hostHint);

    const grantOutcome = await fetchGrantSecret({ grantId, granteeDid: appDid });
    emitFetchedEvent(nodeDid, slug, appDid, grantId, grantOutcome.status);
    if (grantOutcome.status !== 'ok') {
      return NextResponse.json(
        { error: errorForGrantOutcome(grantOutcome.status) },
        { status: statusForGrantOutcome(grantOutcome.status), headers: cors },
      );
    }

    // Defensive: a claim always names the grantId it was issued for
    // (`issueSigningKeyClaim`), but refuse to hand back a value fetched
    // through a grant that isn't actually purpose-bound to app signing keys
    // — e.g. a claim row somehow pointing at an unrelated grant.
    if (grantOutcome.grant.purpose !== APP_SIGNING_KEY_PURPOSE) {
      log.error({ slug, appDid, grantId, purpose: grantOutcome.grant.purpose }, 'App signing-key claim resolved a grant with an unexpected purpose — refusing');
      return NextResponse.json({ error: 'Unable to fetch the app-signing-key grant behind this claim' }, { status: 500, headers: cors });
    }

    const mintedKey = await getMintedKeyByDid(appDid);
    return NextResponse.json(
      { appDid, privateKey: grantOutcome.value, publicKey: mintedKey?.publicKey ?? null },
      { headers: cors },
    );
  } catch (error) {
    log.error({ err: String(error) }, 'App signing-key claim exchange error');
    return NextResponse.json({ error: 'Failed to redeem claim code' }, { status: 500, headers: cors });
  }
}
