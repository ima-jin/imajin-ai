/**
 * Vault seal/unseal seam for the Tripian shadow-mode demo (#1232).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * #1227 INTEGRATION POINT — this is the ONE place the demo touches the vault.
 * ─────────────────────────────────────────────────────────────────────────────
 * #1227 ("Solidify the vault: real server-side seal/unseal") delivers:
 *   - `sealSecret`/`unsealSecret` in `@imajin/vault-core`, and
 *   - server-callable, headless `set`/`get` (seal-on-set, unseal-on-get) in
 *     `apps/kernel/src/lib/vault`, with per-DID isolation.
 *
 * That capability is in-process (no HTTP self-call) by design. Since this demo
 * is an external script, it binds to the vault through the thin HTTP surface the
 * kernel is expected to expose for headless callers once #1227 lands:
 *
 *   POST {KERNEL_BASE_URL}/api/vault/seal    { did, field, plaintext } -> 200
 *   POST {KERNEL_BASE_URL}/api/vault/unseal  { did, field } -> { plaintext }
 *
 * If #1227 exposes different route names/shapes, adjust ONLY this file — the
 * walkthrough depends solely on the {@link VaultClient} interface below.
 *
 * Until #1227 is merged, run the walkthrough with DEMO_SKIP_VAULT=1 to exercise
 * the identity + consent + broker(shadow) + audit path using the traveler prefs
 * held in-memory. The vault round-trip assertion activates automatically once a
 * real VaultClient is configured (DEMO_SKIP_VAULT unset).
 */

export interface VaultClient {
  /** Seal `plaintext` for `field` under `did` (node-sealed, encrypted at rest). */
  seal(did: string, field: string, plaintext: string): Promise<void>;
  /** Unseal and return the plaintext previously sealed for `field` under `did`. */
  unseal(did: string, field: string): Promise<string>;
  /** Human-readable label for logging which backend is in use. */
  readonly label: string;
}

export interface VaultClientOptions {
  baseUrl: string;
  /** Bearer token for the authenticated demo agent. */
  token: string;
}

/** HTTP-backed vault client bound to the #1227 headless seal/unseal surface. */
class HttpVaultClient implements VaultClient {
  readonly label = 'http (#1227 seal/unseal)';

  constructor(private readonly options: Readonly<VaultClientOptions>) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.options.token}`,
    };
  }

  async seal(did: string, field: string, plaintext: string): Promise<void> {
    const res = await fetch(`${this.options.baseUrl}/api/vault/seal`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ did, field, plaintext }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`vault seal failed (${res.status}) for ${field}: ${detail}`);
    }
  }

  async unseal(did: string, field: string): Promise<string> {
    const res = await fetch(`${this.options.baseUrl}/api/vault/unseal`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ did, field }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`vault unseal failed (${res.status}) for ${field}: ${detail}`);
    }
    const data = (await res.json()) as { plaintext?: unknown };
    if (typeof data.plaintext !== 'string') {
      throw new Error(`vault unseal for ${field} returned no plaintext`);
    }
    return data.plaintext;
  }
}

/**
 * In-memory stand-in used ONLY when DEMO_SKIP_VAULT=1 (i.e. before #1227 lands).
 * It performs a real seal→unseal round-trip in memory so the walkthrough's
 * data-flow and assertions still run; it is NOT encryption and NOT a substitute
 * for the vault. The README calls this out explicitly.
 */
class InMemoryVaultClient implements VaultClient {
  readonly label = 'in-memory (DEMO_SKIP_VAULT — NOT the real vault)';
  private readonly store = new Map<string, string>();

  private static key(did: string, field: string): string {
    return `${did}\u0000${field}`;
  }

  async seal(did: string, field: string, plaintext: string): Promise<void> {
    this.store.set(InMemoryVaultClient.key(did, field), plaintext);
  }

  async unseal(did: string, field: string): Promise<string> {
    const value = this.store.get(InMemoryVaultClient.key(did, field));
    if (value === undefined) {
      throw new Error(`in-memory vault has no sealed value for ${field}`);
    }
    return value;
  }
}

/**
 * Build the vault client. Returns the real HTTP-backed client bound to #1227
 * unless DEMO_SKIP_VAULT is set, in which case the in-memory stand-in is used.
 */
export function createVaultClient(options: Readonly<VaultClientOptions>): VaultClient {
  if (process.env.DEMO_SKIP_VAULT === '1') {
    return new InMemoryVaultClient();
  }
  return new HttpVaultClient(options);
}
