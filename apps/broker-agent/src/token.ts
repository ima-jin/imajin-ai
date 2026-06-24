/**
 * App-service token lifecycle for the broker-agent.
 *
 * The broker-agent is a registered Imajin app (keyholder). It authenticates to
 * the kernel by proving possession of its Ed25519 keypair — no per-user consent
 * attestation is required. The kernel mints a short-lived (~10 min) EdDSA token
 * (typ: 'app-service+jwt') which the agent attaches as a Bearer on every API call.
 *
 * TokenProvider:
 *   - Mints a fresh token on first call.
 *   - Auto-refreshes at 80% of TTL (≈8 min for a 10-min token) via setInterval.
 *   - Exposes `invalidate()` so callers can force a refresh on unexpected 401s.
 */

import { randomBytes } from 'node:crypto';
import { signSync } from '@imajin/auth';

const TOKEN_TTL_SECONDS = 600;        // server-side TTL
const REFRESH_RATIO    = 0.8;         // refresh at 80% of TTL
const REFRESH_INTERVAL_MS = TOKEN_TTL_SECONDS * REFRESH_RATIO * 1000; // 480 000 ms

export interface TokenResponse {
  token: string;
  expiresIn: number;
  scopes: string[];
}

/**
 * Sign a service-token challenge and call POST /auth/api/apps/token/service.
 *
 * @param kernelUrl   Base URL of the kernel API (no trailing slash)
 * @param appDid      The app's registered DID
 * @param privateKey  Raw 32-byte Ed25519 seed as hex (or PKCS#8 DER hex)
 */
export async function mintAppToken(
  kernelUrl: string,
  appDid: string,
  privateKey: string
): Promise<TokenResponse> {
  const nonce     = randomBytes(16).toString('hex'); // 32 hex chars ≥ 16 required
  const timestamp = new Date().toISOString();
  const challenge = `${appDid}:${nonce}:${timestamp}`;
  const signature = signSync(challenge, privateKey);

  const res = await fetch(`${kernelUrl}/auth/api/apps/token/service`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appDid, nonce, timestamp, signature }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(`Failed to mint app service token: ${res.status} ${body.error ?? res.statusText}`);
  }

  return res.json() as Promise<TokenResponse>;
}

/**
 * Manages the broker-agent's service token lifecycle: mints on first use,
 * auto-refreshes before expiry, and supports forced invalidation on 401.
 */
export class TokenProvider {
  private readonly kernelUrl: string;
  private readonly appDid: string;
  private readonly privateKey: string;

  private cachedToken: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private mintPromise: Promise<void> | null = null;

  constructor(kernelUrl: string, appDid: string, privateKey: string) {
    this.kernelUrl  = kernelUrl.replace(/\/$/, '');
    this.appDid     = appDid;
    this.privateKey = privateKey;
  }

  /** Get the current token, minting one if necessary. */
  async getToken(): Promise<string> {
    if (!this.cachedToken) {
      // Coalesce concurrent callers onto a single mint
      if (!this.mintPromise) {
        this.mintPromise = this.refresh().finally(() => { this.mintPromise = null; });
      }
      await this.mintPromise;
    }
    return this.cachedToken!;
  }

  /** Force a token refresh on the next call (e.g. after a 401). */
  invalidate(): void {
    this.cachedToken = null;
  }

  /** Stop the auto-refresh timer (call on graceful shutdown). */
  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refresh(): Promise<void> {
    const response = await mintAppToken(this.kernelUrl, this.appDid, this.privateKey);
    this.cachedToken = response.token;

    // Schedule the next refresh at 80% of TTL
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err: unknown) => {
        console.error('[broker-agent] Token auto-refresh failed:', err);
        this.cachedToken = null; // will force a fresh mint on next call
      });
    }, REFRESH_INTERVAL_MS);
  }
}
