import { unwrapFieldKey, unsealSecret, type DelegationWrappedKey, type VaultBlob } from '@imajin/vault-core';

export const APP_SECRET_X_DOMAIN = 'app-self-secrets-x25519-v1';

export interface AppSecretFetchPayload {
  domain: 'app-self-secrets-v1';
  appDid: string;
  keys: string[];
  recipientXPub: string;
  nonce: string;
  timestamp: number;
}

export interface AppSecretEnvelope {
  version: 1;
  senderXPub: string;
  wrappedKey: DelegationWrappedKey;
  sealed: VaultBlob;
}

export interface AppSecretPayload {
  domain: 'app-self-secrets-v1';
  appDid: string;
  nonce: string;
  keys: string[];
  values: Record<string, string>;
  missing: string[];
}

/** Fixed alphabetical field order matches the kernel's canonicalize(). */
export function canonicalizeAppSecretFetchPayload(payload: AppSecretFetchPayload): string {
  return JSON.stringify({
    appDid: payload.appDid, domain: payload.domain, keys: payload.keys,
    nonce: payload.nonce, recipientXPub: payload.recipientXPub, timestamp: payload.timestamp,
  });
}

/** Never expose underlying crypto/JSON errors or untrusted server error text. */
export function openAppSecretEnvelope(
  envelope: AppSecretEnvelope, recipientXPriv: string, request: AppSecretFetchPayload,
): AppSecretPayload {
  try {
    if (envelope.version !== 1) throw new Error();
    const key = unwrapFieldKey(envelope.wrappedKey, envelope.senderXPub, recipientXPriv);
    let payload: AppSecretPayload;
    try {
      payload = JSON.parse(unsealSecret(envelope.sealed, key));
    } finally {
      key.fill(0);
    }
    if (payload.domain !== request.domain || payload.appDid !== request.appDid || payload.nonce !== request.nonce
      || JSON.stringify(payload.keys) !== JSON.stringify(request.keys)
      || !payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)
      || !Array.isArray(payload.missing)) throw new Error();
    const actual = [...Object.keys(payload.values), ...payload.missing];
    if (actual.length !== request.keys.length || new Set(actual).size !== actual.length
      || actual.some((name) => !request.keys.includes(name))
      || Object.values(payload.values).some((value) => typeof value !== 'string')) throw new Error();
    return payload;
  } catch {
    throw new Error('loadFromVault: invalid sealed response');
  }
}
