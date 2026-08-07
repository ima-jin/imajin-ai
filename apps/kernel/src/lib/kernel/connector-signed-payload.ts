/**
 * Generic HMAC-signed, stateless payload codec for connector auth flows (#1391).
 *
 * Two connector flows need the same primitive: a short-lived opaque string that
 * carries a small JSON payload the server minted, tamper-evident and expiring,
 * with no DB row behind it.
 *
 *   - authorization-code `state` (#1333) — carries the owner DID across a
 *     provider redirect that arrives without an imajin session.
 *   - device-flow ticket (#1391) — carries the owner DID + `device_code` across
 *     the browser's poll loop, so the server never has to keep pending-device
 *     state and the client never has to be trusted with an unbound device code.
 *
 * Both were about to hold a byte-identical sign/verify pair, so the primitive
 * lives here once and each flow supplies its own payload type, TTL, and error
 * prefix.
 *
 * Format: `base64url(JSON.stringify(payload)) + '.' + base64url(HMAC-SHA256)`.
 * The signing secret is `AUTH_PRIVATE_KEY`, same as every other connector
 * signature in the kernel.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Envelope fields the codec adds to every payload for replay/expiry control. */
interface Envelope {
  /** Random per-token nonce, so two tokens minted in the same ms still differ. */
  nonce: string;
  /** Issued-at epoch ms, checked against the codec's TTL on verify. */
  iat: number;
}

/** A verified payload: the caller's fields, minus the codec's envelope. */
export type SignedPayloadCodec<T extends object> = {
  /** Mint a signed token carrying `payload`. */
  sign(payload: T): string;
  /** Verify signature + TTL and return the original payload. Throws otherwise. */
  verify(token: string): T;
};

/**
 * Build a sign/verify pair scoped to one flow.
 *
 * @param errorPrefix Machine-readable prefix for thrown errors, e.g.
 *                    `'github_state'` / `'github_device'`. Callers match on it.
 * @param ttlMs       How long a minted token stays valid.
 */
export function createSignedPayloadCodec<T extends object>(
  errorPrefix: string,
  ttlMs: number,
): SignedPayloadCodec<T> {
  function secret(): string {
    const value = process.env.AUTH_PRIVATE_KEY;
    if (!value) {
      throw new Error(`${errorPrefix}: AUTH_PRIVATE_KEY is not set`);
    }
    return value;
  }

  function signBody(bodyB64: string): string {
    return createHmac('sha256', secret()).update(bodyB64).digest('base64url');
  }

  function sign(payload: T): string {
    const envelope: T & Envelope = {
      ...payload,
      nonce: randomBytes(8).toString('hex'),
      iat: Date.now(),
    };
    const bodyB64 = Buffer.from(JSON.stringify(envelope)).toString('base64url');
    return `${bodyB64}.${signBody(bodyB64)}`;
  }

  function verify(token: string): T {
    const [bodyB64, sig] = token.split('.');
    if (!bodyB64 || !sig) {
      throw new Error(`${errorPrefix}: malformed token`);
    }

    // Length-guard before timingSafeEqual: it throws (rather than returning
    // false) on a length mismatch, which would surface as a 500 instead of the
    // intended "bad signature" rejection.
    const expected = Buffer.from(signBody(bodyB64));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error(`${errorPrefix}: signature mismatch`);
    }

    const envelope = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as T & Envelope;
    if (Date.now() - envelope.iat > ttlMs) {
      throw new Error(`${errorPrefix}: expired`);
    }
    return envelope;
  }

  return { sign, verify };
}
