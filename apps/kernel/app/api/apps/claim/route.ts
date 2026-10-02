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
 * This is a FIRST-BOOT-ONLY route. The app also submits an Ed25519
 * `bootstrapPublicKey` it minted and persisted in its own local keystore
 * file, which the kernel binds to the claim (`claimSigningKey`). Every
 * LATER boot re-authenticates via `POST /api/apps/signing-key/fetch`
 * instead — a signature from that same bootstrap key, no claim code spent.
 *
 * Body: `{ claimCode: string, bootstrapPublicKey: string, hostHint?: string,
 * expectedAppDid?: string }`.
 * `bootstrapPublicKey` is a hex-encoded Ed25519 public key (64 hex chars).
 * `hostHint` is a caller-reported, best-effort label (e.g. hostname)
 * recorded on the /jin timeline only — never trusted for authorization.
 * `expectedAppDid` (#2444) binds the code to the requesting app: when
 * present and it differs from the app the code was issued for, the route
 * answers 409 WITHOUT spending the code and without returning any key
 * material, so a wrong/foreign code stays redeemable by its rightful app.
 * Absent, the route behaves exactly as before.
 *
 * Response (200): `{ appDid, privateKey, publicKey, attestationId }` — the
 * key material is held in memory only by the caller (never written to disk
 * by this route, and the SDK helper this route is meant to be called
 * through, `@ima-jin/auth-client`'s `loadAppSigningKey`, never persists it
 * either — only the bootstrap keypair is persisted, in the local keystore).
 * `attestationId` (#2444) is the id of the `apps.signing-key.claimed`
 * attestation minted for this redemption, or `null` if attestation
 * forwarding was unavailable — the claim itself has still succeeded by then
 * (the code is already spent), so it never fails the exchange.
 *
 * Every outcome — success or refusal — is audited via the
 * `apps.signing-key.claimed` / `apps.signing-key.fetched` bus events.
 * Neither ever carries the claim code or any private key.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { claimSigningKey, type ClaimSigningKeyOutcome } from '@/src/lib/apps/signing-key-claims';
import {
  resolveSigningKeyForGrant,
  statusForSigningKeyFetchOutcome,
  errorForSigningKeyFetchOutcome,
  emitSigningKeyFetchedEvent,
} from '@/src/lib/apps/signing-key-fetch';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';

const log = createLogger('kernel:apps-claim-route');

export const dynamic = 'force-dynamic';

const MAX_HOST_HINT_LENGTH = 200;
const MAX_APP_DID_LENGTH = 256;

/** 32-byte Ed25519 public key, hex-encoded. */
const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface ClaimRequestBody {
  claimCode?: unknown;
  bootstrapPublicKey?: unknown;
  hostHint?: unknown;
  expectedAppDid?: unknown;
}

function statusForClaimOutcome(status: Exclude<ClaimSigningKeyOutcome['status'], 'ok'>): number {
  switch (status) {
    case 'not_found':
      return 404;
    case 'expired':
    case 'already_claimed':
      return 410;
    case 'app_mismatch':
      return 409;
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
    case 'app_mismatch':
      return 'This claim code was issued for a different app — it has not been redeemed';
    default:
      return 'Unable to redeem this claim code';
  }
}

/**
 * Publish `apps.signing-key.claimed` and resolve to the id of the attestation
 * its (awaited) chain minted, or `null` when none was produced. Never throws:
 * by the time this runs the claim code is already spent, so a bus/attestation
 * failure must not turn a successful redemption into an error response.
 */
async function emitClaimedEvent(
  nodeDid: string,
  slug: string,
  appDid: string,
  grantId: string,
  hostHint: string | null,
): Promise<string | null> {
  try {
    const result = await publish('apps.signing-key.claimed', {
      issuer: nodeDid,
      subject: appDid,
      scope: 'apps',
      payload: { slug, appDid, grantId, hostHint, context_id: appDid, context_type: 'apps.signing-key' },
    });
    return result.attestationId ?? null;
  } catch (err: unknown) {
    log.error({ err: String(err), slug, appDid }, 'Bus publish error for apps.signing-key.claimed');
    return null;
  }
}

interface ValidatedClaimBody {
  claimCode: string;
  bootstrapPublicKey: string;
  hostHint: string | null;
  expectedAppDid: string | undefined;
}

function isValidExpectedAppDid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_APP_DID_LENGTH;
}

function validateClaimBody(body: ClaimRequestBody): { ok: true; value: ValidatedClaimBody } | { ok: false; error: string } {
  if (typeof body.claimCode !== 'string' || body.claimCode.length === 0) {
    return { ok: false, error: 'claimCode is required' };
  }
  if (typeof body.bootstrapPublicKey !== 'string' || !HEX_PUBLIC_KEY_PATTERN.test(body.bootstrapPublicKey)) {
    return { ok: false, error: 'bootstrapPublicKey must be a 64-char hex-encoded Ed25519 public key' };
  }
  if (body.hostHint !== undefined && (typeof body.hostHint !== 'string' || body.hostHint.length > MAX_HOST_HINT_LENGTH)) {
    return { ok: false, error: `hostHint must be a string of at most ${MAX_HOST_HINT_LENGTH} chars` };
  }
  if (body.expectedAppDid !== undefined && !isValidExpectedAppDid(body.expectedAppDid)) {
    return { ok: false, error: `expectedAppDid must be a non-empty string of at most ${MAX_APP_DID_LENGTH} chars` };
  }
  return {
    ok: true,
    value: {
      claimCode: body.claimCode,
      bootstrapPublicKey: body.bootstrapPublicKey.toLowerCase(),
      hostHint: typeof body.hostHint === 'string' ? body.hostHint : null,
      expectedAppDid: isValidExpectedAppDid(body.expectedAppDid) ? body.expectedAppDid : undefined,
    },
  };
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  let body: ClaimRequestBody;
  try {
    body = (await request.json()) as ClaimRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const validation = validateClaimBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }
  const { claimCode, bootstrapPublicKey, hostHint, expectedAppDid } = validation.value;

  const nodeDid = getNodeSigningIdentity().senderDid;

  try {
    const claimOutcome = await claimSigningKey({ code: claimCode, bootstrapPublicKey, hostHint, expectedAppDid });
    if (claimOutcome.status !== 'ok') {
      return NextResponse.json(
        { error: errorForClaimOutcome(claimOutcome.status) },
        { status: statusForClaimOutcome(claimOutcome.status), headers: cors },
      );
    }
    const { slug, appDid, grantId } = claimOutcome;
    const attestationId = await emitClaimedEvent(nodeDid, slug, appDid, grantId, hostHint);

    const keyOutcome = await resolveSigningKeyForGrant({ grantId, appDid });
    emitSigningKeyFetchedEvent({ nodeDid, slug, appDid, grantId, outcome: keyOutcome.status, via: 'claim' });
    if (keyOutcome.status !== 'ok') {
      if (keyOutcome.status === 'wrong_purpose') {
        log.error({ slug, appDid, grantId }, 'App signing-key claim resolved a grant with an unexpected purpose — refusing');
      }
      return NextResponse.json(
        { error: errorForSigningKeyFetchOutcome(keyOutcome.status) },
        { status: statusForSigningKeyFetchOutcome(keyOutcome.status), headers: cors },
      );
    }

    return NextResponse.json(
      { appDid: keyOutcome.appDid, privateKey: keyOutcome.privateKey, publicKey: keyOutcome.publicKey, attestationId },
      { headers: cors },
    );
  } catch (error) {
    log.error({ err: String(error) }, 'App signing-key claim exchange error');
    return NextResponse.json({ error: 'Failed to redeem claim code' }, { status: 500, headers: cors });
  }
}
