import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyStripeWebhookSignature, DEFAULT_TOLERANCE_SECONDS } from '../webhook-verify';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });

function signatureHeaderAt(body: string, secret: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`, 'utf8').digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

describe('verifyStripeWebhookSignature (#1785)', () => {
  it('accepts a validly-signed, fresh delivery', () => {
    const now = Date.now();
    const header = signatureHeaderAt(BODY, SECRET, Math.floor(now / 1000));

    expect(verifyStripeWebhookSignature(BODY, header, SECRET, { now })).toEqual({ ok: true });
  });

  it('accepts a header carrying multiple v1 signatures (secret rotation) if any matches', () => {
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    const validSig = createHmac('sha256', SECRET).update(`${nowSeconds}.${BODY}`, 'utf8').digest('hex');
    const header = `t=${nowSeconds},v1=deadbeef,v1=${validSig}`;

    expect(verifyStripeWebhookSignature(BODY, header, SECRET, { now })).toEqual({ ok: true });
  });

  // ── invalid ───────────────────────────────────────────────────────────────

  it('rejects a missing signature header', () => {
    expect(verifyStripeWebhookSignature(BODY, null, SECRET)).toEqual({
      ok: false,
      reason: 'missing_header',
    });
  });

  it('rejects a malformed signature header (no t= or no v1=)', () => {
    expect(verifyStripeWebhookSignature(BODY, 'not-a-real-header', SECRET)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
    expect(verifyStripeWebhookSignature(BODY, 't=12345', SECRET)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
  });

  it('rejects a signature computed with the wrong secret', () => {
    const now = Date.now();
    const header = signatureHeaderAt(BODY, 'whsec_wrong_secret', Math.floor(now / 1000));

    expect(verifyStripeWebhookSignature(BODY, header, SECRET, { now })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a signature whose body was tampered with after signing', () => {
    const now = Date.now();
    const header = signatureHeaderAt(BODY, SECRET, Math.floor(now / 1000));
    const tamperedBody = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', amount: 999999 });

    expect(verifyStripeWebhookSignature(tamperedBody, header, SECRET, { now })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a signature of the wrong length rather than throwing', () => {
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    const header = `t=${nowSeconds},v1=ab`;

    expect(verifyStripeWebhookSignature(BODY, header, SECRET, { now })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  // ── replay ────────────────────────────────────────────────────────────────

  it('rejects a genuinely-signed delivery whose timestamp is older than the tolerance window (replay)', () => {
    const now = Date.now();
    const staleTimestamp = Math.floor(now / 1000) - (DEFAULT_TOLERANCE_SECONDS + 60);
    const header = signatureHeaderAt(BODY, SECRET, staleTimestamp);

    expect(verifyStripeWebhookSignature(BODY, header, SECRET, { now })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('rejects a timestamp too far in the future (clock-skew / forged replay)', () => {
    const now = Date.now();
    const futureTimestamp = Math.floor(now / 1000) + (DEFAULT_TOLERANCE_SECONDS + 60);
    const header = signatureHeaderAt(BODY, SECRET, futureTimestamp);

    expect(verifyStripeWebhookSignature(BODY, header, SECRET, { now })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('accepts a timestamp right at the edge of the tolerance window', () => {
    const now = Date.now();
    const edgeTimestamp = Math.floor(now / 1000) - DEFAULT_TOLERANCE_SECONDS;
    const header = signatureHeaderAt(BODY, SECRET, edgeTimestamp);

    expect(verifyStripeWebhookSignature(BODY, header, SECRET, { now })).toEqual({ ok: true });
  });

  it('honours a custom tolerance window', () => {
    const now = Date.now();
    const timestamp = Math.floor(now / 1000) - 30;
    const header = signatureHeaderAt(BODY, SECRET, timestamp);

    expect(verifyStripeWebhookSignature(BODY, header, SECRET, { now, toleranceSeconds: 10 })).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
    expect(verifyStripeWebhookSignature(BODY, header, SECRET, { now, toleranceSeconds: 60 })).toEqual({ ok: true });
  });
});
