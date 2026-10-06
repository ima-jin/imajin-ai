/**
 * POST /api/apps/signing-key/fetch — every boot AFTER the first-boot claim
 * exchange re-fetches the app's own vault signing key here (#2411,
 * restart-authentication ruling), instead of spending a fresh
 * operator-approved claim code.
 *
 * Not `requireAuth`-gated, same reasoning as `POST /api/apps/claim`: the
 * app authenticates itself by signing this request with the bootstrap
 * private key it minted at first boot and persisted only in its own local
 * keystore file — never sent to the kernel, never written anywhere here.
 * The kernel verifies the signature against the bootstrap PUBLIC key bound
 * to the app's claim at first boot (`bootstrap-fetch-auth.ts`).
 *
 * Body: `{ appDid: string, timestamp: number, nonce: string, signature: string }`.
 * `signature` is `sign(canonicalize({ appDid, nonce, timestamp }), bootstrapPrivateKey)`
 * — see `@ima-jin/auth-client`'s `bootstrap-key.ts` for the exact signer.
 * `timestamp` (epoch ms) and `nonce` (any sufficiently random string) exist
 * purely to make each signed request unique and time-bounded — replaying a
 * captured request is refused (410/401, see below).
 *
 * Response (200): `{ appDid, privateKey, publicKey }` — memory-only, never
 * persisted by this route or the SDK helper.
 *
 * Every outcome is audited via `apps.signing-key.fetched` with
 * `via: 'bootstrap-key'`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { verifyBootstrapFetchAuth, type BootstrapFetchAuthOutcome } from '@/src/lib/apps/bootstrap-fetch-auth';
import {
  resolveSigningKeyForGrant,
  statusForSigningKeyFetchOutcome,
  errorForSigningKeyFetchOutcome,
  emitSigningKeyFetchedEvent,
} from '@/src/lib/apps/signing-key-fetch';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';

const log = createLogger('kernel:apps-signing-key-fetch-route');

export const dynamic = 'force-dynamic';

const MAX_NONCE_LENGTH = 200;

interface FetchRequestBody {
  appDid?: unknown;
  timestamp?: unknown;
  nonce?: unknown;
  signature?: unknown;
}

interface ValidatedFetchBody {
  appDid: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

function validateFetchBody(body: FetchRequestBody): { ok: true; value: ValidatedFetchBody } | { ok: false; error: string } {
  if (typeof body.appDid !== 'string' || body.appDid.length === 0) {
    return { ok: false, error: 'appDid is required' };
  }
  if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) {
    return { ok: false, error: 'timestamp must be a number (epoch ms)' };
  }
  if (typeof body.nonce !== 'string' || body.nonce.length === 0 || body.nonce.length > MAX_NONCE_LENGTH) {
    return { ok: false, error: `nonce must be a non-empty string of at most ${MAX_NONCE_LENGTH} chars` };
  }
  if (typeof body.signature !== 'string' || body.signature.length === 0) {
    return { ok: false, error: 'signature is required' };
  }
  return { ok: true, value: { appDid: body.appDid, timestamp: body.timestamp, nonce: body.nonce, signature: body.signature } };
}

/** HTTP status for every non-'ok' {@link BootstrapFetchAuthOutcome}. */
function statusForAuthOutcome(status: Exclude<BootstrapFetchAuthOutcome['status'], 'ok'>): number {
  switch (status) {
    case 'no_binding':
      return 404;
    case 'invalid_signature':
    case 'stale_timestamp':
    case 'replayed_nonce':
    default:
      return 401;
  }
}

/** Value-free error message for every non-'ok' {@link BootstrapFetchAuthOutcome}. */
function errorForAuthOutcome(status: Exclude<BootstrapFetchAuthOutcome['status'], 'ok'>): string {
  switch (status) {
    case 'no_binding':
      return 'No bootstrap key is bound for this app — complete the first-boot claim exchange first';
    case 'invalid_signature':
      return 'Invalid bootstrap key signature';
    case 'stale_timestamp':
      return 'Request timestamp is too far from the kernel clock';
    case 'replayed_nonce':
      return 'This request nonce has already been used';
    default:
      return 'Unable to authenticate this request';
  }
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  let body: FetchRequestBody;
  try {
    body = (await request.json()) as FetchRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const validation = validateFetchBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }
  const { appDid, timestamp, nonce, signature } = validation.value;

  const nodeDid = getNodeSigningIdentity().senderDid;

  try {
    const authOutcome = await verifyBootstrapFetchAuth({ appDid, timestamp, nonce, signature });
    if (authOutcome.status !== 'ok') {
      return NextResponse.json(
        { error: errorForAuthOutcome(authOutcome.status) },
        { status: statusForAuthOutcome(authOutcome.status), headers: cors },
      );
    }
    const { slug, grantId } = authOutcome.binding;

    const keyOutcome = await resolveSigningKeyForGrant({ grantId, appDid });
    emitSigningKeyFetchedEvent({ nodeDid, slug, appDid, grantId, outcome: keyOutcome.status, via: 'bootstrap-key' });
    if (keyOutcome.status !== 'ok') {
      if (keyOutcome.status === 'wrong_purpose') {
        log.error({ slug, appDid, grantId }, 'Bootstrap-key fetch resolved a grant with an unexpected purpose — refusing');
      }
      return NextResponse.json(
        { error: errorForSigningKeyFetchOutcome(keyOutcome.status) },
        { status: statusForSigningKeyFetchOutcome(keyOutcome.status), headers: cors },
      );
    }

    return NextResponse.json(
      { appDid: keyOutcome.appDid, privateKey: keyOutcome.privateKey, publicKey: keyOutcome.publicKey },
      { headers: cors },
    );
  } catch (error) {
    log.error({ err: String(error), appDid }, 'Bootstrap-key signing-key fetch error');
    return NextResponse.json({ error: 'Failed to fetch signing key' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
