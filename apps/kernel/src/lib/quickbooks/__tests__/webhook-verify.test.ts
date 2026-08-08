import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyIntuitWebhookSignature } from '../webhook-verify';

const VERIFIER_TOKEN = 'super-secret-verifier-token';
const BODY = JSON.stringify({ eventNotifications: [{ realmId: '123', dataChangeEvent: { entities: [] } }] });

function sign(body: string, token: string): string {
  return createHmac('sha256', token).update(body, 'utf8').digest('base64');
}

describe('verifyIntuitWebhookSignature (xprize #35)', () => {
  it('accepts a signature computed with the same verifier token over the same body', () => {
    expect(verifyIntuitWebhookSignature(BODY, sign(BODY, VERIFIER_TOKEN), VERIFIER_TOKEN)).toBe(true);
  });

  it('rejects a signature computed with a different verifier token', () => {
    expect(verifyIntuitWebhookSignature(BODY, sign(BODY, 'wrong-token'), VERIFIER_TOKEN)).toBe(false);
  });

  it('rejects when the body has been tampered with after signing', () => {
    const signature = sign(BODY, VERIFIER_TOKEN);
    const tampered = BODY.replace('123', '456');
    expect(verifyIntuitWebhookSignature(tampered, signature, VERIFIER_TOKEN)).toBe(false);
  });

  it('rejects a malformed (wrong-length) signature without throwing', () => {
    expect(() => verifyIntuitWebhookSignature(BODY, 'not-a-real-signature', VERIFIER_TOKEN)).not.toThrow();
    expect(verifyIntuitWebhookSignature(BODY, 'not-a-real-signature', VERIFIER_TOKEN)).toBe(false);
  });
});
