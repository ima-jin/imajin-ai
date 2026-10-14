import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { canonicalKernelWebhookPayload, type KernelWebhookKey } from '@imajin/auth/kernel-webhook';
import { computeKeyKid } from '../../../../packages/auth/src/key-rotation';

export const EVENTS_APP_DID = 'did:imajin:test-events-only';
export const TEST_AUTH_URL = 'https://kernel.events-test.example/auth';
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const key: KernelWebhookKey = {
  kid: computeKeyKid(publicKey), publicKey, algorithm: 'Ed25519',
  validFrom: new Date(Date.now() - 60_000).toISOString(),
};

export function discoveryResponse(): Response {
  return Response.json({ current: key.kid, keys: [key] });
}

/** Actual SDK canonical bytes, signed with a runtime-generated test-only Ed25519 key. */
export function signedWebhook(path: string, body: unknown, audience = EVENTS_APP_DID): Request {
  const url = `https://events.test${path}`;
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const canonical = canonicalKernelWebhookPayload({ audience, timestamp, nonce, method: 'POST', url, rawBody });
  return new Request(url, {
    method: 'POST', body: rawBody,
    headers: {
      'x-kernel-audience': audience,
      'x-kernel-kid': key.kid,
      'x-kernel-timestamp': timestamp,
      'x-kernel-nonce': nonce,
      'x-kernel-signature': sign(null, Buffer.from(canonical), pair.privateKey).toString('hex'),
    },
  });
}
