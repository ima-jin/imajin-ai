/** Sign exactly the serialized bytes delivered to an app using the published kernel key. */
import { createHash, randomUUID } from 'node:crypto';
import { computeKeyKid, crypto as authCrypto } from '@imajin/auth';
import { legacyWebhookHeaders, type LegacyWebhookApp } from './kernel-webhook-legacy';

/** Append a callback path without dropping a configured base path or query string. */
export function kernelWebhookUrl(base: string, callbackPath: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${callbackPath.replace(/^\//, '')}`;
  return url.toString();
}

export function signKernelWebhook(url: string, rawBody: string, method = 'POST'): Record<string, string> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) throw new Error('AUTH_PRIVATE_KEY is required to sign kernel webhooks');
  if (!authCrypto.isValidPrivateKey(privateKey)) throw new Error('AUTH_PRIVATE_KEY is not a valid Ed25519 private key');

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const target = new URL(url);
  const bodyHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const canonical = `imajin-webhook-v1\n${timestamp}\n${nonce}\n${method.toUpperCase()}\n${target.pathname}${target.search}\n${bodyHash}`;

  return {
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
  app: LegacyWebhookApp,
): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...signKernelWebhook(url, body),
      ...legacyWebhookHeaders(app),
    },
    body,
    // A redirected path would no longer match the signature; never forward bearer headers.
    redirect: 'error',
  });
}
