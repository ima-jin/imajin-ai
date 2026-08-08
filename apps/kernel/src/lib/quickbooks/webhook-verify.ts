/**
 * Intuit webhook signature verification (xprize #35).
 *
 * Every QuickBooks Online webhook delivery carries an `intuit-signature`
 * header: the base64-encoded HMAC-SHA256 of the *raw* request body, computed
 * with the app's Verifier Token (shown in the Intuit Developer dashboard next
 * to the client credentials). The subscriber must recompute the HMAC over the
 * unmodified body bytes and reject any request whose signature does not
 * match — see
 * https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an `intuit-signature` header against the raw request body.
 *
 * Length-guarded before `timingSafeEqual`: it throws (rather than returning
 * false) on a length mismatch, which would otherwise surface as a 500 instead
 * of the intended "bad signature" rejection.
 */
export function verifyIntuitWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  verifierToken: string,
): boolean {
  const expected = Buffer.from(createHmac('sha256', verifierToken).update(rawBody, 'utf8').digest('base64'));
  const actual = Buffer.from(signatureHeader);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
