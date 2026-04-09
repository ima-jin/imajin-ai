import { createHmac, timingSafeEqual } from 'crypto';

function getSecret(): string {
  return (
    process.env.HMAC_SECRET ||
    process.env.SUBSCRIBE_SECRET ||
    process.env.AUTH_INTERNAL_API_KEY ||
    'dev-fallback-secret'
  );
}

/** Generate a HMAC token for email verification (includes expiry timestamp). */
export function generateVerifyToken(email: string, expiresAt: number): string {
  return createHmac('sha256', getSecret())
    .update(`${email}:verify:${expiresAt}`)
    .digest('hex');
}

/** Validate a verification token. Returns false if expired or HMAC mismatch. */
export function verifyVerifyToken(email: string, token: string, expiresAt: number): boolean {
  if (Date.now() > expiresAt) return false;
  const expected = generateVerifyToken(email, expiresAt);
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/** Generate a permanent HMAC token for unsubscribe links. */
export function generateUnsubscribeToken(email: string, list: string): string {
  return createHmac('sha256', getSecret())
    .update(`${email}:unsubscribe:${list}`)
    .digest('hex');
}

/** Validate an unsubscribe token. */
export function verifyUnsubscribeToken(email: string, list: string, token: string): boolean {
  const expected = generateUnsubscribeToken(email, list);
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/** 7 days from now as a Unix timestamp (ms). */
export function verifyTokenExpiry(): number {
  return Date.now() + 7 * 24 * 60 * 60 * 1000;
}
