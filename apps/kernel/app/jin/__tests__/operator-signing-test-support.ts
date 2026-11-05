import { webcrypto } from 'node:crypto';
import { vi } from 'vitest';

/** Secure-context browser crypto, bridging jsdom's VM byte arrays to native WebCrypto. */
export async function loadOperatorSigner() {
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, key) {
      if (key === 'digest') return (algorithm: string, bytes: Uint8Array) => target.digest(algorithm, Buffer.from(bytes));
      const method = Reflect.get(target, key, target);
      return typeof method === 'function' ? method.bind(target) : method;
    },
  });
  vi.stubGlobal('crypto', {
    subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID: webcrypto.randomUUID.bind(webcrypto),
  });
  // Cold module loading belongs to setup, not the DOM assertion or per-test timeout.
  await Promise.all([import('@noble/ed25519'), import('@noble/hashes/sha2.js')]);
}
