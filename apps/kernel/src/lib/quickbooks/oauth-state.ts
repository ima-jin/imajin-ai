/**
 * Signed, stateless OAuth `state` token for the QuickBooks connect flow (#1210).
 *
 * The callback arrives from Intuit without an imajin session, so `state` must
 * itself carry the owner DID — HMAC-signed with a server secret + short TTL so
 * it can't be forged or replayed. No DB/state table needed.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret(): string {
  const secret = process.env.AUTH_PRIVATE_KEY;
  if (!secret) {
    throw new Error('quickbooks_state: AUTH_PRIVATE_KEY is not set');
  }
  return secret;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', stateSecret()).update(payloadB64).digest('base64url');
}

interface StatePayload {
  did: string;
  nonce: string;
  iat: number;
}

/** Mint a signed state token binding the owner DID. */
export function signState(ownerDid: string): string {
  const payload: StatePayload = { did: ownerDid, nonce: randomBytes(8).toString('hex'), iat: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** Verify a state token and return the bound DID. Throws on tamper/expiry. */
export function verifyState(state: string): string {
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) {
    throw new Error('quickbooks_state: malformed state');
  }

  const expected = Buffer.from(sign(payloadB64));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('quickbooks_state: signature mismatch');
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as StatePayload;
  if (Date.now() - payload.iat > STATE_TTL_MS) {
    throw new Error('quickbooks_state: expired');
  }
  return payload.did;
}
