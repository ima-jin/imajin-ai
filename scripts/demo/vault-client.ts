/**
 * Vault seal/unseal for the Tripian shadow-mode demo (#1232), backed by #1227's
 * real cipher.
 *
 * #1227 exposes its seal/unseal capability IN-PROCESS only (`sealAndStore` /
 * `loadAndUnseal` in `apps/kernel/src/lib/vault`) — there is no HTTP unseal
 * endpoint by design, and that lib's transitive imports (`@imajin/vault-core`,
 * `@imajin/auth`) resolve to built `dist/` bundles that a standalone `tsx`
 * script cannot load. So the demo binds directly to #1227's real cipher
 * primitives — `sealSecret` / `unsealSecret` in `@imajin/vault-core` — which
 * depend only on `node:crypto` and load cleanly by relative path.
 *
 * The seal key is derived by #1227's shared `deriveSealKey` (the single source
 * of truth, also used by `apps/kernel/src/lib/vault/sealing.ts`), so there is no
 * duplicated derivation to keep in sync.
 *
 * This gives a genuine AES-256-GCM seal -> unseal round-trip using #1227's real
 * cipher and node key. The full FileVaultRepository persistence + signed-entry
 * integrity chain (which pulls in workspace-only packages) is covered by
 * #1227's own `apps/kernel/src/lib/vault/__tests__/roundtrip.test.ts`.
 */

// Real #1227 cipher + key derivation — relative import avoids the workspace
// package export map (a standalone tsx script can't resolve the built dist).
import { sealSecret, unsealSecret, deriveSealKey } from '../../packages/vault-core/src/seal.js';

interface VaultBlob {
  encrypted: string;
  nonce: string;
}

export interface VaultClient {
  /** Seal `plaintext` for `field` under `did` using #1227's real cipher + node key. */
  seal(did: string, field: string, plaintext: string): Promise<void>;
  /** Unseal and return the plaintext previously sealed for `field` under `did`. */
  unseal(did: string, field: string): Promise<string>;
  /** Human-readable label for logging which backend is in use. */
  readonly label: string;
}

/** Namespace a vault field by the subject DID (#1227 stores under one node identity). */
function nsField(did: string, field: string): string {
  return `${did}:${field}`;
}

/**
 * Seals with #1227's real cipher under the node seal key and holds the resulting
 * ciphertext for the duration of the run, unsealing it back on read. The stored
 * value is genuine AES-256-GCM ciphertext (not plaintext), so the round-trip
 * proves the real seal/unseal path.
 */
class VaultCryptoClient implements VaultClient {
  readonly label = 'in-process (#1227 real seal/unseal cipher)';
  private readonly key = deriveSealKey(process.env.AUTH_PRIVATE_KEY);
  private readonly store = new Map<string, VaultBlob>();

  async seal(did: string, field: string, plaintext: string): Promise<void> {
    this.store.set(nsField(did, field), sealSecret(plaintext, this.key));
  }

  async unseal(did: string, field: string): Promise<string> {
    const blob = this.store.get(nsField(did, field));
    if (blob === undefined) {
      throw new Error(`vault has no sealed value for '${field}' under ${did}`);
    }
    return unsealSecret(blob, this.key);
  }
}

export function createVaultClient(): VaultClient {
  return new VaultCryptoClient();
}
