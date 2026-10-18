/** Sign exactly the serialized bytes delivered to an app using the published kernel key. */
import { randomUUID } from 'node:crypto';
import { computeKeyKid, crypto as authCrypto } from '@imajin/auth';
import { canonicalKernelWebhookPayload } from '@imajin/auth/kernel-webhook';
import { legacyWebhookHeaders } from './kernel-webhook-legacy';
import { resolveKernelWebhookAudience, validateKernelWebhookAudience } from './kernel-webhook-recipient';

/** Append a callback path without dropping a configured base path or query string. */
export function kernelWebhookUrl(base: string, callbackPath: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${callbackPath.replace(/^\//, '')}`;
  return url.toString();
}

export function signKernelWebhook(url: string, rawBody: string, audience: string, method = 'POST'): Record<string, string> {
  validateKernelWebhookAudience(audience);
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) throw new Error('AUTH_PRIVATE_KEY is required to sign kernel webhooks');
  if (!authCrypto.isValidPrivateKey(privateKey)) throw new Error('AUTH_PRIVATE_KEY is not a valid Ed25519 private key');

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const canonical = canonicalKernelWebhookPayload({ audience, timestamp, nonce, method, url, rawBody });

  return {
    'x-kernel-audience': audience,
    'x-kernel-kid': computeKeyKid(authCrypto.getPublicKey(privateKey)),
    'x-kernel-timestamp': timestamp,
    'x-kernel-nonce': nonce,
    'x-kernel-signature': authCrypto.signSync(canonical, privateKey),
  };
}

/** No unsigned fallback: missing/invalid published key fails before making a request. */
export async function postKernelWebhook(
  url: string,
  payload: unknown,
  app: string,
): Promise<Response> {
  const audience = await resolveKernelWebhookAudience(url, { appSlug: app });
  const body = JSON.stringify(payload);
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...signKernelWebhook(url, body, audience),
      ...legacyWebhookHeaders(app),
    },
    body,
    // A redirected path would no longer match the signature; never forward bearer headers.
    redirect: 'error',
  });
}
