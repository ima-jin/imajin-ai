import { randomUUID } from 'node:crypto';
import { deriveXKeypairFromEd25519 } from '@imajin/vault-core';
import { readKeystore, resolveKeystorePath } from './keystore';
import { signBootstrapPayload } from './ed25519';
import { APP_SECRET_X_DOMAIN, canonicalizeAppSecretFetchPayload, openAppSecretEnvelope, type AppSecretFetchPayload } from './app-secret-envelope';

export interface AppVaultKeySpec {
  key: string;
  onMissing: 'fail' | 'degrade';
}

export interface LoadFromVaultOptions {
  appDid?: string;
  kernelUrl?: string;
  keystorePath?: string;
  keys: AppVaultKeySpec[];
  fetchOptions?: RequestInit;
}

export interface AppVaultCredentials {
  values: Record<string, string>;
  degraded: string[];
}

function secureKernelUrl(kernelUrl: string): URL {
  try {
    const url = new URL(kernelUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error();
    return url;
  } catch {
    throw new Error('loadFromVault: HTTPS kernel URL required (except loopback)');
  }
}

/** App-declared secrets only. Call loadAppSigningKey first to establish the local bootstrap keystore. */
export async function loadFromVault(options: LoadFromVaultOptions): Promise<AppVaultCredentials> {
  const appDid = options.appDid ?? process.env.IMAJIN_APP_DID;
  const kernelUrl = options.kernelUrl ?? process.env.IMAJIN_KERNEL_URL;
  const keys = options.keys.map((spec) => spec.key);
  if (!appDid || !kernelUrl || keys.length === 0 || keys.length > 32 || new Set(keys).size !== keys.length
    || keys.some((key) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key))
    || options.keys.some((spec) => spec.onMissing !== 'fail' && spec.onMissing !== 'degrade')) {
    throw new Error('loadFromVault: invalid configuration');
  }
  const url = secureKernelUrl(kernelUrl);
  const keystore = readKeystore(resolveKeystorePath(options.keystorePath));
  if (!keystore || !/^[0-9a-f]{64}$/i.test(keystore.privateKey)
    || !/^[0-9a-f]{64}$/i.test(keystore.publicKey)) throw new Error('loadFromVault: bootstrap keystore required');
  const recipient = deriveXKeypairFromEd25519(keystore.privateKey, APP_SECRET_X_DOMAIN);
  const values: Record<string, string> = Object.create(null);
  const degraded: string[] = [];
  for (const spec of options.keys) {
    const payload: AppSecretFetchPayload = {
      domain: 'app-self-secrets-v1', appDid, keys: [spec.key], recipientXPub: recipient.publicKey,
      nonce: randomUUID(), timestamp: Date.now(),
    };
    const signature = signBootstrapPayload(canonicalizeAppSecretFetchPayload(payload), keystore.privateKey);
    try {
      const headers = new Headers(options.fetchOptions?.headers);
      headers.set('Content-Type', 'application/json');
      const response = await fetch(new URL('/api/apps/secrets/fetch', url), {
        ...options.fetchOptions, method: 'POST', headers, redirect: 'error', cache: 'no-store',
        body: JSON.stringify({ ...payload, signature }),
      });
      if (!response.ok) throw new Error();
      const opened = openAppSecretEnvelope(await response.json(), recipient.privateKey, payload);
      if (opened.missing.length > 0) throw new Error();
      values[spec.key] = opened.values[spec.key];
    } catch {
      // Never interpolate provider errors, response text, keys, or values.
      if (spec.onMissing === 'fail') throw new Error('loadFromVault: required app secret unavailable');
      degraded.push(spec.key);
    }
  }
  return { values, degraded };
}
